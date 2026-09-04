import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { variantesDeBusqueda, fusionarResultados } from '@/lib/busquedaTelefono';

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
      // ⛔ DOS CONSULTAS CUANDO EL TÉRMINO ES UN TELÉFONO (4-sep-2026).
      //
      // `search_orders` compara con `phone LIKE '%loQueEscribiste%'`, y eso es
      // asimétrico: `'%986255535%'` encuentra `0986255535`, pero
      // `'%0986255535%'` NO encuentra `986255535`. En Ecuador los 12.000
      // pedidos están guardados en 9 dígitos limpios y el cliente escribe el
      // cero inicial, así que copiar su número del chat al buscador no
      // devolvía NADA — con el pedido ahí (#6853503, Néstor Isaías Ayme).
      //
      // La RPC no se reescribe: REGLA #1, está desplegada y el repo va atrás.
      // Se compensa acá, y de la forma que no puede romper nada: la búsqueda
      // de siempre se hace igual y PRIMERO, y solo se AGREGA la canónica
      // cuando aporta algo distinto. Para un nombre o una guía sigue siendo
      // una sola consulta, como antes.
      const variantes = variantesDeBusqueda(q);
      const respuestas = await Promise.all(
        variantes.map((t) => rpc('search_orders', { p_store_id: storeId, p_q: t, p_limit: 50 })),
      );
      if (mine !== runId.current) return; // llegó tarde: ya hay otra búsqueda
      // Un error en CUALQUIERA de las dos se reporta: decir "no hay pedidos"
      // sobre una consulta que falló es la clase de cero afirmado que este
      // proyecto persigue. La primera es la que la asesora escribió.
      const err = respuestas.find((r) => r.error)?.error ?? null;
      if (err) {
        setError(err.message);
        setHits([]);
      } else {
        setError(null);
        setHits(fusionarResultados(respuestas.map((r) => r.data as OrderSearchHit[] | null), 50));
      }
      setLoading(false);
    }, 400);

    return () => clearTimeout(t);
  }, [enabled, storeId, q]);

  return { hits, loading, error, enabled };
}
