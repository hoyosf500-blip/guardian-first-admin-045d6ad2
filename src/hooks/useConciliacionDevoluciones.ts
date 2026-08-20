import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import {
  conciliarDevoluciones,
  type CobroDevolucionRow,
  type ConciliacionDevoluciones,
} from '@/lib/conciliacionDevoluciones';

/**
 * Cruza lo que Dropi COBRA por devoluciones contra lo que Guardian VE como
 * devuelto (RPC `conciliacion_devoluciones_wallet`).
 *
 * RESILIENTE A LA MIGRACIÓN PENDIENTE (Lovable no las auto-aplica): si la RPC
 * no existe todavía devuelve `not_ready` y la tarjeta no se dibuja. Nunca ceros:
 * "0 devoluciones sin respaldo" es exactamente la afirmación que esta pantalla
 * existe para poder hacer con fundamento — dibujarla sin datos sería mentir con
 * la cara del que verificó.
 *
 * Molde: useCancelacionesAnalisis (mismo `ok|forbidden|not_ready|error`, mismo
 * seqRef contra respuestas fuera de orden, mismo cast laxo de `supabase.rpc`
 * para no depender de los tipos generados).
 */

/** Tope de filas del server (LEAST(...,5000) en la RPC). */
const ROW_CAP = 5000;

export type ConciliacionStatus = 'ok' | 'forbidden' | 'not_ready' | 'error';

export interface ConciliacionData {
  loading: boolean;
  status: ConciliacionStatus;
  resumen: ConciliacionDevoluciones | null;
  refresh: () => void;
}

export function useConciliacionDevoluciones(fromDate: string, toDate: string): ConciliacionData {
  const { activeStoreId } = useStore();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<ConciliacionStatus>('ok');
  const [resumen, setResumen] = useState<ConciliacionDevoluciones | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    // Sin tienda activa (primer render) no se consulta: null significa
    // "todavía no sé cuál", no "todas".
    if (!activeStoreId || !fromDate || !toDate) {
      setResumen(null);
      setStatus('ok');
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: Record<string, unknown>[] | null; error: unknown }>)(
        'conciliacion_devoluciones_wallet',
        // `p_limite` explícito: el default de la RPC es 3000 y el chequeo de
        // truncado compara contra ROW_CAP (misma lección que cancelaciones).
        { p_store_id: activeStoreId, p_desde: fromDate, p_hasta: toDate, p_limite: ROW_CAP },
      );
      if (seq !== seqRef.current) return;
      if (error) {
        const code = (error as { code?: string }).code;
        const msg = (error as { message?: string }).message || '';
        if (code === '42501' || /no autorizado|sin permiso/i.test(msg)) setStatus('forbidden');
        else if (code === 'PGRST202' || /does not exist|could not find|schema cache/i.test(msg)) setStatus('not_ready');
        else setStatus('error');
        setResumen(null);
        return;
      }
      setResumen(conciliarDevoluciones((data ?? []) as CobroDevolucionRow[]));
      setStatus('ok');
    } catch {
      if (seq === seqRef.current) { setStatus('error'); setResumen(null); }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [activeStoreId, fromDate, toDate]);

  useEffect(() => { void load(); }, [load]);

  return { loading, status, resumen, refresh: () => void load() };
}
