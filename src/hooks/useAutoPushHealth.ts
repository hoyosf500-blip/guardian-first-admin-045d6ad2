import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * ¿El robot que sube pedidos de Shopify a Dropi está LOGRANDO subirlos?
 *
 * Misma lección que `useWalletSyncHealth`, en otro subsistema: **"corrió" y
 * "funcionó" son dos preguntas distintas.** `shopify-auto-push` corre cada 15
 * minutos y deja fila en `sync_logs`; cuando todos los candidatos quedan
 * bloqueados escribe `status='warn'` y sigue de largo.
 *
 * Nadie leía esas filas. Medido el 2026-08-13 en producción: **386 corridas
 * bloqueadas desde el 6 de agosto — 8 días** con pedidos de clientes reales que
 * nunca llegaron a Dropi (9 en la última semana de Ecuador, 6 del mismo día).
 * El único rastro del motivo vivía en `sync_logs.error_message`, que ninguna
 * pantalla abría, así que la cola de anti-fuga se veía llena sin explicación.
 *
 * Esto NO mira la hora: una corrida reciente que bloqueó todo es peor que una
 * vieja que subió todo. Mira el RESULTADO.
 */

export interface AutoPushHealth {
  /** Hay pedidos que el robot no pudo subir en su última corrida. */
  bloqueado: boolean;
  /** Cuántos quedaron trabados (0 si no se pudo leer del mensaje). */
  cuantos: number;
  /** Motivos textuales tal como los reportó el robot, ya recortados. */
  motivos: string[];
  /** Cuándo corrió por última vez. */
  cuando: Date | null;
  /**
   * El robot DEJÓ DE REPORTAR: hace más de 3 ciclos que no escribe, o nunca
   * escribió, teniéndolo encendido.
   *
   * Este campo existe porque el hook cometía el error que su propio comentario
   * de arriba denuncia. Preguntaba "¿la última corrida bloqueó algo?" y no
   * "¿hubo corrida?" — y sin fila devolvía `bloqueado:false`, o sea VERDE.
   * `shopify-auto-push` escribe en `sync_logs` recién DESPUÉS del bucle de
   * pushes, así que una corrida que moría a mitad (por wall clock del edge, o
   * porque `getShopifyAccessToken` tiraba 401) no dejaba NADA — y el panel leía
   * la fila de la corrida anterior y decía que todo iba bien.
   *
   * Es exactamente la forma de `nightly_starvaba_tiendas` y de
   * `wallet_cron_fallaba_en_verde`: **la AUSENCIA de noticias no es una buena
   * noticia.** Un robot mudo es peor que uno que reporta pedidos trabados,
   * porque el trabado por lo menos se ve.
   */
  mudo: boolean;
}

/** 3 ciclos del cron de 15 min. Uno solo daría falsos positivos por una corrida
 *  que se atrasó; tres seguidos ya no es mala suerte. */
export const MAX_SILENCIO_MS = 45 * 60 * 1000;

/** "0 de 8 subidos — bloqueados: 8, duplicados: 0, errores: 0. Primeros motivos: …" */
const RE_BLOQUEADOS = /bloqueados:\s*(\d+)/i;
/** Los fallos de red/infra NO son pedidos "bloqueados", pero también son pedidos
 *  que no llegaron a Dropi. Antes el mensaje de esa rama ni siquiera escribía la
 *  palabra `bloqueados:`, así que el panel leía 0 y se quedaba en verde. */
const RE_ERRORES = /errores:\s*(\d+)/i;
/** La corrida se cortó por presupuesto de pared y dejó candidatos sin intentar. */
const RE_SIN_INTENTAR = /(\d+)\s+sin intentar/i;

/** Parte los motivos que el robot concatena con " | " y les quita el prefijo
 *  técnico `#7472697999585→error: `, que a la asesora no le dice nada. */
