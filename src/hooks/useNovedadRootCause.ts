import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { bogotaToday } from '@/lib/utils';
import { bogotaDateNDaysAgo } from '@/lib/novedadGestion';
import { summarizeRootCause, conTasaDevolucion, RootCauseRow, RootCauseSummary } from '@/lib/novedadRootCause';

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
    // El SELLO al despachar (migración 20260822180000). `evitableReasons` lo
    // prefiere sobre el valor mutable — pero mapRow no lo mapeaba, así que
    // llegaba siempre undefined y el ?? caía SIEMPRE al semáforo vivo: el sesgo
    // exacto que el sello vino a arreglar (los pedidos más gestionados pierden
    // la marca roja y el % evitable sale subestimado). Con la RPC vieja (sin
    // estas columnas) queda null y el comportamiento es el actual — para que el
    // sello VIAJE falta actualizar `novedades_root_cause` a devolverlas (pedir
    // pg_get_functiondef primero, REGLA #1).
    validacionAlDespachar: (d.validacion_al_despachar as string) ?? null,
    addressKindAlDespachar: (d.address_kind_al_despachar as string) ?? null,
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
  /**
   * ⛔ SE ESPERA EL SCOPE DEL SERVIDOR (4-sep-2026) — REGLA #1.
   *
   * `novedades_root_cause` resuelve la tienda EN EL SERVIDOR con
   * `_resolve_scope_store()` (migración 20260623160000) y su filtro es
   * `(v_store IS NULL OR store_id = v_store)`: con el scope sin resolver
   * devuelve TODAS las tiendas mezcladas. Este hook disparaba con
   * `[activeStoreId, range]`, o sea en el mismo instante del cambio de tienda,
   * cuando el UPDATE de `set_active_store` todavía viaja — y como no es
   * react-query, la invalidación de StoreContext tampoco lo alcanzaba. Un
   * admin que pasaba de Colombia a Ecuador leía las devoluciones y la plata del
   * país anterior bajo el rótulo del nuevo.
   *
   * El guardián `scopeDelServidorSeEspera` ya exigía esto en otros cinco
   * consumidores; este y `useResponsabilidadAsesor` se habían quedado afuera.
   */
  const { activeStoreId, scopeStoreId, scopeSynced } = useStore();
  const [range, setRange] = useState<RootCauseRange>('30d');
  // Arranca en TRUE: el efecto que dispara la carga corre después del primer
  // render, y con false ese primer frame pasaba los gates `!s.loading` — el
  // EmptyCard "No hay devoluciones" llegaba a pintarse antes de medir nada.
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<RootCauseStatus>('ok');
  const [summary, setSummary] = useState<RootCauseSummary>(EMPTY);
  const [partial, setPartial] = useState(false);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    // setLoading(false) explícito: `loading` ahora ARRANCA en true y esta rama
    // retorna sin pasar por el finally — sin esto, sin tienda activa la
    // pantalla quedaba "leyendo…" para siempre.
    if (!activeStoreId) { setSummary(EMPTY); setStatus('ok'); setLoading(false); return; }
    // Todavía no aterrizó el scope: no se pregunta. Y se distingue "esperando"
    // de "no llega" — si `scopeSynced` es false el UPDATE falló y hay que
    // decirlo en vez de dejar la pantalla girando para siempre.
    if (scopeStoreId !== activeStoreId) {
      setSummary(EMPTY);
      setStatus(scopeSynced ? 'ok' : 'error');
      setLoading(scopeSynced);
      return;
    }
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
      let resumen = summarizeRootCause(rows);

      // TASA justa (÷ confirmados): el denominador sale de
      // operator_productivity_stats, que ya existe (rangos today/7d/30d). Para
      // 90d no hay rango equivalente → la tasa queda null y se muestra "—", sin
      // inventar. Fallo de esta consulta NO tumba la causa raíz: se degrada a
      // solo-absolutos (la tasa es un extra, no el dato principal).
      const prodRange = range === '90d' ? null : range;
      if (prodRange) {
        try {
          const { data: prod } = await (supabase.rpc as unknown as (
            fn: string, args: Record<string, unknown>,
          ) => Promise<{ data: Record<string, unknown>[] | null; error: unknown }>)(
            'operator_productivity_stats', { p_range: prodRange },
          );
          if (seq !== seqRef.current) return;
          const map = new Map<string, number>();
          for (const p of prod ?? []) {
            const id = p.operator_id as string | undefined;
            const conf = Number(p.confirmados);
            if (id && Number.isFinite(conf)) map.set(id, conf);
          }
          if (map.size > 0) resumen = { ...resumen, porOperadora: conTasaDevolucion(resumen.porOperadora, map) };
        } catch { /* la tasa es opcional: sin ella, solo-absolutos */ }
      }

      setSummary(resumen);
      setPartial(rows.length >= ROW_CAP);
      setStatus('ok');
    } catch {
      if (seq === seqRef.current) { setStatus('error'); setSummary(EMPTY); setPartial(false); }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [activeStoreId, range, scopeStoreId, scopeSynced]);

  useEffect(() => { void load(); }, [load]);

  return { loading, status, range, setRange, refresh: () => void load(), summary, partial };
}
