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
  /** Cuándo vence la llave de ImporChat (store_importchat_config). Best-effort:
   *  si RLS no deja leerla, queda null y el badge solo muestra el estado del sync. */
  tokenExpiraAt: Date | null;
  /** Horas hasta que venza la llave. Negativo = ya vencida. null = no se pudo leer. */
  tokenHorasRestantes: number | null;
}

const FRESH_HOURS = 3;   // el cron corre ~cada 30 min; 3h sin correr ya es raro
const STALE_HOURS = 12;  // 12h = claramente caído

// Pura y exportada para testear. Una corrida FALLIDA manda sobre la frescura:
// da igual que haya sido hace 5 min si no guardó nada (lección del wallet).
export function deriveStatus(
  hoursSinceRun: number | null,
  lastRunStatus?: string | null,
): ImporchatSyncStatus {
  if (hoursSinceRun === null) return 'never';
  if (lastRunStatus === 'error') return 'failing';
  if (hoursSinceRun < FRESH_HOURS) return 'fresh';
  if (hoursSinceRun < STALE_HOURS) return 'stale';
  return 'critical';
}

// `storeId` scopea a la tienda activa (un admin ve todas por RLS; sin esto vería
// la corrida más reciente de CUALQUIER tienda y el badge mentiría "fresh").
export function useImporchatSyncHealth(storeId?: string | null) {
  return useQuery<ImporchatSyncHealth>({
    queryKey: ['importchat_sync_health', storeId ?? 'all'],
    queryFn: async () => {
      // 1) Última corrida — la fuente de verdad de "¿corrió y guardó?".
      let runQ = supabase
        .from('sync_logs')
        .select('created_at, status, error_message')
        .eq('source', 'importchat-sync')
        .order('created_at', { ascending: false })
        .limit(1);
      // 2) Vencimiento de la llave (best-effort: store_importchat_config puede ser
      //    owner-only; si falla, el badge sigue vivo con solo el estado del sync).
      let tokQ = supabase
        .from('store_importchat_config')
        .select('token_expira_at')
        .limit(1);
      if (storeId) {
        runQ = runQ.eq('store_id', storeId);
        tokQ = tokQ.eq('store_id', storeId);
      }
      const [runRes, tokRes] = await Promise.all([runQ.maybeSingle(), tokQ.maybeSingle()]);
      // El run query SÍ es crítico: si falla, el badge se oculta (isError).
      if (runRes.error) throw runRes.error;

      const tsRun = runRes.data?.created_at ? new Date(runRes.data.created_at) : null;
      const hoursSinceRun = tsRun ? (Date.now() - tsRun.getTime()) / 3_600_000 : null;
      const lastRunStatus = (runRes.data as { status?: string } | null)?.status ?? null;
      const lastErrorMessage = (runRes.data as { error_message?: string } | null)?.error_message ?? null;

      const tokRaw = !tokRes.error ? (tokRes.data as { token_expira_at?: string } | null)?.token_expira_at : null;
      const tokenExpiraAt = tokRaw ? new Date(tokRaw) : null;
      const tokenHorasRestantes = tokenExpiraAt
        ? (tokenExpiraAt.getTime() - Date.now()) / 3_600_000
        : null;

      return {
        lastSyncAt: tsRun,
        hoursSinceSync: hoursSinceRun,
        lastErrorMessage,
        status: deriveStatus(hoursSinceRun, lastRunStatus),
        tokenExpiraAt,
        tokenHorasRestantes,
      };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}
