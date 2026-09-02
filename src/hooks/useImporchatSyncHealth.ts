import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// Salud del sync de ImporChat (el que trae lo que el cliente nos escribe).
//
// Ahora que la MAYORÍA del tráfico es inbound, si este sync se cae la operación
// se queda ciega — y hasta hoy no había NADA que lo mostrara: `importchat-sync`
// escribía `sync_logs` (source='importchat-sync', running/warn/error, token
// vencido, corridas parciales) y nadie lo consumía. Es exactamente el fallo del
// "wallet muerto en verde": el dueño se enteraba por los clientes que no
// contestó, no por Guardian. Este hook cierra ese hueco.
//
// Mide DOS cosas separadas, porque son preguntas distintas:
//   1. ¿El sync corrió y guardó?  → status (mismo criterio que el wallet).
//   2. ¿La llave de 7 días está por vencer?  → tokenHorasRestantes. Si vence y no
//      se renueva, el inbound se apaga aunque el cron "corra".

export type ImporchatSyncStatus = 'fresh' | 'stale' | 'critical' | 'failing' | 'never';

export interface ImporchatSyncHealth {
  /** Última CORRIDA del sync (sync_logs source='importchat-sync'). */
  lastSyncAt: Date | null;
  hoursSinceSync: number | null;
  /** Mensaje de error de la última corrida, si falló. Para el tooltip. */
  lastErrorMessage: string | null;
  status: ImporchatSyncStatus;
  /** Cuántas de las últimas corridas arrancaron y nunca cerraron, y cuántas se
   *  miraron. Con `colgadas > 0` el badge dice "se está colgando" en vez de
   *  "falla al sincronizar": son problemas distintos y se buscan en lugares
   *  distintos (uno deja error en el log, el otro no deja NADA). */
  colgadas: number;
  corridasVistas: number;
  /** Cuándo vence la llave de ImporChat (store_importchat_config). Best-effort:
   *  si RLS no deja leerla, queda null y el badge solo muestra el estado del sync. */
  tokenExpiraAt: Date | null;
  /** Horas hasta que venza la llave. Negativo = ya vencida. null = no se pudo leer. */
  tokenHorasRestantes: number | null;
}

const FRESH_HOURS = 3;   // el cron corre ~cada 30 min; 3h sin correr ya es raro
const STALE_HOURS = 12;  // 12h = claramente caído

/**
 * Cuánto puede durar una corrida antes de considerarla COLGADA.
 *
 * `importchat-sync` escribe su fila en `sync_logs` con `status='running'` al
 * arrancar y la cierra al terminar. Si se queda sin presupuesto a mitad —lo que
 * le pasa bajando el XLSX— la fila **se queda en `running` para siempre**: nunca
 * pasa a `error`. El cron corre cada 30 min y la función tiene un presupuesto de
 * segundos, así que 10 minutos es holgado.
 */
export const GRACIA_RUNNING_MIN = 10;

/** Una corrida, para decidir si el sync está sano. `edadMin` = minutos desde que arrancó. */
export interface CorridaSync {
  status: string | null;
  edadMin: number;
}

/** ¿Esta corrida arrancó y nunca cerró? */
export function estaColgada(c: CorridaSync): boolean {
  return c.status === 'running' && c.edadMin > GRACIA_RUNNING_MIN;
}

/**
 * Pura y exportada para testear. Una corrida FALLIDA manda sobre la frescura:
 * da igual que haya sido hace 5 min si no guardó nada (lección del wallet).
 *
 * ── ⛔ Y una COLGADA también (medido en producción, 28-ago-2026) ─────────────
 * Este hook contemplaba `'error'` y nada más. Pero `importchat-sync` no falla
 * con error: se queda **colgado en `running`**, y esa fila no cambia nunca. Con
 * las últimas 12 corridas de Ecuador delante —7 colgadas, 4 de ellas SEGUIDAS,
 * o sea dos horas sin dato nuevo del chat— la última fila era un `success` de
 * hace 4 minutos y este cálculo devolvía **`fresh`**: verde.
 *
 * Es el mismo fallo del wallet que el comentario de arriba dice haber cerrado,
 * con otra cara: se arregló "corrió ≠ funcionó" para el error y no para el
 * cuelgue. Y duele el doble, porque de este dato cuelgan la rayita verde, "Te
 * respondió" y todo el ciclo de contacto en Confirmar y Seguimiento.
 *
 * @param corridas las últimas N corridas (la más nueva primero). Opcional: sin
 *   ellas el cálculo es el de antes, así que los llamadores viejos no cambian.
 */
export function deriveStatus(
  hoursSinceRun: number | null,
  lastRunStatus?: string | null,
  corridas?: CorridaSync[],
): ImporchatSyncStatus {
  if (hoursSinceRun === null) return 'never';
  if (lastRunStatus === 'error') return 'failing';
  // Una sola colgada ya es una ventana de 30 min sin dato; dos, un problema que
  // no se va a arreglar solo. Las dos se gritan igual: la asesora no puede
  // distinguir "el chat está tranquilo" de "el chat no está llegando".
  if (corridas?.some(estaColgada)) return 'failing';
  if (hoursSinceRun < FRESH_HOURS) return 'fresh';
  if (hoursSinceRun < STALE_HOURS) return 'stale';
  return 'critical';
}

