import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { isSegCloser } from '@/lib/segDailyReview';

/**
 * Ventana de búsqueda de cierres. Cubre con holgura la ventana de datos de
 * Seguimiento (45 días) → un pedido visible siempre cae dentro. Acota la query
 * para no traer touchpoints de hace meses que ya no aplican.
 */
const CLOSER_LOOKBACK_DAYS = 90;

/**
 * Mapa `phone → timestamp(ms)` del ÚLTIMO cierre (Resuelto/Devolución) registrado
 * por CUALQUIER operadora de la tienda. Sirve para sacar de Seguimiento, de forma
 * permanente, los pedidos que el equipo YA resolvió o devolvió — "si ya se
 * entregó o se devolvió, no vuelve a salir" (el panel solo debe tener pedidos
 * accionables).
 *
 * Es **team-wide** (no per-operadora): si una asesora cierra un pedido, desaparece
 * para todas, porque el panel es compartido y todo lo que está ahí hay que
 * gestionarlo. El consumidor (SeguimientoTab) cruza este mapa con la fecha del
 * pedido vía `isClosedOutByCloser` para no esconder pedidos NUEVOS de un cliente
 * que ya tuvo un cierre viejo (el match de touchpoints es por phone, no order_id).
 *
 * Store-scoped + reset al cambiar de tienda (evita mezcla — ver memoria
 * store_switch_stale_loaders). Realtime para reflejar cierres de otras operadoras
 * en vivo, sin recargar todo.
 */
export function useSegClosedPhones(storeId: string | null): Map<string, number> {
  const [closed, setClosed] = useState<Map<string, number>>(new Map());

  // Carga inicial + reset al cambiar de tienda. La bandera `cancelled` evita que
  // una query lenta de la tienda A pise el estado (ya en blanco) de la tienda B
  // si la operadora cambió de tienda antes de que A resolviera (race multi-tienda).
  useEffect(() => {
    setClosed(new Map());
    if (!storeId) return;
    let cancelled = false;
    void (async () => {
      const cutoffIso = new Date(Date.now() - CLOSER_LOOKBACK_DAYS * 86400000).toISOString();
      // Paginación: Supabase corta todo SELECT a ~1000 filas. Con ~40 gestiones
      // SEG/día, 90 días superan ese tope y el corte (orden arbitrario sin
      // ORDER BY) se comía justamente los cierres RECIENTES → pedidos que el
      // equipo YA resolvió reaparecían como accionables y se volvía a llamar a
      // clientes resueltos. Descendente a propósito: si algo se trunca (error a
      // mitad de camino o HARD_LIMIT), se pierden cierres viejos e irrelevantes,
      // nunca los nuevos.
      const PAGE_SIZE = 1000;
      const HARD_LIMIT = 10000;
      type Tp = { phone: string; action: string; created_at: string };
      const all: Tp[] = [];
      let fromIdx = 0;
      while (true) {
        const { data, error } = await supabase
          .from('touchpoints')
          .select('phone, action, created_at')
          .eq('store_id', storeId)
          .ilike('action', 'SEG:%')
          .gte('created_at', cutoffIso)
          .order('created_at', { ascending: false })
          .range(fromIdx, fromIdx + PAGE_SIZE - 1);
        if (cancelled) return;
        if (error || !data) {
          // Error a mitad de la paginación: nos quedamos con lo ya leído (las
          // páginas más recientes) — un mapa parcial oculta MENOS de lo debido,
          // nunca de más, y el realtime completa los cierres que sigan llegando.
          console.warn('[useSegClosedPhones] error paginando touchpoints SEG:', error);
          break;
        }
        all.push(...(data as Tp[]));
        if (data.length < PAGE_SIZE || all.length >= HARD_LIMIT) break;
        fromIdx += PAGE_SIZE;
      }
      const map = new Map<string, number>();
      for (const t of all) {
        if (!t.phone || !isSegCloser(t.action)) continue;
        const ms = new Date(t.created_at).getTime();
        const prev = map.get(t.phone);
        if (prev === undefined || ms > prev) map.set(t.phone, ms);
      }
      if (!cancelled) setClosed(map);
    })();
    return () => { cancelled = true; };
  }, [storeId]);

  // Realtime: un cierre nuevo de CUALQUIER operadora se refleja sin recargar.
  // FILTRO SERVER-SIDE por store_id: sin él, el broker de Supabase entregaría a
  // ESTE cliente los payloads (phone, action, operator_id) de TODAS las tiendas
  // (la RLS de touchpoints no acota el realtime) → fuga cross-tenant de PII. El
  // guard client-side de abajo es defensa en profundidad, pero el filtro es lo
  // que evita que el dato cruce. Postgres Realtime no soporta ILIKE → el match de
  // cierre (isSegCloser) se hace client-side.
  useEffect(() => {
    if (!storeId) return;
    const channel = supabase
      .channel(`seg-closed-${storeId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'touchpoints', filter: `store_id=eq.${storeId}` },
        (payload) => {
          const row = payload.new as { phone?: string; action?: string; store_id?: string; created_at?: string };
          if (row.store_id !== storeId) return;
          if (!row.phone || !row.action || !isSegCloser(row.action)) return;
          const ms = row.created_at ? new Date(row.created_at).getTime() : Date.now();
          setClosed(prev => {
            const cur = prev.get(row.phone!);
            if (cur !== undefined && cur >= ms) return prev;
            const next = new Map(prev);
            next.set(row.phone!, ms);
            return next;
          });
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [storeId]);

  return closed;
}
