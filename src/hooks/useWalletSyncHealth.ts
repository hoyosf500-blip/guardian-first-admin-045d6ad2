import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// Hook para detectar staleness del wallet de Dropi.
// T3-3: además de synced_at, ahora miramos max(created_at). Antes
// solo el synced_at. Si el cron se rompe y nunca corre de nuevo,
// synced_at queda en el pasado pero no detectamos que dejaron de
// llegar movimientos NUEVOS (lo que importa al negocio).
//
// Devuelve un status simbólico que el badge usa para colorear:
//   fresh     → < 8h         (verde)
//   stale     → 8h-24h       (amarillo, warning)
//   critical  → > 24h        (rojo)
//   never     → null         (gris)

export type WalletSyncStatus = 'fresh' | 'stale' | 'critical' | 'never';

export interface WalletSyncHealth {
  lastSyncAt: Date | null;
  hoursSinceSync: number | null;
  // Hours desde el último movimiento NUEVO insertado (created_at).
  // Si esto es viejo aunque synced_at sea reciente, el cron sigue corriendo
  // pero la API de Dropi no está devolviendo movimientos nuevos.
  hoursSinceNewMovement: number | null;
  status: WalletSyncStatus;
}

const FRESH_HOURS = 8;
const STALE_HOURS = 24;

function deriveStatus(hoursSync: number | null, hoursNew: number | null): WalletSyncStatus {
  if (hoursSync === null) return 'never';
  // El peor de los dos manda. Si o el cron no corre o no llegan movs nuevos,
  // los KPIs están desactualizados.
  const worst = Math.max(hoursSync, hoursNew ?? hoursSync);
  if (worst < FRESH_HOURS) return 'fresh';
  if (worst < STALE_HOURS) return 'stale';
  return 'critical';
}

// `storeId` scopea la frescura a la TIENDA activa. Sin esto, un admin (que por
// RLS ve todas las tiendas) veía el sync más reciente de CUALQUIER tienda → el
// badge marcaba "fresh" aunque la tienda que está mirando estuviera vieja (falsa
// tranquilidad). Pasá `activeStoreId` desde StoreContext.
export function useWalletSyncHealth(storeId?: string | null) {
  return useQuery<WalletSyncHealth>({
    queryKey: ['wallet_sync_health', storeId ?? 'all'],
    queryFn: async () => {
      let syncQ = supabase
        .from('dropi_wallet_movements')
        .select('synced_at')
        .order('synced_at', { ascending: false })
        .limit(1);
      let fechaQ = supabase
        .from('dropi_wallet_movements')
        .select('fecha')
        .order('fecha', { ascending: false })
        .limit(1);
      if (storeId) {
        syncQ = syncQ.eq('store_id', storeId);
        fechaQ = fechaQ.eq('store_id', storeId);
      }
      const [syncRes, fechaRes] = await Promise.all([
        syncQ.maybeSingle(),
        fechaQ.maybeSingle(),
      ]);
      if (syncRes.error) throw syncRes.error;
      if (fechaRes.error) throw fechaRes.error;
      const tsSync = syncRes.data?.synced_at ? new Date(syncRes.data.synced_at) : null;
      const tsNew = fechaRes.data?.fecha ? new Date(fechaRes.data.fecha) : null;
      const hoursSync = tsSync ? (Date.now() - tsSync.getTime()) / 3_600_000 : null;
      const hoursNew = tsNew ? (Date.now() - tsNew.getTime()) / 3_600_000 : null;
      return {
        lastSyncAt: tsSync,
        hoursSinceSync: hoursSync,
        hoursSinceNewMovement: hoursNew,
        status: deriveStatus(hoursSync, hoursNew),
      };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}