// `storeId` scopea a la tienda activa (un admin ve todas por RLS; sin esto vería
// la corrida más reciente de CUALQUIER tienda y el badge mentiría "fresh").
/**
 * `source` = el sync que hay que vigilar en esta tienda: `importchat-sync` en
 * Ecuador, `chateapro-sync` en Colombia. Se parametriza porque el badge no
 * puede quedarse mudo en el canal nuevo: si el sync se cuelga, la bandeja
 * «Escribieron» se queda quieta y la pantalla se ve igual de tranquila que si
 * de verdad no hubiera nadie esperando. Ese silencio ya costó 39 clientes sin
 * contestar, 22 de ellos por más de un día.
 */
export function useImporchatSyncHealth(storeId?: string | null, source = 'importchat-sync') {
  return useQuery<ImporchatSyncHealth>({
    queryKey: ['importchat_sync_health', storeId ?? 'all', source],
    queryFn: async () => {
      // 1) Las últimas corridas — la fuente de verdad de "¿corrió y guardó?".
      //
      // ⛔ Eran `limit(1)`. Con una sola fila no se puede ver un CUELGUE: la
      // corrida colgada queda en `running` para siempre y la siguiente, que sí
      // termina, tapa el problema. Con 6 filas se cubren ~3 horas de cron.
      let runQ = supabase
        .from('sync_logs')
        .select('created_at, status, error_message')
        .eq('source', source)
        .order('created_at', { ascending: false })
        .limit(6);
      if (storeId) runQ = runQ.eq('store_id', storeId);
      // 2) Vencimiento de la llave vía RPC (SECURITY DEFINER): el browser NO puede
      //    leer store_importchat_config (RLS: tiene la llave secreta), así que la
      //    lectura directa daba siempre null y el aviso "Llave vence en Nh" era
      //    código muerto (hallazgo D1). La RPC devuelve SOLO las horas. Best-effort:
      //    si la migración no corrió, queda null y el badge sigue vivo con el sync.
      const [runRes, tokRes] = await Promise.all([
        runQ,
        // La llave de Chatea Pro es permanente: no hay vencimiento que avisar,
        // y preguntar por él devolvería siempre null.
        storeId && source === 'importchat-sync'
          // `as never`: types.ts (autogenerado) todavía no conoce esta RPC (la
          // migración es nueva). Se casan los ARGS, NO se desbindea supabase.rpc
          // (perder `this` rompe la llamada — ver rpc_supabase_binding_pattern).
          ? supabase.rpc('importchat_token_horas' as never, { p_store_id: storeId } as never)
          : Promise.resolve({ data: null, error: null }),
      ]);
      // El run query SÍ es crítico: si falla, el badge se oculta (isError).
      if (runRes.error) throw runRes.error;

      const filas = ((runRes.data ?? []) as Array<{ created_at: string; status?: string | null; error_message?: string | null }>);
      const ahora = Date.now();
      const corridas: CorridaSync[] = filas.map((f) => ({
        status: f.status ?? null,
        edadMin: (ahora - new Date(f.created_at).getTime()) / 60_000,
      }));

      // ⛔ La frescura se mide contra la última corrida que TERMINÓ, no contra la
      // última que arrancó. Una que arrancó hace 1 min y sigue viva no prueba que
      // el dato esté fresco — prueba que se está intentando. Si todas las que hay
      // están corriendo, se usa la más nueva y el cuelgue lo detecta `deriveStatus`.
      const terminada = filas.find((f) => f.status !== 'running') ?? filas[0] ?? null;
      const tsRun = terminada?.created_at ? new Date(terminada.created_at) : null;
      const hoursSinceRun = tsRun ? (ahora - tsRun.getTime()) / 3_600_000 : null;
      const lastRunStatus = terminada?.status ?? null;
      const colgadas = corridas.filter(estaColgada).length;
      // ⛔ El mensaje del CUELGUE lo arma el badge, no acá: "la última corrida
      // falló: <esto>" sería mentira (la última pudo terminar bien; las que se
      // colgaron son las de antes). Acá solo viaja el conteo.
      const lastErrorMessage = terminada?.error_message ?? null;

      const tokRaw = !tokRes.error && tokRes.data != null ? Number(tokRes.data) : null;
      const tokenHorasRestantes = tokRaw != null && Number.isFinite(tokRaw) ? tokRaw : null;
      const tokenExpiraAt = tokenHorasRestantes != null
        ? new Date(Date.now() + tokenHorasRestantes * 3_600_000)
        : null;

      return {
        lastSyncAt: tsRun,
        hoursSinceSync: hoursSinceRun,
        lastErrorMessage,
        status: deriveStatus(hoursSinceRun, lastRunStatus, corridas),
        colgadas,
        corridasVistas: corridas.length,
        tokenExpiraAt,
        tokenHorasRestantes,
      };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}