export function leerMotivos(mensaje: string): string[] {
  const i = mensaje.indexOf('Primeros motivos:');
  if (i < 0) return [];
  return mensaje
    .slice(i + 'Primeros motivos:'.length)
    .split('|')
    .map((m) => m.replace(/^\s*#\d+\s*→\s*(error:)?\s*/i, '').trim())
    .filter(Boolean);
}

/**
 * Decide si la última corrida dejó pedidos sin subir Y si el robot sigue vivo.
 * Puro, para poder probarlo.
 *
 * @param robotEncendido si el auto-envío está apagado para esta tienda, el
 *   silencio es lo esperado y NO se reporta como mudo. Sin este dato se
 *   asume encendido: preferimos un aviso de más a un robot muerto en silencio.
 */
export function evaluarCorrida(
  fila: { status?: string | null; error_message?: string | null; created_at?: string | null } | null,
  opts: { ahoraMs?: number; robotEncendido?: boolean } = {},
): AutoPushHealth {
  const { ahoraMs = Date.now(), robotEncendido = true } = opts;
  const vacio: AutoPushHealth = { bloqueado: false, cuantos: 0, motivos: [], cuando: null, mudo: false };

  // Sin ninguna corrida registrada: si el robot está encendido, eso ES la falla.
  if (!fila) return { ...vacio, mudo: robotEncendido };

  const cuando = fila.created_at ? new Date(fila.created_at) : null;
  const edadMs = cuando && Number.isFinite(cuando.getTime()) ? ahoraMs - cuando.getTime() : null;
  const mudo = robotEncendido && (edadMs === null || edadMs > MAX_SILENCIO_MS);

  const msg = String(fila.error_message ?? '');
  const bloqueados = Number(msg.match(RE_BLOQUEADOS)?.[1] ?? 0);
  const errores = Number(msg.match(RE_ERRORES)?.[1] ?? 0);
  const sinIntentar = Number(msg.match(RE_SIN_INTENTAR)?.[1] ?? 0);
  // Las tres son la misma cosa para el dueño: pedidos de clientes reales que NO
  // llegaron a Dropi. Separarlas solo servía para que dos de las tres no se vieran.
  const cuantos = bloqueados + errores + sinIntentar;

  // `status` solo no alcanza: el robot marca 'warn' también cuando no había nada
  // que hacer. Lo que define la falla es que haya pedidos sin subir.
  if (!cuantos) return { ...vacio, cuando, mudo };
  return { bloqueado: true, cuantos, motivos: leerMotivos(msg), cuando, mudo };
}

export function useAutoPushHealth(storeId: string | null) {
  return useQuery<AutoPushHealth>({
    queryKey: ['auto_push_health', storeId ?? 'none'],
    enabled: Boolean(storeId),
    // Se refresca al ritmo del cron (15 min); no tiene sentido preguntar más.
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const mudoImposibleDeSaber: AutoPushHealth = {
        bloqueado: false, cuantos: 0, motivos: [], cuando: null, mudo: false,
      };
      // Se pregunta si el robot está ENCENDIDO para esta tienda antes de acusarlo
      // de mudo: con `auto_push_enabled=false` no correr es lo correcto, y un
      // cartel rojo permanente en 5 de 6 tiendas entrena a ignorarlo.
      const [cfg, log] = await Promise.all([
        supabase
          .from('store_shopify_config')
          .select('auto_push_enabled')
          .eq('store_id', storeId as string)
          .maybeSingle(),
        supabase
          .from('sync_logs')
          .select('status, error_message, created_at')
          .eq('source', 'shopify-auto-push')
          .eq('store_id', storeId as string)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      // Si no se puede leer, se calla: un aviso que no se puede calcular NO
      // debe convertirse en un cartel rojo falso.
      if (log.error) return mudoImposibleDeSaber;
      // Si falló SOLO la config, se evalúa igual asumiendo encendido — perder el
      // aviso por no poder leer un booleano sería el mismo error de siempre.
      const robotEncendido = cfg.error ? true : cfg.data?.auto_push_enabled !== false;
      return evaluarCorrida(log.data, { robotEncendido });
    },
  });
}
