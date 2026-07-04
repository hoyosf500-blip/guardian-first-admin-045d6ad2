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

export function useResumenSync() {
  const qc = useQueryClient();
  const { activeStoreId } = useStore();

  return useMutation<ResumenSyncResult, Error, ResumenSyncVars>({
    mutationFn: async ({ from, untill }) => {
      if (!activeStoreId) throw new Error('Sin tienda activa');
      const body = { store_id: activeStoreId, from, untill };

      // ── 1) Órdenes primero. Si falla, NO abortamos el wallet ──
      let ordersOk = true;
      let ordersError: string | undefined;
      try {
        const { data, error } = await supabase.functions.invoke('dropi-sync', { body });
        const d = data as { error?: string; rateLimited?: boolean; message?: string } | null;
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

      return { ordersOk, walletOk, ordersError, walletError, walletSynced };
    },

    onSuccess: (r) => {
      if (r.ordersOk && r.walletOk) {
        toast.success(
          `Pedidos y wallet sincronizados${r.walletSynced != null ? ` (${r.walletSynced} movimientos)` : ''}.`,
        );
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
