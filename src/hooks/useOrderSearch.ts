import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * Búsqueda de pedidos EN EL SERVIDOR (RPC `search_orders`).
 *
 * El buscador de Seguimiento/Confirmar filtra en el navegador sobre lo que ya
 * se descargó — o sea, la ventana de días visible. Un pedido de hace tres meses
 * "no existe" para la asesora aunque esté en la base. Cargar todo el histórico
 * al cliente para arreglarlo sería peor: son decenas de miles de filas por
 * tienda y las paga el plan.
 *
 * Este hook consulta la base directamente: recorre TODO el histórico de la
 * tienda activa, devuelve como máximo 50 filas y nunca descarga la tabla.
 * La RPC es SECURITY DEFINER + `is_store_member` fail-closed, así que no puede
 * devolver pedidos de otra tienda.
 *
 * Reglas: mínimo 3 caracteres (un término corto arrastraría media base) y
 * 400 ms de espera para no disparar una consulta por tecla.
 */
export interface OrderSearchHit {
  external_id: string | null;
  nombre: string | null;
  phone: string | null;
  ciudad: string | null;
  producto: string | null;
  guia: string | null;
  estado: string | null;
  fecha: string | null;
  valor: number | null;
  transportadora: string | null;
}

export const MIN_SEARCH_LEN = 3;

export function useOrderSearch(storeId: string | null | undefined, query: string) {
  const [hits, setHits] = useState<OrderSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Descarta respuestas viejas que lleguen después de una búsqueda más nueva.
  const runId = useRef(0);

  const q = query.trim();
  const enabled = Boolean(storeId) && q.length >= MIN_SEARCH_LEN;

  useEffect(() => {
    if (!enabled) {
      setHits([]);
      setLoading(false);
      setError(null);
      return;
    }
    const mine = ++runId.current;
    setLoading(true);
    const t = setTimeout(async () => {
      // El binding directo pierde `this` (memoria rpc_supabase_binding_pattern).
      type Rpc = (fn: string, p: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
      const rpc = supabase.rpc.bind(supabase) as unknown as Rpc;
      const { data, error: err } = await rpc('search_orders', { p_store_id: storeId, p_q: q, p_limit: 50 });
      if (mine !== runId.current) return; // llegó tarde: ya hay otra búsqueda
      if (err) {
        setError(err.message);
        setHits([]);
      } else {
        setError(null);
        setHits((data as OrderSearchHit[]) ?? []);
      }
      setLoading(false);
    }, 400);

    return () => clearTimeout(t);
  }, [enabled, storeId, q]);

  return { hits, loading, error, enabled };
}
