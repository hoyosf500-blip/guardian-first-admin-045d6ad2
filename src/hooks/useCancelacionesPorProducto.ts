import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import {
  resumirPorProducto,
  EMPTY_POR_PRODUCTO,
  type ProductoCrudo,
  type ResumenPorProducto,
} from '@/lib/cancelacionesPorProducto';

/**
 * Lee la RPC `cancelaciones_por_producto` (conteos por producto) y la resume
 * con la capa pura.
 *
 * Molde: `useCancelacionesAnalisis` — mismo `ok|forbidden|not_ready|error`,
 * mismo `seqRef` contra respuestas fuera de orden, mismo cast laxo de
 * `supabase.rpc` para no depender de los tipos generados.
 *
 * RESILIENTE A LA MIGRACIÓN PENDIENTE: si la RPC todavía no existe devuelve
 * `not_ready` y la sección se dibuja como "falta activar". **No dibuja ceros**:
 * un ranking de cancelación en cero se lee como "no cancelás nada", que es peor
 * que no tener la sección.
 */
export type PorProductoStatus = 'ok' | 'forbidden' | 'not_ready' | 'error';

export interface PorProductoData {
  loading: boolean;
  status: PorProductoStatus;
  resumen: ResumenPorProducto;
  refresh: () => void;
}

function mapRow(d: Record<string, unknown>): ProductoCrudo {
  const n = (v: unknown) => Number(v ?? 0);
  return {
    producto: String(d.producto ?? '(sin producto)'),
    generados: n(d.generados),
    cancelados: n(d.cancelados),
    entregados: n(d.entregados),
    devueltos: n(d.devueltos),
    pendientes: n(d.pendientes),
    enCurso: n(d.en_curso),
    valorGenerado: n(d.valor_generado),
    valorCancelado: n(d.valor_cancelado),
  };
}

export function useCancelacionesPorProducto(
  filtros: { fromDate: string; toDate: string },
): PorProductoData {
  const { activeStoreId } = useStore();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<PorProductoStatus>('ok');
  const [resumen, setResumen] = useState<ResumenPorProducto>(EMPTY_POR_PRODUCTO);
  const seqRef = useRef(0);

  const { fromDate, toDate } = filtros;

  const load = useCallback(async () => {
    // Sin tienda activa (primer render) no se consulta: null significa
    // "todavía no sé cuál", no "todas".
    if (!activeStoreId || !fromDate || !toDate) {
      setResumen(EMPTY_POR_PRODUCTO); setStatus('ok');
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: Record<string, unknown>[] | null; error: unknown }>)(
        'cancelaciones_por_producto',
        { p_store_id: activeStoreId, p_desde: fromDate, p_hasta: toDate, p_limite: 300 },
      );
      if (seq !== seqRef.current) return;
      if (error) {
        const code = (error as { code?: string }).code;
        const msg = (error as { message?: string }).message || '';
        if (code === '42501' || /no autorizado|sin permiso/i.test(msg)) setStatus('forbidden');
        else if (code === 'PGRST202' || /does not exist|could not find|schema cache/i.test(msg)) setStatus('not_ready');
        else setStatus('error');
        setResumen(EMPTY_POR_PRODUCTO);
        return;
      }
      setResumen(resumirPorProducto((data ?? []).map(mapRow)));
      setStatus('ok');
    } catch {
      if (seq === seqRef.current) { setStatus('error'); setResumen(EMPTY_POR_PRODUCTO); }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [activeStoreId, fromDate, toDate]);

  useEffect(() => { void load(); }, [load]);

  return { loading, status, resumen, refresh: () => void load() };
}
