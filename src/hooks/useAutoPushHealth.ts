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
}

/** "0 de 8 subidos — bloqueados: 8, duplicados: 0, errores: 0. Primeros motivos: …" */
const RE_BLOQUEADOS = /bloqueados:\s*(\d+)/i;

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

/** Decide si la última corrida dejó pedidos sin subir. Puro, para poder probarlo. */
export function evaluarCorrida(
  fila: { status?: string | null; error_message?: string | null; created_at?: string | null } | null,
): AutoPushHealth {
  const vacio: AutoPushHealth = { bloqueado: false, cuantos: 0, motivos: [], cuando: null };
  if (!fila) return vacio;
  const cuando = fila.created_at ? new Date(fila.created_at) : null;
  const msg = String(fila.error_message ?? '');
  const m = msg.match(RE_BLOQUEADOS);
  const cuantos = m ? Number(m[1]) : 0;
  // `status` solo no alcanza: el robot marca 'warn' también cuando no había nada
  // que hacer. Lo que define la falla es que haya pedidos bloqueados.
  if (!cuantos) return { ...vacio, cuando };
  return { bloqueado: true, cuantos, motivos: leerMotivos(msg), cuando };
}

export function useAutoPushHealth(storeId: string | null) {
  return useQuery<AutoPushHealth>({
    queryKey: ['auto_push_health', storeId ?? 'none'],
    enabled: Boolean(storeId),
    // Se refresca al ritmo del cron (15 min); no tiene sentido preguntar más.
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sync_logs')
        .select('status, error_message, created_at')
        .eq('source', 'shopify-auto-push')
        .eq('store_id', storeId as string)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      // Si no se puede leer, se calla: un aviso que no se puede calcular NO
      // debe convertirse en un cartel rojo falso.
      if (error) return { bloqueado: false, cuantos: 0, motivos: [], cuando: null };
      return evaluarCorrida(data);
    },
  });
}
