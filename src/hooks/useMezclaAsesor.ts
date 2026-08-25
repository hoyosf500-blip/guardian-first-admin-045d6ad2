import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { bogotaToday } from '@/lib/utils';
import { normalizarRiesgo } from '@/lib/riesgoChat';
import { agruparMezcla, type MezclaAsesor, type FilaMezcla } from '@/lib/mezclaAsesor';

/**
 * Mezcla de trabajo por asesor de HOY: cruza order_results (quién gestionó) con
 * orders.chat_riesgo (qué etiqueta tenía el pedido) para detectar "descreme"
 * (agarrar solo los fáciles). Ver `mezclaAsesor.ts`.
 *
 * Solo HOY a propósito: 7d/30d traería miles de filas al cliente. El "descreme"
 * es una señal en vivo del turno. `enabled=false` no consulta.
 *
 * Devuelve `error` (no cero mudo): si la query falla, el panel dice "no se pudo
 * leer", no "nadie descremó" — un cero inventado acá sería una acusación falsa.
 */
export function useMezclaAsesor(storeId: string | null, enabled: boolean) {
  const [mezcla, setMezcla] = useState<Map<string, MezclaAsesor>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!enabled || !storeId) { setMezcla(new Map()); setError(false); return; }
    let vivo = true;
    setLoading(true);
    const startIso = new Date(`${bogotaToday()}T00:00:00-05:00`).toISOString();
    void supabase
      .from('order_results')
      .select('operator_id, result, orders(chat_riesgo)')
      .eq('store_id', storeId)
      .eq('module', 'confirmar')
      .in('result', ['conf', 'canc', 'noresp'])
      .gte('created_at', startIso)
      .then(({ data, error: err }) => {
        if (!vivo) return;
        if (err || !data) { setError(true); setLoading(false); return; }
        const filas: FilaMezcla[] = (data as Array<{ operator_id: string | null; orders: unknown }>).map((r) => {
          const o = Array.isArray(r.orders) ? r.orders[0] : r.orders;
          const riesgoRaw = o && typeof o === 'object' ? (o as { chat_riesgo?: unknown }).chat_riesgo : null;
          return { operatorId: String(r.operator_id ?? ''), riesgo: normalizarRiesgo(riesgoRaw) };
        });
        setMezcla(agruparMezcla(filas));
        setError(false);
        setLoading(false);
      });
    return () => { vivo = false; };
  }, [storeId, enabled]);

  return { mezcla, loading, error };
}
