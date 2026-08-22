import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { bogotaToday } from '@/lib/utils';
import { bogotaDateNDaysAgo } from '@/lib/novedadGestion';
import { summarizeRootCause, RootCauseRow, RootCauseSummary } from '@/lib/novedadRootCause';

/**
 * Rango PROPIO, no el de la cola de novedades.
 *
 * La causa raíz topeaba en 30 días porque reusaba `SeguimientoRange`, y con
 * ese tope la auditoría de julio en Ecuador —la que encontró Cuenca al 21%—
 * NO se podía reproducir dentro de Guardian: había que salir a consultar la
 * base a mano. Un análisis de devoluciones que no alcanza el mes pasado no
 * sirve para decidir nada; las devoluciones tardan semanas en llegar.
 */
export type RootCauseRange = 'today' | '7d' | '30d' | '90d';

const RANGE_DAYS: Record<RootCauseRange, number> = { today: 0, '7d': 6, '30d': 29, '90d': 89 };
const ROW_CAP = 5000;

const EMPTY: RootCauseSummary = {
  totalDevoluciones: 0, evitables: 0, pctEvitable: null,
  valorPerdidoTotal: 0, valorPerdidoEvitable: 0,
  conConfirmador: 0, sinConfirmador: 0,
  porReason: { semaforo: 0, direccion: 0, pickup: 0 },
  porOperadora: [], porCategoria: [], porCiudad: [],
};

/**
 * Estados de la lectura de causa raíz:
 *  - ok        → datos cargados
 *  - forbidden → operador sin permiso (la RPC tiró 42501)
 *  - not_ready → la migración `novedades_root_cause` aún NO se aplicó en la DB
 *  - error     → cualquier otro fallo
 */
export type RootCauseStatus = 'ok' | 'forbidden' | 'not_ready' | 'error';

export interface NovedadRootCauseData {
  loading: boolean;
  status: RootCauseStatus;
  range: RootCauseRange;
  setRange: (r: RootCauseRange) => void;
  refresh: () => void;
  summary: RootCauseSummary;
  /** true si la RPC llegó al tope de filas (resultado parcial). */
  partial: boolean;
}

function mapRow(d: Record<string, unknown>): RootCauseRow {
  return {
    orderId: d.order_id as string,
    novedad: (d.novedad as string) ?? null,
    validationDecision: (d.validation_decision as string) ?? null,
    addressKind: (d.address_kind as string) ?? null,
    valor: (d.valor as number) ?? null,
    transportadora: (d.transportadora as string) ?? null,
    ciudad: (d.ciudad as string) ?? null,
    confirmerId: (d.confirmer_id as string) ?? null,
    confirmerName: (d.confirmer_name as string) ?? null,
    tieneNovedad: !!d.tiene_novedad,
  };
}

/**
 * Lee la RPC `novedades_root_cause` (devoluciones del período + semáforo +
 * confirmador) y la resume con la capa pura. RESILIENTE a la migración pendiente:
 * si la RPC todavía no existe en la DB, NO rompe la pantalla — devuelve estado
 * `not_ready` para que la UI muestre un cartel de "pendiente de activar".
 */
export function useNovedadRootCause(): NovedadRootCauseData {
  const { activeStoreId } = useStore();
  const [range, setRange] = useState<RootCauseRange>('30d');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<RootCauseStatus>('ok');
  const [summary, setSummary] = useState<RootCauseSummary>(EMPTY);
  const [partial, setPartial] = useState(false);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!activeStoreId) { setSummary(EMPTY); setStatus('ok'); return; }
    const seq = ++seqRef.current;
    setLoading(true);
    const today = bogotaToday();
    const from = bogotaDateNDaysAgo(today, RANGE_DAYS[range]);
    try {
      // RPC nueva: la migración se aplica aparte; tipamos laxo para no romper el build.
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: Record<string, unknown>[] | null; error: unknown }>)(
        'novedades_root_cause', { p_from: from, p_to: today },
      );
      if (seq !== seqRef.current) return;
      if (error) {
        const code = (error as { code?: string }).code;
        const msg = (error as { message?: string }).message || '';
        if (code === '42501' || /no autorizado/i.test(msg)) setStatus('forbidden');
        else if (code === 'PGRST202' || /does not exist|could not find|schema cache/i.test(msg)) setStatus('not_ready');
        else setStatus('error');
        setSummary(EMPTY); setPartial(false);
        return;
      }
      const rows = (data ?? []).map(mapRow);
      setSummary(summarizeRootCause(rows));
      setPartial(rows.length >= ROW_CAP);
      setStatus('ok');
    } catch {
      if (seq === seqRef.current) { setStatus('error'); setSummary(EMPTY); setPartial(false); }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [activeStoreId, range]);

  useEffect(() => { void load(); }, [load]);

  return { loading, status, range, setRange, refresh: () => void load(), summary, partial };
}
