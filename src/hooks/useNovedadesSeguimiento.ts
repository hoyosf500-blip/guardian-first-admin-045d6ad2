import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { bogotaToday } from '@/lib/utils';
import {
  parseNovedadAction,
  classifyDeliveryOutcome,
  normalizeNovedadLabel,
  novedadGroupKey,
  bogotaDateNDaysAgo,
  NovedadResultTipo,
  DeliveryOutcome,
} from '@/lib/novedadGestion';

export type SeguimientoRange = 'today' | '7d' | '30d';

export interface NovedadGestionRow {
  phone: string;
  tipo: NovedadResultTipo;
  nota: string | null;
  operatorId: string;
  operatorName: string;
  actionDate: string;
  markedAt: string | null;
  nombre: string | null;
  novedad: string | null;
  transportadora: string | null;
  valor: number | null;
  estadoActual: string | null;
  outcome: DeliveryOutcome;
  responseMs: number | null;
}

export interface OperatorCoverage {
  operatorId: string;
  name: string;
  isMember: boolean;
  resuelta: number;
  devolucion: number;
  sinRespuesta: number;
  total: number;
  hoy: number;
}

export interface NovedadFrequency {
  label: string;
  count: number;
}

export interface NovedadesSeguimientoData {
  loading: boolean;
  range: SeguimientoRange;
  setRange: (r: SeguimientoRange) => void;
  refresh: () => void;
  // cobertura
  pendientes: number;
  nuevasHoy: number;
  gestionadasHoy: number;
  gestionadasRango: number;
  porOperadora: OperatorCoverage[];
  // resultados
  resueltas: number;
  devoluciones: number;
  sinRespuesta: number;
  tasaDevolucion: number | null;
  entregadasDeResueltas: number;
  resueltasConOutcome: number;
  // tiempos
  tiempoRespuestaPromMs: number | null;
  // detalle + ranking
  gestiones: NovedadGestionRow[];
  frecuentes: NovedadFrequency[];
}

const RANGE_DAYS: Record<SeguimientoRange, number> = { today: 0, '7d': 6, '30d': 29 };
const MAX_PHONES = 400;
const NOVEDAD_QUEUE_FILTER = 'estado.ilike.%NOVEDAD%,estado.ilike.%INTENTO DE ENTREGA%';

interface OrderLite {
  id: string;
  phone: string;
  estado: string | null;
  novedad: string | null;
  last_movement_at: string | null;
  valor: number | null;
  transportadora: string | null;
  nombre: string | null;
}

const EMPTY: Omit<NovedadesSeguimientoData, 'range' | 'setRange' | 'refresh' | 'loading'> = {
  pendientes: 0,
  nuevasHoy: 0,
  gestionadasHoy: 0,
  gestionadasRango: 0,
  porOperadora: [],
  resueltas: 0,
  devoluciones: 0,
  sinRespuesta: 0,
  tasaDevolucion: null,
  entregadasDeResueltas: 0,
  resueltasConOutcome: 0,
  tiempoRespuestaPromMs: null,
  gestiones: [],
  frecuentes: [],
};

/**
 * Lectura + agregación del SEGUIMIENTO de novedades de /novedades. Todo
 * client-side reusando `touchpoints` (la marca), `orders` (estado real para
 * outcome de entrega + texto de novedad para frecuencia) y `store_members` +
 * `profiles` (roster para el desglose "operadora en 0"). Cero backend.
 *
 * Limitaciones conocidas (documentadas en CLAUDE.md/diseño):
 *  - El match touchpoint↔orden es POR TELÉFONO (igual que segOwnership); en
 *    recompradores puede haber ambigüedad → se toma el pedido con movimiento
 *    más reciente.
 *  - `nuevasHoy` y `responseMs` usan `last_movement_at` (updated_at de Dropi)
 *    como proxy de "cuándo entró la novedad"; no hay timestamp exacto sin
 *    backend.
 */
