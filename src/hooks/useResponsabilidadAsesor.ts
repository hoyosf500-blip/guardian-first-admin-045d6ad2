import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { bogotaToday } from '@/lib/utils';
import { bogotaDateNDaysAgo } from '@/lib/novedadGestion';
import { summarizeRootCause, type RootCauseRow } from '@/lib/novedadRootCause';
import {
  construirScores,
  type AsesorScore, type AsesorScoreInput,
} from '@/lib/responsabilidadAsesor';

/**
 * Junta en UNA fila por asesor: esfuerzo (gestionados del RPC de productividad),
 * calidad (devoluciones + evitables de novedades_root_cause) y disciplina de
 * validación (% despachado en rojo, del sello en `orders`). El merge y el semáforo
 * viven en la capa pura `responsabilidadAsesor`.
 *
 * Client-side a propósito (se ve al publicar, sin esperar migración). Recibe las
 * filas de productividad que el dashboard YA cargó (para no re-consultar esa RPC).
 */

type Range = 'today' | '7d' | '30d';
const RANGE_DAYS: Record<Range, number> = { today: 0, '7d': 6, '30d': 29 };
const SELLO_MALO = new Set(['red', 'yellow']);
const CONF_PAGE = 1000;
const CONF_MAX_PAGES = 10;

export interface ProdRowLite {
  operator_id: string;
  display_name: string;
  confirmados: number;
  total_atendidos: number;
}

export type RespStatus = 'ok' | 'error';

export interface ResponsabilidadAsesorData {
  loading: boolean;
  status: RespStatus;
  scores: AsesorScore[];
  metaGestiones: number;
  /** true si el sello tiene poca data todavía (columna % en rojo aún escasa). */
  selloEscaso: boolean;
}

