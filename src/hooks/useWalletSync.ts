import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

// Sync de billetera Dropi — invoca la edge function `dropi-wallet-sync`
// que internamente llama a /api/wallet/exportexcel (que NO tiene IP block,
// a diferencia de /api/historywallet) y parsea el XLSX server-side.
// Verificado 2026-04-29: server-side con JWT user funciona, browser-side
// no porque Dropi rechaza CORS desde origins distintos a app.dropi.co.

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

  return useMutation<WalletSyncResult, Error, { from?: string; untill?: string; limit?: number; dryRun?: boolean } | undefined>({
    mutationFn: async (body) => {
      const today = new Date();
      const past = new Date();
      past.setDate(past.getDate() - 30);
      const b = body ?? {};
      const payload = {
        from: b.from ?? past.toISOString().split('T')[0],
        untill: b.untill ?? today.toISOString().split('T')[0],
        ...(b.limit ? { limit: b.limit } : {}),
        ...(b.dryRun ? { dryRun: true } : {}),
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
        toast.success(`Sync OK: ${data.synced ?? 0} movimientos sincronizados (${data.total ?? 0} traídos del XLSX).`);
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
