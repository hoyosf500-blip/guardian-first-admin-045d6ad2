import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import type { ManualMark } from '@/lib/shopifyMarks';

// `shopify_manual_marks` aún no está en los tipos generados (se agregan al
// regenerar). Mismo patrón que WaChannelsPanel/ProductKnowledgePanel.
const sb = supabase as unknown as SupabaseClient;

const MARKS_COLUMNS = 'id, shopify_order_id, shopify_name, customer, phone, total, city, marked_at';
const MAX_ROWS = 1000;

export interface ShopifyMarksData {
  marks: ManualMark[];
  totalCount: number;   // todas las marcas activas de la tienda (sin filtro de fecha)
}

/** Datos mínimos para registrar una marca — vienen del ShopifyPendingItem. */
export interface ManualMarkInput {
  id: string;           // shopify_order_id (= ShopifyPendingItem.id)
  name?: string;
  customer?: string;
  phone?: string;
  total?: number;
  city?: string;
}

/**
 * Historial de marcas "Ya lo metí" de la tienda activa + acciones de marcar y
 * revertir. Solo lee marcas ACTIVAS (reverted_at IS NULL). `totalCount` es el
 * total histórico (sin filtro de fecha) para distinguir viejas de nuevas.
 */
export function useShopifyManualMarks(storeId: string | null) {
  const { user } = useAuth();
  const qc = useQueryClient();

  const query = useQuery<ShopifyMarksData>({
    queryKey: ['shopify_manual_marks', storeId],
    enabled: !!storeId,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!storeId) return { marks: [], totalCount: 0 };
      const [rowsRes, countRes] = await Promise.all([
        sb.from('shopify_manual_marks')
          .select(MARKS_COLUMNS)
          .eq('store_id', storeId)
          .is('reverted_at', null)
          .order('marked_at', { ascending: false })
          .limit(MAX_ROWS),
        sb.from('shopify_manual_marks')
          .select('id', { count: 'exact', head: true })
          .eq('store_id', storeId)
          .is('reverted_at', null),
      ]);
      if (rowsRes.error) throw rowsRes.error;
      const marks = (rowsRes.data ?? []) as ManualMark[];
      return { marks, totalCount: countRes.count ?? marks.length };
    },
  });

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['shopify_manual_marks', storeId] });
  }, [qc, storeId]);

  /** Registra la marca. Tolera el doble-click: una 2ª marca activa del mismo
   *  pedido choca con el índice único parcial (23505) y se ignora en silencio. */
  const markEntered = useCallback(async (item: ManualMarkInput): Promise<{ ok: boolean; error?: string }> => {
    if (!storeId || !user) return { ok: false, error: 'sin sesión' };
    const { error } = await sb.from('shopify_manual_marks').insert({
      store_id: storeId,
      operator_id: user.id,
      shopify_order_id: item.id,
      shopify_name: item.name ?? null,
      customer: item.customer ?? null,
      phone: item.phone ?? null,
      total: item.total ?? null,
      city: item.city ?? null,
    });
    if (error && (error as { code?: string }).code !== '23505') {
      return { ok: false, error: error.message };
    }
    invalidate();
    return { ok: true };
  }, [storeId, user, invalidate]);

  /** Deshace una marca (no la borra): setea reverted_at → el pedido vuelve a la cola. */
  const revertMark = useCallback(async (markId: string): Promise<{ ok: boolean; error?: string }> => {
    if (!storeId || !user) return { ok: false, error: 'sin sesión' };
    const { error } = await sb.from('shopify_manual_marks')
      .update({ reverted_at: new Date().toISOString(), reverted_by: user.id })
      .eq('id', markId);
    if (error) return { ok: false, error: error.message };
    invalidate();
    return { ok: true };
  }, [storeId, user, invalidate]);

  return {
    marks: query.data?.marks ?? [],
    totalCount: query.data?.totalCount ?? 0,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    refetch: query.refetch,
    markEntered,
    revertMark,
  };
}