export function useResponsabilidadAsesor(
  range: Range,
  prodRows: ProdRowLite[],
  metaGestiones: number,
): ResponsabilidadAsesorData {
  const { activeStoreId } = useStore();
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<RespStatus>('ok');
  const [scores, setScores] = useState<AsesorScore[]>([]);
  const [selloEscaso, setSelloEscaso] = useState(false);
  const seqRef = useRef(0);

  // `prodRows` es una referencia nueva en cada render del padre (que re-renderiza
  // seguido por el realtime). Para no re-consultar en cada frame, la carga depende
  // de una FIRMA estable (ids + conteos) y lee las filas por ref.
  const prodRef = useRef(prodRows);
  prodRef.current = prodRows;
  const prodSig = prodRows
    .map((r) => `${r.operator_id}:${r.confirmados}:${r.total_atendidos}`)
    .join('|');

  const load = useCallback(async () => {
    if (!activeStoreId) { setScores([]); setStatus('ok'); setLoading(false); return; }
    const seq = ++seqRef.current;
    setLoading(true);
    const today = bogotaToday();
    const from = bogotaDateNDaysAgo(today, RANGE_DAYS[range]);

    try {
      // 1. Devoluciones por confirmador (misma RPC que la causa raíz).
      const { data: devData, error: devErr } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: Record<string, unknown>[] | null; error: unknown }>)(
        'novedades_root_cause', { p_from: from, p_to: today },
      );
      if (seq !== seqRef.current) return;
      // La causa raíz puede fallar por permiso/migración; degradamos a solo-esfuerzo.
      const devRows: RootCauseRow[] = (devErr ? [] : (devData ?? [])).map((d) => ({
        orderId: d.order_id as string,
        novedad: (d.novedad as string) ?? null,
        validationDecision: (d.validation_decision as string) ?? null,
        addressKind: (d.address_kind as string) ?? null,
        validacionAlDespachar: (d.validacion_al_despachar as string) ?? null,
        addressKindAlDespachar: (d.address_kind_al_despachar as string) ?? null,
        valor: (d.valor as number) ?? null,
        transportadora: (d.transportadora as string) ?? null,
        ciudad: (d.ciudad as string) ?? null,
        confirmerId: (d.confirmer_id as string) ?? null,
        confirmerName: (d.confirmer_name as string) ?? null,
        tieneNovedad: !!d.tiene_novedad,
      }));
      const devResumen = summarizeRootCause(devRows);
      const devPorOp = new Map<string, { devoluciones: number; evitables: number }>();
      for (const o of devResumen.porOperadora) {
        if (o.operatorId) devPorOp.set(o.operatorId, { devoluciones: o.devoluciones, evitables: o.evitables });
      }

      // 2. Sello por confirmador. Q_sello: pedidos con sello (desde 22-ago, pocos
      //    aún). Q_conf: quién confirmó cada order_id.
      const { data: selloData, error: selloErr } = await supabase
        .from('orders')
        .select('id, validacion_al_despachar')
        .eq('store_id', activeStoreId)
        .gte('fecha', from)
        .not('validacion_al_despachar', 'is', null)
        .limit(10000);
      if (seq !== seqRef.current) return;

      // order_id → operator del confirmador (result='conf').
      const confDeOrder = new Map<string, string>();
      if (!selloErr && (selloData?.length ?? 0) > 0) {
        for (let p = 0; p < CONF_MAX_PAGES; p++) {
          const { data: confData, error: confErr } = await supabase
            .from('order_results')
            .select('order_id, operator_id')
            .eq('store_id', activeStoreId)
            .eq('module', 'confirmar')
            .eq('result', 'conf')
            .gte('result_date', from)
            .order('created_at', { ascending: false })
            .range(p * CONF_PAGE, p * CONF_PAGE + CONF_PAGE - 1);
          if (seq !== seqRef.current) return;
          if (confErr) break;
          const chunk = confData ?? [];
          for (const c of chunk as { order_id: string; operator_id: string }[]) {
            if (c.order_id && c.operator_id && !confDeOrder.has(c.order_id)) {
              confDeOrder.set(c.order_id, c.operator_id);
            }
          }
          if (chunk.length < CONF_PAGE) break;
        }
      }

      const selloPorOp = new Map<string, { conSello: number; enRojo: number }>();
      let totalConSello = 0;
      for (const row of (selloErr ? [] : (selloData ?? [])) as { id: string; validacion_al_despachar: string }[]) {
        const opId = confDeOrder.get(row.id);
        if (!opId) continue;
        totalConSello += 1;
        let acc = selloPorOp.get(opId);
        if (!acc) { acc = { conSello: 0, enRojo: 0 }; selloPorOp.set(opId, acc); }
        acc.conSello += 1;
        if (SELLO_MALO.has(String(row.validacion_al_despachar))) acc.enRojo += 1;
      }

      // 3. Merge sobre las filas de productividad (esfuerzo/volumen).
      const inputs: AsesorScoreInput[] = prodRef.current.map((r) => {
        const dev = devPorOp.get(r.operator_id);
        const sel = selloPorOp.get(r.operator_id);
        return {
          operatorId: r.operator_id,
          name: r.display_name || 'Asesora',
          gestionados: Number(r.total_atendidos) || 0,
          confirmados: Number(r.confirmados) || 0,
          devoluciones: dev?.devoluciones ?? 0,
          evitables: dev?.evitables ?? 0,
          despachadosConSello: sel?.conSello ?? 0,
          despachadosEnRojo: sel?.enRojo ?? 0,
        };
      });

      if (seq !== seqRef.current) return;
      setScores(construirScores(inputs, metaGestiones));
      setSelloEscaso(totalConSello < 20);
      setStatus('ok');
    } catch {
      if (seq === seqRef.current) { setStatus('error'); setScores([]); }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStoreId, range, prodSig, metaGestiones]);

  useEffect(() => { void load(); }, [load]);

  return { loading, status, scores, metaGestiones, selloEscaso };
}
