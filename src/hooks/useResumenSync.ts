import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useStore } from '@/contexts/StoreContext';

// Sync REAL del resumen de Logística. Lo usan DOS botones "Sincronizar":
// MesActualResumen ("Cómo voy") y FinanzasTab. A diferencia de useWalletSync
// (wallet-only, lo usa WalletSyncButton en Billetera/Cfo), este dispara ÓRDENES
// (dropi-sync) + WALLET (dropi-wallet-sync) y luego invalida TODAS las query keys
// que consumen ambas pantallas (embudo, ganancia neta, saldo, financial-summary y
// operativo-cohorte de Finanzas), para que se refresquen sin recargar la página.
//
// NO reemplaza a useWalletSync: ese queda intacto para los botones solo-wallet.
// El body de dropi-sync es el mismo shape verificado en los call-sites reales
// (useAutoDropiSync.ts:35-37, SyncPanel.tsx:27-29): { store_id, from, untill }.

export interface ResumenSyncResult {
  ordersOk: boolean;
  walletOk: boolean;
  ordersError?: string;
  walletError?: string;
  walletSynced?: number;
  /** true = el rango pedido era 100% viejo (>45d): no se invocó nada. */
  skippedOldRange?: boolean;
  /** true = el `from` se recortó a hoy−45d (anti-throttle). */
  clamped?: boolean;
  /** true = dropi-sync cortó por MAX_PAGES: quedaron páginas sin traer. */
  ordersPartial?: boolean;
}

interface ResumenSyncVars {
  from: string;   // 'YYYY-MM-DD'
  untill: string; // 'YYYY-MM-DD'
}

// Prefijos de las query keys que MesActualResumen consume. invalidateQueries
// matchea por prefijo, así una sola entrada cubre todas las variantes de
// storeId/rango. Cada una verificada con archivo:línea en el diagnóstico.
const KEYS_TO_INVALIDATE: string[] = [
  'orders-estado-breakdown', // useEstadoBreakdown.ts:27   → embudo
  'orders-sync-health',      // useOrdersSyncHealth.ts      → badge de frescura de pedidos (header)
  'ganancia-neta-dropi',     // useGananciaNetaDropi.ts:134 → ganancia neta real
  'wallet_movements',        // useWalletMovements.ts:52    → saldo
  'wallet_saldo_hoy',        // useWalletSaldoHoy           → "Saldo disponible hoy" (quedaba congelado tras Sincronizar)
  'wallet_daily_series',     // useWalletMovements.ts:106
  'wallet_sync_health',      // useWalletSyncHealth.ts:47   → badge + walletStale
  'logistics',               // useLogisticsStats.ts:49     → fallback logistics_summary
  'financial-summary',       // useFinancialSummary.ts:85   → ingresos/COGS/ticket (Finanzas)
  'operativo-cohorte',       // useOperativoCohorte.ts      → hero Ganancia Neta cohorte (Finanzas)
  'product-profitability',   // useProductProfitability.ts  → tabla Rentabilidad (quedaba stale 5min tras Sincronizar)
];

/** Parsea el detalle real de un error de functions.invoke (el body viene en
 *  error.context.body, mismo patrón que useWalletSync.ts:47-49). */
function parseInvokeError(error: unknown): { error?: string; expired?: boolean } | null {
  const ctxBody = (error as { context?: { body?: string } })?.context?.body;
  if (ctxBody) {
    try { return JSON.parse(ctxBody); } catch { /* noop */ }
  }
  return null;
}

// Fecha local YYYY-MM-DD (mismo formateo que DateRangeFilter — NO toISOString,
// que en UTC-5 corre el día después de las 19:00).
function localISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Anti-throttle 2026-07-07: tope del rango del sync MANUAL. El preset
// "Histórico" (2020-01-01) generaba ~27 chunks × paginación sin tope ≈ 396
// requests a Dropi en UN click (EC) + un exportexcel de wallet de 6.5 años.
// Los datos viejos YA están en la DB y el cron mantiene los cambios de estado;
// el backfill completo queda como acción explícita de admin (/admin → SyncPanel).
const MAX_SYNC_DAYS_BACK = 45;

