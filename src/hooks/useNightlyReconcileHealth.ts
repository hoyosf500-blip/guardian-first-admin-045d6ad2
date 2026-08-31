import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';

// Salud de la VERIFICACIÓN NOCTURNA contra Dropi (dropi-nightly-reconcile, 3am
// UTC). Es la señal que le dice al dueño "no tenés que comparar contra Dropi a
// mano: anoche se verificó solo". Complementa (no reemplaza) a
// useOrdersSyncHealth, que mide la frescura del cron de 5 min: el cron trae
// CAMBIOS; el nightly detecta lo que el cron no puede ver (pedidos BORRADOS en
// Dropi y divergencias viejas).
//
// La clave es `deleted_check_complete` (migration 20260703190000):
//   true  → el barrido por FECHA DE CREADO vino completo: Guardian quedó
//           verificado contra Dropi esa noche.
//   false → fail-safe: Dropi throttleó y NO se pudo verificar. `orphan_cancelled=0`
//           esa noche NO significa "todo limpio" — significa "a ciegas". Antes
//           este estado era invisible (el mismo punto ciego del cron zombie).
//   null  → no hubo candidatos que verificar (nada sospechoso) o fila vieja
//           pre-migration. Se trata como verificado.
//
// RLS: SELECT solo admin global u owner/supervisor de la tienda. Sin permiso la
// query devuelve [] → 'hidden' → el badge se oculta (igual que OrdersSyncBadge).

export type NightlyStatus = 'verified' | 'unverified' | 'stale' | 'error' | 'hidden';

export interface NightlyReconcileHealth {
  status: NightlyStatus;
  /** Última corrida (cualquier resultado). */
  lastRunAt: Date | null;
  /** Última corrida VERIFICADA (complete=true o null sin error). */
  lastVerifiedAt: Date | null;
  /** Noches consecutivas (desde la más reciente) sin poder verificar. */
  consecutiveUnverified: number;
  /** Pedidos cancelados en la última corrida (huérfanos + borrados en Dropi). */
  lastCancelled: number;
  /** Divergencias corregidas en la última corrida. */
  lastApplied: number;
  lastErrorMessage: string | null;
}

export interface NightlyRow {
  created_at: string;
  divergent_count: number;
  applied_count: number;
  orphan_cancelled: number;
  deleted_check_complete: boolean | null;
  error_message: string | null;
}

// ⛔ NO es "cada 24 h + gracia". El nightly va POR TURNOS desde el 18-ago-2026:
// tiene un presupuesto global de 110 s, hace las tiendas que le entran y guarda
// un cursor para que la postergada de hoy sea la PRIMERA de mañana. Con 6
// tiendas activas entran ~4 por noche, así que a una tienda le toca cada 1,5–2
// noches: entre 36 y 48 h SIN QUE NADA ESTÉ MAL.
//
// El umbral viejo (27 h) se escribió ANTES de que existiera esa rotación, y
// pintaba de rojo lo normal. Medido el 31-ago-2026 a las 06:23 UTC: el nightly
// había corrido a las 03:17 sobre 4 tiendas, Colombia entre ellas y sin
// divergencias; a Ecuador no le tocó turno, su última verificación quedó en
// 27,1 h y el badge dijo «Verificación vs Dropi caída». Rojo por SEIS MINUTOS,
// con la función sana y el turno de Ecuador agendado para esa misma noche.
const RUN_STALE_HOURS = 52; // 2 noches completas de rotación + 4 h de gracia

/** Deriva el estado a partir de las últimas corridas (desc). PURA y testeable. */
export function deriveNightlyStatus(
  rows: NightlyRow[],
  now: number = Date.now(),
): NightlyReconcileHealth {
  if (!rows || rows.length === 0) {
    return {
      status: 'hidden', lastRunAt: null, lastVerifiedAt: null,
      consecutiveUnverified: 0, lastCancelled: 0, lastApplied: 0, lastErrorMessage: null,
    };
  }

  const last = rows[0];
  const lastRunAt = new Date(last.created_at);
  const ageHrs = (now - lastRunAt.getTime()) / 3_600_000;

  const isVerified = (r: NightlyRow) => !r.error_message && r.deleted_check_complete !== false;
  const lastVerified = rows.find(isVerified);

  let consecutiveUnverified = 0;
  for (const r of rows) {
    if (isVerified(r)) break;
    consecutiveUnverified++;
  }

  // ⛔ 'stale' NO es 'error', y la diferencia importa. Con las filas de ESTA
  // tienda es IMPOSIBLE distinguir "el trabajo nocturno murió" de "corrió y no
  // le tocó turno a esta tienda": una tienda postergada por presupuesto no deja
  // ninguna fila. Decir «caída» afirma una causa que nadie midió — el mismo
  // vicio que este proyecto viene corrigiendo en todos lados. 'stale' dice lo
  // único que sí se sabe: hace cuánto que esta tienda no se contrasta.
  //
  // Un `error_message` SÍ es una falla medida, y manda sobre la antigüedad:
  // que haya fallado hace tres días no lo vuelve un problema de turnos.
  let status: NightlyStatus;
  if (last.error_message) status = 'error';
  else if (ageHrs > RUN_STALE_HOURS) status = 'stale';
  else if (last.deleted_check_complete === false) status = 'unverified';
  else status = 'verified';

  return {
    status,
    lastRunAt,
    lastVerifiedAt: lastVerified ? new Date(lastVerified.created_at) : null,
    consecutiveUnverified,
    lastCancelled: last.orphan_cancelled,
    lastApplied: last.applied_count,
    lastErrorMessage: last.error_message,
  };
}

export function useNightlyReconcileHealth(storeId?: string | null) {
  const activeStoreId = useActiveStoreId();
  const sid = storeId ?? activeStoreId;
  return useQuery<NightlyReconcileHealth>({
    queryKey: ['nightly-reconcile-health', sid ?? 'all'],
    enabled: Boolean(sid),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('nightly_reconcile_results')
        .select('created_at, divergent_count, applied_count, orphan_cancelled, deleted_check_complete, error_message')
        .eq('store_id', sid as string)
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return deriveNightlyStatus((data as NightlyRow[]) ?? []);
    },
    staleTime: 5 * 60_000, // corre 1x/día — no hace falta refetch agresivo
    refetchOnWindowFocus: true,
  });
}
