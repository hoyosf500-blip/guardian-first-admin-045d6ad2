import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { rangoDiaBogota } from '@/lib/diaBitacora';
import type { EventoPedido } from '@/lib/eventosPedido';

/**
 * Lo que hizo el equipo un día, en orden.
 *
 * ⛔ `estado` explícito, y `'cargando'` distinto de `'ok'` con la lista vacía.
 * Esta pantalla se va a usar para hablar con una persona sobre su trabajo: una
 * lista vacía mientras todavía no llegaron los datos se lee como **"no hizo
 * nada"**, y sobre eso se toman decisiones injustas. Es el mismo error que en
 * esta operación hizo que una pantalla afirmara "no hubo cancelaciones" sobre
 * un mes con 345.
 *
 * `not_ready` es su propio estado: la migración `order_events` puede no haberse
 * aplicado todavía (Lovable no las aplica solas). Eso NO es "no hizo nada" ni
 * "falló": es "esto todavía no está prendido", y se dice con esas palabras.
 */
export type EstadoBitacora = 'cargando' | 'ok' | 'not_ready' | 'error';

export interface FilaBitacora {
  id: string;
  operatorId: string;
  externalId: string | null;
  phone: string | null;
  evento: EventoPedido;
  detalle: Record<string, unknown>;
  msEnPantalla: number | null;
  createdAt: string;
}

/** El resumen del día de una persona. Todo se cuenta de las filas leídas. */
export interface ResumenAsesor {
  operatorId: string;
  abrio: number;
  gestiono: number;
  /** Pedidos que abrió y dejó SIN gestionar. El dato que no existía. */
  salto: number;
  llamo: number;
  escribio: number;
  /** Tiempo total con un pedido a la vista. `null` si nada se pudo medir. */
  msTotal: number | null;
  /** Cuántos cierres trajeron medición — el denominador honesto del promedio. */
  medidos: number;
}

/** Una página de PostgREST. Se lee hasta agotar. */
const PAGINA = 1000;
/**
 * ⛔ Tope de seguridad, y se DICE cuando se toca (4-sep-2026). La versión
 * anterior cortaba en 2.000 filas sin bandera y calculaba el resumen sobre el
 * pedazo: en "Todo el equipo" un día movido pasa de 2.000 antes del mediodía
 * (Novedades emite ~3 eventos por pedido visto), y como el orden es DESC lo
 * que se perdía era LA MAÑANA — la persona que trabajó temprano salía con
 * "pedidos abiertos 4". Es el mismo defecto de `EVENT_SCAN_LIMIT` que ya se
 * corrigió en `useLiveTeam`, reintroducido en la pantalla nueva.
 */
const TOPE = 10_000;

export function useBitacoraDia(storeId: string | null, ymd: string, operatorId: string | null) {
  const [filas, setFilas] = useState<FilaBitacora[]>([]);
  const [estado, setEstado] = useState<EstadoBitacora>('cargando');
  /** true = se tocó el TOPE y la lista (y el resumen) están INCOMPLETOS. */
  const [truncado, setTruncado] = useState(false);

  const cargar = useCallback(async () => {
    if (!storeId) { setFilas([]); setEstado('cargando'); return; }
    const rango = rangoDiaBogota(ymd);
    if (!rango) { setFilas([]); setEstado('error'); return; }
    setEstado('cargando');
    type Cruda = {
      id: string; operator_id: string; external_id: string | null; phone: string | null;
      evento: string; detalle: unknown; ms_en_pantalla: number | null; created_at: string;
    };
    const crudas: Cruda[] = [];
    let seTrunco = false;
    for (let desde = 0; ; desde += PAGINA) {
      let q = supabase
        .from('order_events')
        .select('id, operator_id, external_id, phone, evento, detalle, ms_en_pantalla, created_at')
        .eq('store_id', storeId)
        .gte('created_at', rango.desdeIso)
        .lt('created_at', rango.hastaIso)
        .order('created_at', { ascending: false })
        // Desempate estable: dos eventos en el mismo instante no pueden
        // cambiar de página entre una lectura y la siguiente.
        .order('id', { ascending: false })
        .range(desde, desde + PAGINA - 1);
      if (operatorId) q = q.eq('operator_id', operatorId);
      const { data, error } = await q;
      if (error) {
        const code = (error as { code?: string }).code;
        const msg = (error as { message?: string }).message || '';
        // 42P01 = la tabla no existe: la migración todavía no corrió.
        setEstado(code === '42P01' || /does not exist|relation/i.test(msg) ? 'not_ready' : 'error');
        setFilas([]);
        return;
      }
      const pagina = (data ?? []) as unknown as Cruda[];
      crudas.push(...pagina);
      if (pagina.length < PAGINA) break;
      if (crudas.length >= TOPE) { seTrunco = true; break; }
    }
    setTruncado(seTrunco);
    setFilas(crudas.map((r) => ({
      id: String(r.id),
      operatorId: String(r.operator_id),
      externalId: r.external_id,
      phone: r.phone,
      evento: r.evento as EventoPedido,
      detalle: (r.detalle && typeof r.detalle === 'object' ? r.detalle : {}) as Record<string, unknown>,
      msEnPantalla: r.ms_en_pantalla,
      createdAt: r.created_at,
    })));
    setEstado('ok');
  }, [storeId, ymd, operatorId]);

  useEffect(() => { void cargar(); }, [cargar]);

  const resumen = useMemo<ResumenAsesor[]>(() => {
    const por = new Map<string, ResumenAsesor>();
    for (const f of filas) {
      let r = por.get(f.operatorId);
      if (!r) {
        r = { operatorId: f.operatorId, abrio: 0, gestiono: 0, salto: 0, llamo: 0, escribio: 0, msTotal: null, medidos: 0 };
        por.set(f.operatorId, r);
      }
      if (f.evento === 'abrio') r.abrio += 1;
      if (f.evento === 'gestiono' || f.evento === 'marco' || f.evento === 'edito') r.gestiono += 1;
      if (f.evento === 'salto') r.salto += 1;
      if (f.evento === 'llamo') r.llamo += 1;
      if (f.evento === 'escribio') r.escribio += 1;
      // ⛔ Solo suma lo MEDIDO. Un cierre sin medición (se cerró la pestaña de
      // golpe) no aporta cero al total: no aporta nada, y por eso el promedio
      // se divide por `medidos` y no por la cantidad de pedidos.
      if ((f.evento === 'cerro' || f.evento === 'salto') && f.msEnPantalla != null) {
        r.msTotal = (r.msTotal ?? 0) + f.msEnPantalla;
        r.medidos += 1;
      }
    }
    return [...por.values()].sort((a, b) => (b.abrio - a.abrio) || (b.gestiono - a.gestiono));
  }, [filas]);

  return { filas, resumen, estado, truncado, recargar: cargar };
}

/** Promedio por pedido medido. `null` cuando no hay ni una medición: sin eso,
 *  la pantalla mostraría "0 s por pedido" sobre datos que nunca existieron. */
export function promedioPorPedido(r: ResumenAsesor): number | null {
  if (r.msTotal == null || r.medidos <= 0) return null;
  return Math.round(r.msTotal / r.medidos);
}
