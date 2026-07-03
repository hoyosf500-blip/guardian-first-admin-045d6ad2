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

export type NightlyStatus = 'verified' | 'unverified' | 'error' | 'hidden';

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

const RUN_STALE_HOURS = 27; // corre cada 24h; 3h de gracia

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

  let status: NightlyStatus;
  if (ageHrs > RUN_STALE_HOURS || last.error_message) status = 'error';
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
