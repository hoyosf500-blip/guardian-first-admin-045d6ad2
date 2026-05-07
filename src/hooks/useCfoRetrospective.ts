import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// Hooks de la "Bitácora mensual" en /cfo. Una fila por mes con:
//   - retrospectiva escrita (fugas/aciertos/lecciones/decisiones)
//   - snapshot inamovible de los números (diagnostico_auto)
// Admin-only via RLS de la tabla cfo_monthly_retrospective.

export type DecisionStatus = 'pendiente' | 'hecho' | 'abandonado';

export interface Decision {
  accion: string;
  deadline: string | null;       // 'YYYY-MM-DD'
  status: DecisionStatus;
}

export interface RetroDiagnostico {
  year_month?: string;
  from_date?: string;
  to_date?: string;
  snapshot_at?: string;
  ingresos?: number | null;
  cogs?: number | null;
  utilidad_bruta?: number | null;
  flete_entregadas?: number | null;
  perdida_devoluciones?: number | null;
  total_ordenes?: number | null;
  entregados?: number | null;
  devueltos?: number | null;
  tasa_entrega?: number | null;
  tasa_devolucion?: number | null;
  wallet_entradas?: number | null;
  wallet_salidas?: number | null;
  wallet_neto?: number | null;
  ads_meta?: number | null;
  ads_tiktok?: number | null;
  ads_total?: number | null;
  tc_debt_usd?: number | null;
  tc_debt_cop?: number | null;
}

export interface RetrospectiveRow {
  id: string;
  year_month: string;
  fugas: string[];
  aciertos: string[];
  lecciones: string | null;
  decisiones: Decision[];
  diagnostico_auto: RetroDiagnostico | null;
  diagnostico_at: string | null;
  notas: string | null;
  created_at: string;
  updated_at: string;
}

const VALID_STATUS: DecisionStatus[] = ['pendiente', 'hecho', 'abandonado'];

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function asDecisionArray(v: unknown): Decision[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((raw): Decision | null => {
      if (!raw || typeof raw !== 'object') return null;
      const o = raw as Record<string, unknown>;
      const accion = typeof o.accion === 'string' ? o.accion : '';
      if (!accion) return null;
      const status = typeof o.status === 'string' && VALID_STATUS.includes(o.status as DecisionStatus)
        ? (o.status as DecisionStatus)
        : 'pendiente';
      const deadline = typeof o.deadline === 'string' && o.deadline.length > 0 ? o.deadline : null;
      return { accion, deadline, status };
    })
    .filter((d): d is Decision => d !== null);
}

function parseRow(raw: unknown): RetrospectiveRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const ym = typeof o.year_month === 'string' ? o.year_month : '';
  if (!ym) return null;
  return {
    id: String(o.id ?? ''),
    year_month: ym,
    fugas: asStringArray(o.fugas),
    aciertos: asStringArray(o.aciertos),
    lecciones: typeof o.lecciones === 'string' ? o.lecciones : null,
    decisiones: asDecisionArray(o.decisiones),
    diagnostico_auto: (o.diagnostico_auto && typeof o.diagnostico_auto === 'object')
      ? (o.diagnostico_auto as RetroDiagnostico)
      : null,
    diagnostico_at: typeof o.diagnostico_at === 'string' ? o.diagnostico_at : null,
    notas: typeof o.notas === 'string' ? o.notas : null,
    created_at: String(o.created_at ?? ''),
    updated_at: String(o.updated_at ?? ''),
  };
}

// .bind(supabase): obligatorio. `supabase.rpc` es un método cuyo `this`
// se pierde al desreferenciarlo. Sin bind, supabase-js explota con
// "Cannot read properties of undefined (reading 'rest')". El cast solo
// ajusta el tipado para RPCs no incluidas en types.ts auto-generado.
function rpc() {
  return supabase.rpc.bind(supabase) as unknown as (
    fn: string, args?: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
}

// ─────────────────────────────────────────────────────────────────
// list — todas las retrospectivas (orden desc por mes)
// ─────────────────────────────────────────────────────────────────
export function useCfoRetrospectives() {
  return useQuery<RetrospectiveRow[]>({
    queryKey: ['cfo-retrospectives'],
    queryFn: async () => {
      const { data, error } = await rpc()('list_cfo_retrospectives');
      if (error) throw new Error(error.message || 'Error listando retrospectivas');
      const rows = Array.isArray(data) ? data : [];
      return rows
        .map(parseRow)
        .filter((r): r is RetrospectiveRow => r !== null);
    },
    staleTime: 30_000,
  });
}

// ─────────────────────────────────────────────────────────────────
// upsert — crea/actualiza la retrospectiva del mes
// ─────────────────────────────────────────────────────────────────
export interface UpsertRetroParams {
  year_month: string;
  fugas: string[];
  aciertos: string[];
  lecciones: string;
  decisiones: Decision[];
  notas: string;
}

export function useUpsertCfoRetrospective() {
  const qc = useQueryClient();
  return useMutation<RetrospectiveRow, Error, UpsertRetroParams>({
    mutationFn: async (params) => {
      const { data, error } = await rpc()('upsert_cfo_retrospective', {
        p_year_month: params.year_month,
        p_fugas: params.fugas,
        p_aciertos: params.aciertos,
        p_lecciones: params.lecciones,
        p_decisiones: params.decisiones,
        p_notas: params.notas,
      });
      if (error) throw new Error(error.message || 'Error guardando retrospectiva');
      const row = parseRow(data);
      if (!row) throw new Error('Respuesta inesperada');
      return row;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cfo-retrospectives'] });
    },
  });
}

// ─────────────────────────────────────────────────────────────────
// snapshot — congela los números del mes en diagnostico_auto
// ─────────────────────────────────────────────────────────────────
export function useSnapshotCfoDiagnostico() {
  const qc = useQueryClient();
  return useMutation<RetrospectiveRow, Error, string>({
    mutationFn: async (yearMonth: string) => {
      const { data, error } = await rpc()('snapshot_cfo_diagnostico', {
        p_year_month: yearMonth,
      });
      if (error) throw new Error(error.message || 'Error capturando diagnóstico');
      const row = parseRow(data);
      if (!row) throw new Error('Respuesta inesperada');
      return row;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cfo-retrospectives'] });
    },
  });
}
