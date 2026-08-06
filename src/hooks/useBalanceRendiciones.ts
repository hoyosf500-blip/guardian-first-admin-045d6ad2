import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { isRpcMissing } from '@/lib/rpcError';
import { toast } from 'sonner';
import type { MesCrudo, Rendicion } from '@/lib/balanceRendiciones';

// Balance mes a mes + rendiciones (migration 20260806140000).
//
// DEGRADACIÓN: si la migration todavía no está aplicada, los dos hooks devuelven
// `null` (no [] ni ceros) para que la pantalla pueda decir "falta aplicar la
// migración" en vez de mostrar un balance en cero, que se lee como "no ganaste
// nada". Un error REAL (permiso, 500, red) SÍ se re-lanza para que React Query
// reintente — mismo criterio que useLogisticaMonthlyCosts. Ver [[rpcError]].

function num(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

/** `supabase.rpc` sin perder el `this` (sin bind explota — ver [[rpc_supabase_binding_pattern]]). */
function rpc() {
  return supabase.rpc.bind(supabase) as unknown as (
    fn: string, args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

// ── Balance mensual ────────────────────────────────────────────────────────

export function useBalanceMensual(desde: string, hasta: string) {
  const storeId = useActiveStoreId();
  return useQuery<MesCrudo[] | null>({
    queryKey: ['balance-mensual', storeId ?? 'none', desde, hasta],
    enabled: Boolean(storeId && desde && hasta),
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await rpc()('balance_mensual', {
        p_store_id: storeId, p_desde: desde, p_hasta: hasta,
      });
      if (error) {
        if (isRpcMissing(error)) return null;   // migration pendiente
        throw error;
      }
      return ((data as Record<string, unknown>[]) ?? []).map((r) => ({
        year_month: String(r.year_month ?? ''),
        operativo: num(r.operativo),
        pauta: num(r.pauta),
        admin: num(r.admin),
        retirado: num(r.retirado),
        rendido: num(r.rendido),
        pedidos: num(r.pedidos),
        entregados: num(r.entregados),
        devueltos: num(r.devueltos),
      }));
    },
  });
}

// ── Rendiciones ────────────────────────────────────────────────────────────

export function useRendiciones(from: string, to: string) {
  const storeId = useActiveStoreId();
  return useQuery<Rendicion[] | null>({
    queryKey: ['rendiciones', storeId ?? 'none', from, to],
    enabled: Boolean(storeId && from && to),
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await rpc()('rendiciones_range', {
        p_store_id: storeId, p_from: from, p_to: to,
      });
      if (error) {
        if (isRpcMissing(error)) return null;
        throw error;
      }
      // El RPC devuelve un jsonb ya armado (cabeceras con sus ítems anidados):
      // así una falla parcial no puede dejar una rendición sin comprobantes, que
      // el cruce leería como plata sin explicar estando explicada.
      const filas = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
      return filas.map((r) => ({
        id: String(r.id),
        fecha: String(r.fecha ?? ''),
        responsable: (r.responsable as string) ?? null,
        monto_retirado: num(r.monto_retirado),
        notas: (r.notas as string) ?? null,
        items: ((r.items as Record<string, unknown>[]) ?? []).map((i) => ({
          id: String(i.id),
          fecha: (i.fecha as string) ?? null,
          concepto: String(i.concepto ?? ''),
          monto: num(i.monto),
          plataforma: (i.plataforma as string) ?? null,
        })),
      }));
    },
  });
}

export interface GuardarRendicionVars {
  id?: string | null;
  fecha: string;
  responsable: string;
  monto_retirado: number;
  notas: string;
  items: Array<{ fecha: string | null; concepto: string; monto: number; plataforma: string | null }>;
}

export function useGuardarRendicion() {
  const qc = useQueryClient();
  const storeId = useActiveStoreId();
  return useMutation<unknown, Error, GuardarRendicionVars>({
    mutationFn: async (v) => {
      if (!storeId) throw new Error('Sin tienda activa');
      const { data, error } = await rpc()('upsert_rendicion', {
        p_store_id: storeId,
        p_fecha: v.fecha,
        p_responsable: v.responsable,
        p_monto_retirado: v.monto_retirado,
        p_notas: v.notas,
        p_items: v.items,
        p_id: v.id ?? null,
      });
      if (error) throw new Error(error.message || 'No se pudo guardar la rendición');
      return data;
    },
    onSuccess: () => {
      // El balance también cambia: `rendido` sale de estas mismas filas.
      qc.invalidateQueries({ queryKey: ['rendiciones'] });
      qc.invalidateQueries({ queryKey: ['balance-mensual'] });
      toast.success('Rendición guardada.');
    },
    onError: (e) => toast.error(`No se pudo guardar: ${e.message}`),
  });
}

export function useBorrarRendicion() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: async (id) => {
      const { error } = await rpc()('delete_rendicion', { p_id: id });
      if (error) throw new Error(error.message || 'No se pudo borrar');
      return true;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rendiciones'] });
      qc.invalidateQueries({ queryKey: ['balance-mensual'] });
      toast.success('Rendición borrada.');
    },
    onError: (e) => toast.error(`No se pudo borrar: ${e.message}`),
  });
}
