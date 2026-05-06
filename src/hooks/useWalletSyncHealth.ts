import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// Hook para detectar staleness del wallet de Dropi.
// Lee MAX(synced_at) de dropi_wallet_movements (RLS admin-only ya está
// configurada en la tabla — mismo path que usa useWalletMovements).
//
// Devuelve un status simbólico que el badge usa para colorear:
//   fresh     → < 8h         (verde)
//   stale     → 8h-24h       (amarillo, warning)
//   critical  → > 24h        (rojo)
//   never     → null         (gris)
//
// El cron automático (migration 20260506140000) corre cada 6h, así que en
// operación normal el estado debería ser SIEMPRE 'fresh'. Si pasa a 'stale'
// o 'critical', algo se rompió (token expirado, edge function caída, etc.).

export type WalletSyncStatus = 'fresh' | 'stale' | 'critical' | 'never';

export interface WalletSyncHealth {
  lastSyncAt: Date | null;
  hoursSinceSync: number | null;
  status: WalletSyncStatus;
}

const FRESH_HOURS = 8;
const STALE_HOURS = 24;

function deriveStatus(hours: number | null): WalletSyncStatus {
  if (hours === null) return 'never';
  if (hours < FRESH_HOURS) return 'fresh';
  if (hours < STALE_HOURS) return 'stale';
  return 'critical';
}

export function useWalletSyncHealth() {
  return useQuery<WalletSyncHealth>({
    queryKey: ['wallet_sync_health'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('dropi_wallet_movements')
        .select('synced_at')
        .order('synced_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      const ts = data?.synced_at ? new Date(data.synced_at) : null;
      const hours = ts
        ? (Date.now() - ts.getTime()) / 3_600_000
        : null;
      return {
        lastSyncAt: ts,
        hoursSinceSync: hours,
        status: deriveStatus(hours),
      };
    },
    staleTime: 60_000,            // 1 min — al volver del sync se invalida via useWalletSync
    refetchOnWindowFocus: true,   // si volvés a la pestaña, re-checkear
  });
}
