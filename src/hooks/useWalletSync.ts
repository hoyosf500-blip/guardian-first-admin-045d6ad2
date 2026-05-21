import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useStore } from '@/contexts/StoreContext';

// Sync de billetera Dropi por TIENDA. Invoca `dropi-wallet-sync` con
// `store_id` (multi-tenant). La edge function valida que el caller sea
// dueño de la tienda.

export interface WalletSyncResult {
  ok: boolean;
  synced?: number;
  total?: number;
  rows_in_excel?: number;
  file_size_bytes?: number;
  dropi_user_id?: number;
  error?: string;
  expired?: boolean;
  message?: string;
}

export function useWalletSync() {
  const qc = useQueryClient();
  const { activeStoreId } = useStore();

  return useMutation<WalletSyncResult, Error, { from?: string; untill?: string; limit?: number; dryRun?: boolean } | undefined>({
    mutationFn: async (body) => {
      if (!activeStoreId) {
        throw new Error('Sin tienda activa');
      }
      const today = new Date();
      const past = new Date();
      past.setDate(past.getDate() - 30);
      const b = body ?? {};
      const payload = {
        store_id: activeStoreId,
        from: b.from ?? past.toISOString().split('T')[0],
        untill: b.untill ?? today.toISOString().split('T')[0],
        ...(b.limit ? { limit: b.limit } : {}),
        ...(b.dryRun ? { dryRun: true } : {}),
      };

      const { data, error } = await supabase.functions.invoke('dropi-wallet-sync', {
        body: payload,
      });
      if (error) {
        const ctx = (error as unknown as { context?: { body?: string } }).context;
        if (ctx?.body) {
          try { return JSON.parse(ctx.body) as WalletSyncResult; } catch { /* noop */ }
        }
        throw error;
      }
      return data as WalletSyncResult;
    },
    onSuccess: (data) => {
      if (data.ok) {
        toast.success(`Sync OK: ${data.synced ?? 0} movimientos sincronizados (${data.total ?? 0} traídos del XLSX).`);
        qc.invalidateQueries({ queryKey: ['wallet_movements'] });
        qc.invalidateQueries({ queryKey: ['wallet_daily_series'] });
        qc.invalidateQueries({ queryKey: ['wallet_sync_health'] });
      } else if (data.expired) {
        toast.error('Token Dropi expirado. Refrescá en Admin → Token sesión Dropi.');
      } else {
        toast.error(`Sync falló: ${data.error ?? 'error desconocido'}`);
      }
    },
    onError: (err) => {
      toast.error(`Error de red: ${err.message}`);
    },
  });
}
