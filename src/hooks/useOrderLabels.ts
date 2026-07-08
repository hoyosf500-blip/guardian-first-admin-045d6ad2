import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import type { LabelKey } from '@/lib/orderLabels';

// `order_labels` aún no está en los tipos generados (migration pendiente) → cast
// puntual, mismo patrón que OrderDetailPage con order_status_history.
const sb = supabase as unknown as SupabaseClient;

/**
 * Etiquetas MANUALES de un pedido (dificil/interesado), compartidas por tienda.
 * Las AUTO (datos_incompletos/no_contesta) NO viven acá — se derivan al render.
 *
 * Degradación segura: si la tabla `order_labels` todavía no existe (migration sin
 * aplicar), la query falla y devolvemos lista vacía + tableMissing=true, sin romper
 * la ficha. Las etiquetas manuales se activan solas cuando el dueño pega el SQL.
 */
interface LabelRow { id: string; label: string; operator_id: string; }

export function useOrderLabels(orderId?: string | null, phone?: string | null) {
  const { user } = useAuth();
  const { activeStoreId } = useStore();
  const [labels, setLabels] = useState<LabelKey[]>([]);
  const [tableMissing, setTableMissing] = useState(false);

  const load = useCallback(async () => {
    if (!orderId) { setLabels([]); return; }
    const { data, error } = await sb
      .from('order_labels')
      .select('id, label, operator_id')
      .eq('order_id', orderId);
    if (error) {
      // 42P01 = tabla inexistente (migration pendiente) → degradar en silencio.
      if (/relation .*order_labels.* does not exist|42P01/i.test(error.message)) {
        setTableMissing(true);
      }
      setLabels([]);
      return;
    }
    setTableMissing(false);
    setLabels(((data || []) as LabelRow[]).map((r) => r.label as LabelKey));
  }, [orderId]);

  useEffect(() => { void load(); }, [load]);

  // Realtime: si otra asesora etiqueta el mismo pedido, se ve al toque.
  useEffect(() => {
    if (!orderId || tableMissing) return;
    const ch = supabase
      .channel(`order-labels-${orderId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'order_labels', filter: `order_id=eq.${orderId}` },
        () => { void load(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [orderId, tableMissing, load]);

  const addLabel = useCallback(async (label: LabelKey) => {
    if (!user || !activeStoreId || !orderId) return;
    setLabels((prev) => (prev.includes(label) ? prev : [...prev, label])); // optimista
    const { error } = await sb.from("order_labels").insert({
      order_id: orderId,
      phone: phone || null,
      label,
      operator_id: user.id,
      store_id: activeStoreId,
    });
    if (error && !/duplicate key/i.test(error.message)) {
      setLabels((prev) => prev.filter((l) => l !== label)); // revertir si falló
    }
  }, [user, activeStoreId, orderId, phone]);

  const removeLabel = useCallback(async (label: LabelKey) => {
    if (!orderId) return;
    setLabels((prev) => prev.filter((l) => l !== label)); // optimista
    await sb.from("order_labels").delete().eq('order_id', orderId).eq('label', label);
  }, [orderId]);

  const toggleLabel = useCallback((label: LabelKey) => {
    if (labels.includes(label)) return removeLabel(label);
    return addLabel(label);
  }, [labels, addLabel, removeLabel]);

  return { manualLabels: labels, toggleLabel, addLabel, removeLabel, tableMissing };
}