export function useResumenSync() {
  const qc = useQueryClient();
  const { activeStoreId } = useStore();

  return useMutation<ResumenSyncResult, Error, ResumenSyncVars>({
    mutationFn: async ({ from, untill }) => {
      if (!activeStoreId) throw new Error('Sin tienda activa');

      // Clamp del rango (dentro del hook, no en los callers: FinanzasTab.test
      // asserta los args crudos de mutate sobre un mock).
      const minFromDate = new Date();
      minFromDate.setDate(minFromDate.getDate() - MAX_SYNC_DAYS_BACK);
      const minFrom = localISODate(minFromDate);
      const clamped = from < minFrom;
      const clampedFrom = clamped ? minFrom : from;
      // Rango 100% viejo (ej. ene–mar de un año pasado): dropi-sync con
      // from>untill genera 0 chunks y daría un "éxito" silencioso engañoso.
      // No invocar nada y avisar honesto.
      if (clampedFrom > untill) {
        return { ordersOk: true, walletOk: true, skippedOldRange: true };
      }
      const body = { store_id: activeStoreId, from: clampedFrom, untill };

      // ── 1) Órdenes primero. Si falla, NO abortamos el wallet ──
      let ordersOk = true;
      let ordersError: string | undefined;
      let ordersPartial = false;
      try {
        const { data, error } = await supabase.functions.invoke('dropi-sync', { body });
        const d = data as { error?: string; rateLimited?: boolean; message?: string; partial?: boolean } | null;
        if (error) {
          ordersOk = false;
          ordersError = parseInvokeError(error)?.error ?? error.message;
        } else if (d?.rateLimited) {
          // dropi-sync responde 200 con rateLimited cuando Dropi throttlea (común en EC).
          ordersOk = false;
          ordersError = d.message || 'Dropi throttled (rate limit)';
        } else if (d?.error) {
          ordersOk = false;
          ordersError = d.error;
        } else if (d?.partial) {
          // Sync PARCIAL (MAX_PAGES): upserteó lo traído pero quedaron páginas.
          // Surfacearlo — un corte silencioso sería un hueco de paridad invisible.
          ordersPartial = true;
        }
      } catch (e) {
        ordersOk = false;
        ordersError = (e as Error).message;
      }

      // ── 2) Wallet después, pase lo que pase con órdenes ──
      let walletOk = true;
      let walletError: string | undefined;
      let walletSynced: number | undefined;
      try {
        const { data, error } = await supabase.functions.invoke('dropi-wallet-sync', { body });
        const d = data as { ok?: boolean; synced?: number; error?: string; expired?: boolean } | null;
        if (error) {
          const parsed = parseInvokeError(error);
          walletOk = false;
          walletError = parsed?.expired ? 'Token Dropi expirado' : (parsed?.error ?? error.message);
        } else if (d && d.ok === false) {
          walletOk = false;
          walletError = d.expired ? 'Token Dropi expirado' : (d.error ?? 'error desconocido');
        } else {
          walletSynced = d?.synced;
        }
      } catch (e) {
        walletOk = false;
        walletError = (e as Error).message;
      }

      return { ordersOk, walletOk, ordersError, walletError, walletSynced, clamped, ordersPartial };
    },

    onSuccess: (r) => {
      if (r.skippedOldRange) {
        toast.info(
          'Ese período ya es histórico — los datos están en la base y el sync automático mantiene los cambios de estado. Para re-descargarlo usá /admin → Sincronizar pedidos.',
        );
        return;
      }
      if (r.ordersOk && r.walletOk) {
        const clampNote = r.clamped ? ' Sincronicé los últimos 45 días — el histórico lo mantiene el sync automático.' : '';
        if (r.ordersPartial) {
          toast.warning(`Sync PARCIAL de pedidos: el rango era muy grande y quedaron páginas sin traer — el sync automático completa el resto.${clampNote}`);
        } else {
          toast.success(
            `Pedidos y wallet sincronizados${r.walletSynced != null ? ` (${r.walletSynced} movimientos)` : ''}.${clampNote}`,
          );
        }
      } else if (!r.ordersOk && !r.walletOk) {
        toast.error(`Falló pedidos (${r.ordersError ?? '—'}) y wallet (${r.walletError ?? '—'}).`);
      } else if (!r.ordersOk) {
        toast.error(`Pedidos NO se sincronizaron: ${r.ordersError ?? '—'}. El wallet sí se actualizó.`);
      } else {
        toast.error(`Wallet NO se sincronizó: ${r.walletError ?? '—'}. Los pedidos sí se actualizaron.`);
      }
    },

    onError: (err) => {
      toast.error(`Error de red: ${err.message}`);
    },

    // Refrescar TODAS las cards del resumen, haya sido total o parcial: lo que sí
    // se sincronizó debe verse sin recargar la página.
    onSettled: () => {
      for (const key of KEYS_TO_INVALIDATE) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}
