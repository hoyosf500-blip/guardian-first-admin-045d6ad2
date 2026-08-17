import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import {
  summarizeCancelaciones,
  EMPTY_RESUMEN,
  type CancelacionRow,
  type CancelacionesResumen,
} from '@/lib/cancelacionesResumen';

/**
 * Lee la RPC `cancelaciones_analisis` (una fila cruda por pedido cancelado) y la
 * resume con la capa pura.
 *
 * RESILIENTE A LA MIGRACIÓN PENDIENTE (Lovable no las auto-aplica): si la RPC
 * todavía no existe, NO rompe la pantalla ni dibuja ceros — devuelve estado
 * `not_ready`. Un reporte de cancelaciones en cero se lee como "no cancelás
 * nada", que es peor que no tenerlo.
 *
 * Molde: useNovedadRootCause (mismo `ok|forbidden|not_ready|error`, mismo seqRef
 * contra respuestas fuera de orden, mismo cast laxo de `supabase.rpc` para no
 * depender de los tipos generados).
 */

/** Tope de filas del server (LEAST(...,5000) en la RPC). */
const ROW_CAP = 5000;

export type CancelacionesStatus = 'ok' | 'forbidden' | 'not_ready' | 'error';

export interface CancelacionesFiltros {
  fromDate: string;
  toDate: string;
}

export interface CancelacionesData {
  loading: boolean;
  status: CancelacionesStatus;
  resumen: CancelacionesResumen;
  /** Filas crudas, para la tabla de detalle y el CSV. */
  rows: CancelacionRow[];
  /** true si se llegó al tope del server (hay más de las que se ven). */
  partial: boolean;
  refresh: () => void;
}

function mapRow(d: Record<string, unknown>): CancelacionRow {
  return {
    orderId: d.order_id as string,
    externalId: (d.external_id as string) ?? null,
    fecha: (d.fecha as string) ?? null,
    estado: (d.estado as string) ?? null,
    valor: (d.valor as number) ?? null,
    producto: (d.producto as string) ?? null,
    ciudad: (d.ciudad as string) ?? null,
    operatorId: (d.operator_id as string) ?? null,
    operatorName: (d.operator_name as string) ?? null,
    origen: (d.origen as 'guardian' | 'externo') ?? 'externo',
    motivo: (d.motivo as string) ?? null,
    canceladoAt: (d.cancelado_at as string) ?? null,
    primerToqueAt: (d.primer_toque_at as string) ?? null,
    intentosPrevios: Number(d.intentos_previos ?? 0),
    intentosNoresp: Number(d.intentos_noresp ?? 0),
    contactosPrevios: Number(d.contactos_previos ?? 0),
    reagendas: Number(d.reagendas ?? 0),
  };
}

export function useCancelacionesAnalisis(filtros: CancelacionesFiltros): CancelacionesData {
  const { activeStoreId } = useStore();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<CancelacionesStatus>('ok');
  const [resumen, setResumen] = useState<CancelacionesResumen>(EMPTY_RESUMEN);
  const [rows, setRows] = useState<CancelacionRow[]>([]);
  const [partial, setPartial] = useState(false);
  const seqRef = useRef(0);

  const { fromDate, toDate } = filtros;

  const load = useCallback(async () => {
    // Sin tienda activa (primer render) no se consulta: null significa
    // "todavía no sé cuál", no "todas".
    if (!activeStoreId || !fromDate || !toDate) {
      setResumen(EMPTY_RESUMEN); setRows([]); setStatus('ok');
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: Record<string, unknown>[] | null; error: unknown }>)(
        'cancelaciones_analisis',
        // `p_limite` va EXPLÍCITO: el default de la RPC es 3000 y el chequeo de
        // truncado de acá compara contra ROW_CAP. Sin esto, un rango con 3000+
        // cancelaciones devolvía exactamente 3000 filas con `partial=false` —
        // truncado silencioso, justo lo que este reporte no puede hacer.
        { p_store_id: activeStoreId, p_desde: fromDate, p_hasta: toDate, p_limite: ROW_CAP },
      );
      if (seq !== seqRef.current) return;
      if (error) {
        const code = (error as { code?: string }).code;
        const msg = (error as { message?: string }).message || '';
        if (code === '42501' || /no autorizado|sin permiso/i.test(msg)) setStatus('forbidden');
        else if (code === 'PGRST202' || /does not exist|could not find|schema cache/i.test(msg)) setStatus('not_ready');
        else setStatus('error');
        setResumen(EMPTY_RESUMEN); setRows([]); setPartial(false);
        return;
      }
      const raw = data ?? [];
      const mapped = raw.map(mapRow);
      // `total_periodo` y `generados_periodo` vienen repetidos en cada fila (los
      // calcula la MISMA query, antes del LIMIT). Se leen de la primera: si no
      // hay filas, no hubo cancelaciones y no hay nada que denominar.
      const first = raw[0] as Record<string, unknown> | undefined;
      setRows(mapped);
      setResumen(summarizeCancelaciones(mapped, {
        generados: first ? Number(first.generados_periodo ?? 0) : null,
        totalPeriodo: first ? Number(first.total_periodo ?? 0) : 0,
      }));
      setPartial(mapped.length >= ROW_CAP);
      setStatus('ok');
    } catch {
      if (seq === seqRef.current) {
        setStatus('error'); setResumen(EMPTY_RESUMEN); setRows([]); setPartial(false);
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [activeStoreId, fromDate, toDate]);

  useEffect(() => { void load(); }, [load]);

  return { loading, status, resumen, rows, partial, refresh: () => void load() };
}
