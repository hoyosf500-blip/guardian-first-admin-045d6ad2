import { useState, useEffect, useId } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { isSegCloser } from '@/lib/segDailyReview';
import { esAvisoAgencia } from '@/lib/avisoAgencia';

/**
 * Ventana de búsqueda de cierres. Cubre con holgura la ventana de datos de
 * Seguimiento (45 días) → un pedido visible siempre cae dentro. Acota la query
 * para no traer touchpoints de hace meses que ya no aplican.
 */
const CLOSER_LOOKBACK_DAYS = 90;

/**
 * Índice de lo que el equipo YA hizo en Seguimiento, leído de `touchpoints`.
 *
 * Devuelve DOS mapas `phone → timestamp(ms)`, sacados del MISMO SELECT:
 *
 *  - `closed`        → último cierre (Resuelto / Devolución).
 *  - `avisosAgencia` → último «Avisé: en oficina». Ese touchpoint se escribía
 *    desde hace meses y **no lo leía nadie**: el tablero no distinguía al
 *    cliente que ya sabe que su paquete llegó del que no. Es la diferencia
 *    entre una entrega y una devolución (76 devoluciones en un mes en EC).
 *    Cuándo cuenta un aviso lo decide `estadoAvisoAgencia` — un aviso ANTERIOR
 *    a la llegada del paquete es de otro pedido del mismo cliente.
 *
 * ── Sobre `closed` ──────────────────────────────────────────────────────────
 * Es el ÚLTIMO cierre (Resuelto/Devolución) registrado
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
export interface SegTouchIndex {
  /** phone -> ms del ultimo cierre (Resuelto / Devolucion). */
  closed: Map<string, number>;
  /** phone -> ms del ultimo aviso \"Avise: en oficina\". */
  avisosAgencia: Map<string, number>;
}

const VACIO: SegTouchIndex = { closed: new Map(), avisosAgencia: new Map() };

export function useSegTouchIndex(storeId: string | null): SegTouchIndex {
  const [idx, setIdx] = useState<SegTouchIndex>(VACIO);
  // ⛔ El nombre del canal lleva un id POR INSTANCIA (22-ago-2026, tumbó
  // /seguimiento en producción). Este hook lo montan DOS componentes a la vez
  // —`SeguimientoTab` y `SiguienteAccionBar`, que vive en el layout— y con un
  // nombre fijo el segundo intentaba agregarle un callback a un canal que el
  // primero ya había suscrito: «cannot add postgres_changes callbacks ... after
  // subscribe()», y la pantalla entera caía en su ErrorBoundary. Cualquier hook
  // con canal de realtime que pueda montarse dos veces necesita esto.
  const instanciaId = useId();

  // Carga inicial + reset al cambiar de tienda. La bandera `cancelled` evita que
  // una query lenta de la tienda A pise el estado (ya en blanco) de la tienda B
  // si la operadora cambió de tienda antes de que A resolviera (race multi-tienda).
  useEffect(() => {
    setIdx(VACIO);
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
          console.warn('[useSegTouchIndex] error paginando touchpoints SEG:', error);
          break;
        }
        all.push(...(data as Tp[]));
        if (data.length < PAGE_SIZE || all.length >= HARD_LIMIT) break;
        fromIdx += PAGE_SIZE;
      }
      // Una sola pasada sobre las mismas filas: los cierres y los avisos de
      // agencia salen del mismo SELECT. Leer el aviso NO cuesta una consulta.
      const closed = new Map<string, number>();
      const avisosAgencia = new Map<string, number>();
      const ultimo = (m: Map<string, number>, phone: string, ms: number) => {
        const prev = m.get(phone);
        if (prev === undefined || ms > prev) m.set(phone, ms);
      };
      for (const t of all) {
        if (!t.phone) continue;
        const ms = new Date(t.created_at).getTime();
        if (isSegCloser(t.action)) ultimo(closed, t.phone, ms);
        else if (esAvisoAgencia(t.action)) ultimo(avisosAgencia, t.phone, ms);
      }
      if (!cancelled) setIdx({ closed, avisosAgencia });
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
      .channel(`seg-touch-${storeId}-${instanciaId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'touchpoints', filter: `store_id=eq.${storeId}` },
        (payload) => {
          const row = payload.new as { phone?: string; action?: string; store_id?: string; created_at?: string };
          if (row.store_id !== storeId) return;
          if (!row.phone || !row.action) return;
          const esCierre = isSegCloser(row.action);
          const esAviso = !esCierre && esAvisoAgencia(row.action);
          if (!esCierre && !esAviso) return;
          const ms = row.created_at ? new Date(row.created_at).getTime() : Date.now();
          setIdx(prev => {
            const clave = esCierre ? 'closed' : 'avisosAgencia';
            const cur = prev[clave].get(row.phone!);
            if (cur !== undefined && cur >= ms) return prev;
            const next = new Map(prev[clave]);
            next.set(row.phone!, ms);
            return { ...prev, [clave]: next };
          });
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [storeId, instanciaId]);

  return idx;
}