export function useNovedadesSeguimiento(): NovedadesSeguimientoData {
  const { activeStoreId } = useStore();
  const [range, setRange] = useState<SeguimientoRange>('today');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(EMPTY);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!activeStoreId) {
      setData(EMPTY);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    const today = bogotaToday();
    const rangeStart = bogotaDateNDaysAgo(today, RANGE_DAYS[range]);

    try {
      // 1) Marcas (touchpoints NOVEDAD:%), 2) pendientes en cola, 3) roster.
      const [tpRes, pendRes, memberRes] = await Promise.all([
        supabase
          .from('touchpoints')
          .select('phone, action, operator_id, action_date, created_at')
          .eq('store_id', activeStoreId)
          .ilike('action', 'NOVEDAD:%')
          .gte('action_date', rangeStart)
          .order('created_at', { ascending: false }),
        supabase
          .from('orders')
          .select('id, phone, novedad, last_movement_at')
          .eq('store_id', activeStoreId)
          .or(NOVEDAD_QUEUE_FILTER)
          .eq('novedad_sol', false),
        supabase
          .from('store_members')
          .select('user_id')
          .eq('store_id', activeStoreId),
      ]);

      if (seq !== seqRef.current) return; // una carga más nueva ganó

      const tps = (tpRes.data ?? []).filter((t) => parseNovedadAction(t.action).tipo != null);
      const pend = (pendRes.data ?? []) as Pick<OrderLite, 'id' | 'phone' | 'novedad' | 'last_movement_at'>[];
      const memberIds = (memberRes.data ?? []).map((m) => m.user_id as string);

      // Teléfonos a enriquecer (de las marcas).
      const phones = Array.from(new Set(tps.map((t) => t.phone))).slice(0, MAX_PHONES);

      // 4) Órdenes de esos teléfonos (estado real, novedad, valor, etc.).
      const orderRes = phones.length
        ? await supabase
            .from('orders')
            .select('id, phone, estado, novedad, last_movement_at, valor, transportadora, nombre')
            .eq('store_id', activeStoreId)
            .in('phone', phones)
        : { data: [] as OrderLite[] };

      // 5) Nombres del roster + operadores que marcaron.
      const operatorIds = Array.from(
        new Set([...memberIds, ...tps.map((t) => t.operator_id as string)]),
      );
      const profRes = operatorIds.length
        ? await supabase.from('profiles').select('user_id, display_name').in('user_id', operatorIds)
        : { data: [] as { user_id: string; display_name: string }[] };

      if (seq !== seqRef.current) return;

      const nameByUser = new Map((profRes.data ?? []).map((p) => [p.user_id, p.display_name]));
      const memberSet = new Set(memberIds);

      // phone → mejor orden (movimiento más reciente).
      const orders = (orderRes.data ?? []) as OrderLite[];
      const bestByPhone = new Map<string, OrderLite>();
      for (const o of orders) {
        const prev = bestByPhone.get(o.phone);
        if (!prev) { bestByPhone.set(o.phone, o); continue; }
        const a = o.last_movement_at ? Date.parse(o.last_movement_at) : 0;
        const b = prev.last_movement_at ? Date.parse(prev.last_movement_at) : 0;
        if (a >= b) bestByPhone.set(o.phone, o);
      }

      // Filas de gestión enriquecidas.
      const gestiones: NovedadGestionRow[] = tps.map((t) => {
        const parsed = parseNovedadAction(t.action);
        const ord = bestByPhone.get(t.phone);
        const markedMs = t.created_at ? Date.parse(t.created_at) : NaN;
        const lmMs = ord?.last_movement_at ? Date.parse(ord.last_movement_at) : NaN;
        const responseMs =
          isFinite(markedMs) && isFinite(lmMs) && markedMs - lmMs >= 0 ? markedMs - lmMs : null;
        return {
          phone: t.phone,
          tipo: parsed.tipo as NovedadResultTipo,
          nota: parsed.nota,
          operatorId: t.operator_id as string,
          operatorName: nameByUser.get(t.operator_id as string) || 'Operadora',
          actionDate: t.action_date as string,
          markedAt: (t.created_at as string) ?? null,
          nombre: ord?.nombre ?? null,
          novedad: ord?.novedad ?? null,
          transportadora: ord?.transportadora ?? null,
          valor: ord?.valor ?? null,
          estadoActual: ord?.estado ?? null,
          outcome: classifyDeliveryOutcome(ord?.estado),
          responseMs,
        };
      });

      // Cobertura por operadora (roster ∪ quienes marcaron).
      const covByOp = new Map<string, OperatorCoverage>();
      const ensureOp = (id: string): OperatorCoverage => {
        let c = covByOp.get(id);
        if (!c) {
          c = {
            operatorId: id,
            name: nameByUser.get(id) || 'Operadora',
            isMember: memberSet.has(id),
            resuelta: 0, devolucion: 0, sinRespuesta: 0, total: 0, hoy: 0,
          };
          covByOp.set(id, c);
        }
        return c;
      };
      memberIds.forEach(ensureOp); // miembros aparecen aunque marquen 0
      for (const g of gestiones) {
        const c = ensureOp(g.operatorId);
        c.total += 1;
        if (g.tipo === 'resuelta') c.resuelta += 1;
        else if (g.tipo === 'devolucion') c.devolucion += 1;
        else c.sinRespuesta += 1;
        if (g.actionDate === today) c.hoy += 1;
      }
      const porOperadora = Array.from(covByOp.values()).sort(
        (a, b) => a.total - b.total || a.name.localeCompare(b.name),
      );

      // Totales de resultados.
      let resueltas = 0, devoluciones = 0, sinRespuesta = 0;
      let entregadasDeResueltas = 0, resueltasConOutcome = 0;
      let respSum = 0, respN = 0;
      let gestionadasHoy = 0;
      for (const g of gestiones) {
        if (g.tipo === 'resuelta') {
          resueltas += 1;
          if (g.estadoActual) {
            resueltasConOutcome += 1;
            if (g.outcome === 'entregada') entregadasDeResueltas += 1;
          }
        } else if (g.tipo === 'devolucion') devoluciones += 1;
        else sinRespuesta += 1;
        if (g.responseMs != null) { respSum += g.responseMs; respN += 1; }
        if (g.actionDate === today) gestionadasHoy += 1;
      }
      const cerradas = resueltas + devoluciones;
      const tasaDevolucion = cerradas > 0 ? devoluciones / cerradas : null;
      const tiempoRespuestaPromMs = respN > 0 ? Math.round(respSum / respN) : null;

      // Inflow aprox de hoy: pendientes movidos hoy + cerradas hoy.
      const pendientesHoy = pend.filter(
        (p) => p.last_movement_at && p.last_movement_at.slice(0, 10) === today,
      ).length;
      const cerradasHoy = gestiones.filter(
        (g) => g.actionDate === today && g.tipo !== 'sin_respuesta',
      ).length;

      // Ranking de novedades más frecuentes (órdenes únicas: pendientes ∪
      // órdenes de las marcas, deduplicadas por id, solo con novedad).
      const freq = new Map<string, NovedadFrequency>();
      const seenOrder = new Set<string>();
      const addFreq = (id: string | null, novedad: string | null) => {
        if (id) { if (seenOrder.has(id)) return; seenOrder.add(id); }
        if (!novedad || !novedad.trim()) return;
        const key = novedadGroupKey(novedad);
        const cur = freq.get(key);
        if (cur) cur.count += 1;
        else freq.set(key, { label: normalizeNovedadLabel(novedad), count: 1 });
      };
      pend.forEach((p) => addFreq(p.id, p.novedad));
      orders.forEach((o) => { if (o.novedad && o.novedad.trim()) addFreq(o.id, o.novedad); });
      const frecuentes = Array.from(freq.values()).sort((a, b) => b.count - a.count).slice(0, 8);

      setData({
        pendientes: pend.length,
        nuevasHoy: pendientesHoy + cerradasHoy,
        gestionadasHoy,
        gestionadasRango: gestiones.length,
        porOperadora,
        resueltas,
        devoluciones,
        sinRespuesta,
        tasaDevolucion,
        entregadasDeResueltas,
        resueltasConOutcome,
        tiempoRespuestaPromMs,
        gestiones,
        frecuentes,
      });
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [activeStoreId, range]);

  useEffect(() => { void load(); }, [load]);

  return { loading, range, setRange, refresh: () => void load(), ...data };
}
