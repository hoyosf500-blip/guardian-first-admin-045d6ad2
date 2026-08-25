import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { bogotaToday } from '@/lib/utils';
import { bogotaDateNDaysAgo } from '@/lib/novedadGestion';
import type { RootCauseRange } from '@/hooks/useNovedadRootCause';
import {
  resumirDevolucionSeguimiento,
  type DevolucionSeguimientoResumen,
  type DevueltoLite,
  type SegTouchLite,
} from '@/lib/devolucionSeguimiento';

/**
 * Atribución de las devoluciones al lado de SEGUIMIENTO: quién les hizo
 * seguimiento y cuántas no tocó nadie. Client-side a propósito (se ve al
 * publicar, sin esperar migración; misma filosofía que los cálculos del CFO).
 *
 * Dos consultas store-scoped:
 *  1. pedidos DEVUELTOS del período (por fecha de creación) → phone + valor.
 *  2. touchpoints SEG en una ventana MÁS ANCHA (el rango + 90 días hacia atrás),
 *     porque el seguimiento ocurre semanas ANTES de que la devolución llegue;
 *     mirar solo el rango dejaría casi todo como "sin gestión".
 * El cruce (por teléfono) vive en la capa pura `devolucionSeguimiento`.
 */

const RANGE_DAYS: Record<RootCauseRange, number> = { today: 0, '7d': 6, '30d': 29, '90d': 89 };
const DEVOLUCION_ESTADOS = ['DEVOLUCION', 'DEVOLUCION EN TRANSITO'];
const PAGE = 1000;
const MAX_PAGES = 12; // tope defensivo: hasta 12.000 touchpoints SEG por corrida.

export type DevSegStatus = 'ok' | 'error';

const EMPTY: DevolucionSeguimientoResumen = {
  total: 0, valorTotal: 0, sinGestionSeg: 0, valorSinGestion: 0, porGestor: [],
};

export interface DevolucionSeguimientoData {
  loading: boolean;
  status: DevSegStatus;
  resumen: DevolucionSeguimientoResumen;
  /** true si se llegó al tope de páginas de touchpoints (resultado parcial). */
  partial: boolean;
}

export function useDevolucionSeguimiento(
  range: RootCauseRange,
  adminIds: string[],
): DevolucionSeguimientoData {
  const { activeStoreId } = useStore();
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<DevSegStatus>('ok');
  const [resumen, setResumen] = useState<DevolucionSeguimientoResumen>(EMPTY);
  const [partial, setPartial] = useState(false);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!activeStoreId) { setResumen(EMPTY); setStatus('ok'); setLoading(false); return; }
    const seq = ++seqRef.current;
    setLoading(true);
    const today = bogotaToday();
    const from = bogotaDateNDaysAgo(today, RANGE_DAYS[range]);
    // Ventana de seguimiento: el rango + 90 días hacia atrás (el seguimiento
    // pasó antes de que la devolución arribara).
    const segFrom = bogotaDateNDaysAgo(today, RANGE_DAYS[range] + 90);
    const segFromIso = new Date(`${segFrom}T00:00:00-05:00`).toISOString();

    try {
      // 1. Devueltos del período por fecha de creación.
      const { data: devData, error: devErr } = await supabase
        .from('orders')
        .select('phone, valor')
        .eq('store_id', activeStoreId)
        .in('estado', DEVOLUCION_ESTADOS)
        .gte('fecha', from)
        .limit(10000);
      if (seq !== seqRef.current) return;
      if (devErr) { setStatus('error'); setResumen(EMPTY); setPartial(false); return; }

      // 2. Touchpoints SEG paginados en la ventana ancha.
      const segTouch: SegTouchLite[] = [];
      let hitCap = false;
      for (let p = 0; p < MAX_PAGES; p++) {
        const { data: tpData, error: tpErr } = await supabase
          .from('touchpoints')
          .select('phone, operator_id')
          .eq('store_id', activeStoreId)
          .ilike('action', 'SEG:%')
          .gte('created_at', segFromIso)
          .order('created_at', { ascending: false })
          .range(p * PAGE, p * PAGE + PAGE - 1);
        if (seq !== seqRef.current) return;
        if (tpErr) { setStatus('error'); setResumen(EMPTY); setPartial(false); return; }
        const chunk = (tpData ?? []) as SegTouchLite[];
        segTouch.push(...chunk);
        if (chunk.length < PAGE) break;
        if (p === MAX_PAGES - 1) hitCap = true;
      }

      const devueltos = (devData ?? []) as DevueltoLite[];
      setResumen(resumirDevolucionSeguimiento(devueltos, segTouch, adminIds));
      setPartial(hitCap);
      setStatus('ok');
    } catch {
      if (seq === seqRef.current) { setStatus('error'); setResumen(EMPTY); setPartial(false); }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [activeStoreId, range, adminIds]);

  useEffect(() => { void load(); }, [load]);

  return { loading, status, resumen, partial };
}
