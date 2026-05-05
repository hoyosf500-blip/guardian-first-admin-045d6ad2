import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// Hooks del bloque "Deuda TC" en /cfo. Lee snapshots históricos de
// tarjetas de crédito (Amex *6109, Mastercard *9999) — uno por corte
// + uno opcional con estado actual entre cortes. Admin-only via RLS.

export type TcCard = 'amex_6109' | 'mc_9999';
export type TcSource = 'extracto_pdf' | 'consulta_movimientos' | 'manual' | 'banco_app';

export interface TcDebtSnapshot {
  id: string;
  tarjeta: TcCard;
  fecha_corte: string;     // 'YYYY-MM-DD'
  saldo_cop: number;
  saldo_usd: number;
  trm: number;
  cupo_cop: number;
  source: TcSource;
  notas: string | null;
  created_at: string;
  updated_at: string;
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }
  return 0;
}

function parseRow(raw: unknown): TcDebtSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const tarjeta = String(o.tarjeta ?? '');
  if (tarjeta !== 'amex_6109' && tarjeta !== 'mc_9999') return null;
  const source = String(o.source ?? 'manual');
  const validSources: TcSource[] = ['extracto_pdf', 'consulta_movimientos', 'manual', 'banco_app'];
  return {
    id: String(o.id ?? ''),
    tarjeta,
    fecha_corte: String(o.fecha_corte ?? ''),
    saldo_cop: toNumber(o.saldo_cop),
    saldo_usd: toNumber(o.saldo_usd),
    trm: toNumber(o.trm),
    cupo_cop: toNumber(o.cupo_cop),
    source: validSources.includes(source as TcSource) ? (source as TcSource) : 'manual',
    notas: typeof o.notas === 'string' ? o.notas : null,
    created_at: String(o.created_at ?? ''),
    updated_at: String(o.updated_at ?? ''),
  };
}

/** Trae todos los snapshots ordenados por fecha (más reciente primero). */
export function useTcDebtSnapshots() {
  return useQuery<TcDebtSnapshot[]>({
    queryKey: ['tc-debt-snapshots'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tc_debt_snapshots')
        .select('*')
        .order('fecha_corte', { ascending: false });
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      return rows.map(parseRow).filter((r): r is TcDebtSnapshot => r !== null);
    },
    staleTime: 5 * 60 * 1000,
  });
}

export interface UpsertTcDebtParams {
  tarjeta: TcCard;
  fecha_corte: string;     // 'YYYY-MM-DD'
  saldo_cop: number;
  saldo_usd: number;
  trm: number;
  cupo_cop: number;
  source: TcSource;
  notas: string;
}

/** Upsert via RPC (admin-only, idempotente por tarjeta+fecha_corte). */
export function useUpsertTcDebtSnapshot() {
  const qc = useQueryClient();
  return useMutation<TcDebtSnapshot, Error, UpsertTcDebtParams>({
    mutationFn: async (params) => {
      const rpc = supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<{ data: unknown; error: { message?: string } | null }>;
      const { data, error } = await rpc('upsert_tc_debt_snapshot', {
        p_tarjeta: params.tarjeta,
        p_fecha_corte: params.fecha_corte,
        p_saldo_cop: params.saldo_cop,
        p_saldo_usd: params.saldo_usd,
        p_trm: params.trm,
        p_cupo_cop: params.cupo_cop,
        p_source: params.source,
        p_notas: params.notas,
      });
      if (error) throw new Error(error.message || 'Error guardando snapshot de deuda');
      const row = parseRow(data);
      if (!row) throw new Error('Respuesta inesperada del servidor');
      return row;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tc-debt-snapshots'] });
    },
  });
}

// ─────────────────────────────────────────────────────────────────
// Helpers de cálculo (puros, sin React)
// ─────────────────────────────────────────────────────────────────

/** Total en COP = pesos + dólares × TRM */
export function totalCop(s: { saldo_cop: number; saldo_usd: number; trm: number }): number {
  return s.saldo_cop + s.saldo_usd * s.trm;
}

/** % usado del cupo (0..1, capado a 1). Si cupo=0 devuelve 0. */
export function cupoUsadoPct(s: { saldo_cop: number; saldo_usd: number; trm: number; cupo_cop: number }): number {
  if (s.cupo_cop <= 0) return 0;
  return Math.min(1, Math.max(0, totalCop(s) / s.cupo_cop));
}

/** Devuelve el último snapshot de una tarjeta (por fecha_corte desc) o null. */
export function latestSnapshot(snaps: TcDebtSnapshot[], tarjeta: TcCard): TcDebtSnapshot | null {
  const filtered = snaps.filter((s) => s.tarjeta === tarjeta);
  if (filtered.length === 0) return null;
  return [...filtered].sort((a, b) => (a.fecha_corte < b.fecha_corte ? 1 : -1))[0] ?? null;
}
