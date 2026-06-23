import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';

// Frescura del sync de ÓRDENES (pedidos) por tienda. Lee `sync_logs` — la misma
// fuente que el banner global `SyncFreshness` — y replica su lógica de color,
// pero expuesta como hook reusable para el badge del header de MesActualResumen.
//
// Distinto de useWalletSyncHealth (que mide el WALLET vía dropi_wallet_movements).
// El badge del header "Cómo voy" estaba usando el de wallet al lado de "pedidos
// generados" → frescura falsa. Este hook arregla esa señal.
//
// RLS: `sync_logs` SELECT requiere ser admin global O miembro de la tienda (policy
// `is_store_member`, migration 2026-06). Si el usuario no tiene permiso, la query
// devuelve [] (sin error) → status 'hidden' → el badge se oculta (no muestra
// "Nunca" falso), igual que SyncFreshness se auto-oculta con logs vacíos.

export type OrdersSyncStatus = 'fresh' | 'stale' | 'error' | 'hidden';

export interface OrdersSyncHealth {
  status: OrdersSyncStatus;
  /** Última corrida con synced_count>0: ancla del relativo "hace X". */
  lastSuccessAt: Date | null;
  /** Último intento (cualquier status): para "Sin sync hace X min". */
  lastAttemptAt: Date | null;
  lastErrorMessage: string | null;
}

interface LogRow {
  status: string;
  synced_count: number;
  total_count: number;
  created_at: string;
  error_message: string | null;
}

/**
 * Deriva la salud del sync de órdenes a partir de las últimas filas de sync_logs.
 * PURA y exportada para testear. Replica EXACTAMENTE la lógica de color de
 * `SyncFreshness.tsx:76-93` (red/yellow/green) mapeada a error/stale/fresh, y
 * agrega 'hidden' cuando no hay filas (sin corridas o sin permiso RLS).
 */
export function deriveOrdersStatus(
  logs: LogRow[],
  now: number = Date.now(),
): OrdersSyncHealth {
  if (!logs || logs.length === 0) {
    return { status: 'hidden', lastSuccessAt: null, lastAttemptAt: null, lastErrorMessage: null };
  }

  const last = logs[0];
  const lastAttemptAgeMin = (now - new Date(last.created_at).getTime()) / 60_000;
  const lastSuccess = logs.find((l) => l.status === 'success' && l.synced_count > 0);
  const lastSuccessAgeHrs = lastSuccess
    ? (now - new Date(lastSuccess.created_at).getTime()) / 3_600_000
    : Infinity;
  const recentHour = logs.filter(
    (l) => (now - new Date(l.created_at).getTime()) / 60_000 < 60,
  );
  const recentAllZeroOrWarn = recentHour.length > 0
    && recentHour.every((l) => l.synced_count === 0 || l.status === 'warn');
  const lastIsError = last.status === 'error';

  let status: OrdersSyncStatus;
  if (lastIsError || lastAttemptAgeMin > 60) status = 'error';
  else if (recentAllZeroOrWarn || lastSuccessAgeHrs > 24) status = 'stale';
  else status = 'fresh';

  return {
    status,
    lastSuccessAt: lastSuccess ? new Date(lastSuccess.created_at) : null,
    lastAttemptAt: new Date(last.created_at),
    lastErrorMessage: last.error_message,
  };
}

export function useOrdersSyncHealth(storeId?: string | null) {
  const activeStoreId = useActiveStoreId();
  const sid = storeId ?? activeStoreId;
  return useQuery<OrdersSyncHealth>({
    queryKey: ['orders-sync-health', sid ?? 'all'],
    enabled: Boolean(sid),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sync_logs')
        .select('status, synced_count, total_count, created_at, error_message')
        .eq('store_id', sid as string)
        .order('created_at', { ascending: false })
        .limit(12);
      if (error) throw error;
      return deriveOrdersStatus((data as LogRow[]) ?? []);
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}
