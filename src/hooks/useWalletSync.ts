import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export interface WalletSyncResult {
  ok: boolean;
  synced?: number;
  total?: number;
  dropi_user_id?: number;
  error?: string;
  expired?: boolean;
  message?: string;
}

export function useWalletSync() {
  const qc = useQueryClient();

  return useMutation<WalletSyncResult, Error, { from?: string; untill?: string; limit?: number } | void>({
    mutationFn: async (body) => {
      const today = new Date();
      const past = new Date();
      past.setDate(past.getDate() - 30);
      const payload = {
        from: body?.from ?? past.toISOString().split('T')[0],
        untill: body?.untill ?? today.toISOString().split('T')[0],
        ...(body?.limit ? { limit: body.limit } : {}),
      };

      const { data, error } = await supabase.functions.invoke('dropi-wallet-sync', {
        body: payload,
      });
      if (error) {
        // Edge function no-2xx — Supabase client retorna error con context
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
        toast.success(`Sync OK: ${data.synced ?? 0} movimientos sincronizados (${data.total ?? 0} traídos).`);
        qc.invalidateQueries({ queryKey: ['wallet_movements'] });
        qc.invalidateQueries({ queryKey: ['wallet_daily_series'] });
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
