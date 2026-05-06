import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// Bypass del tipado generado por Supabase: las RPCs nuevas (creadas en
// migrations 20260506*) no están todavía en el types.ts auto-generado
// porque el cliente de tipos se regenera fuera de este repo. Mismo patrón
// usado en useMonthlyAdSpend, useTcDebtSnapshots, useProductProfitability.
const rpc = supabase.rpc as unknown as (
  fn: string, args?: Record<string, unknown>
) => Promise<{ data: unknown; error: { message?: string } | null }>;

// Hooks del bloque "Análisis tarjetas (gasto personal)" en /cfo.
// Consume la tabla personal_card_movements y los RPCs definidos en la
// migration 20260506000000. Admin-only via RLS.

export type Categoria =
  | 'pauta_facebook' | 'pauta_tiktok' | 'educacion' | 'software_negocio'
  | 'comision_avance' | 'avance_efectivo' | 'intereses' | 'abono_pago'
  | 'comida_delivery' | 'comida_restaurante' | 'mercado' | 'salud'
  | 'compras_personales' | 'viajes' | 'suscripciones' | 'compras_online'
  | 'transporte' | 'otro';

export const CATEGORIA_LABELS: Record<Categoria, string> = {
  pauta_facebook:     'Pauta Facebook',
  pauta_tiktok:       'Pauta TikTok',
  educacion:          'Educación / cursos',
  software_negocio:   'Software del negocio',
  comision_avance:    'Comisión de avance',
  avance_efectivo:    'Avance en efectivo',
  intereses:          'Intereses TC',
  abono_pago:         'Pago de tarjeta',
  comida_delivery:    'Comida (delivery)',
  comida_restaurante: 'Comida (restaurante)',
  mercado:            'Mercado',
  salud:              'Salud / farmacia',
  compras_personales: 'Compras personales',
  viajes:             'Viajes',
  suscripciones:      'Suscripciones',
  compras_online:     'Compras online',
  transporte:         'Transporte / gasolina',
  otro:               'Sin clasificar',
};

export interface SpendingByMonthRow {
  year_month: string;          // 'YYYY-MM'
  categoria: Categoria;
  es_negocio: boolean;
  total_monto: number;
  total_count: number;
  monto_cop: number;
  cuotas_diferidas: number;
}

export interface TopItemRow {
  id: string;
  fecha: string;               // ISO YYYY-MM-DD
  descripcion: string;
  tarjeta: string;
  marca: 'mastercard' | 'amex' | 'otro';
  monto: number;
  moneda: 'COP' | 'USD';
  monto_cop: number;
  categoria: Categoria;
  subcategoria: string | null;
  es_negocio: boolean;
  cuotas_total: number | null;
  interes_anual_pct: number | null;
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Resumen de gastos personales agrupado por (año-mes, categoría).
 * Devuelve hasta 12 meses por defecto.
 */
export function usePersonalSpendingByMonth(opts?: { fromDate?: string; toDate?: string }) {
  const fromDate = opts?.fromDate;
  const toDate = opts?.toDate;
  return useQuery<SpendingByMonthRow[]>({
    queryKey: ['personal-spending-by-month', fromDate ?? 'def', toDate ?? 'def'],
    queryFn: async () => {
      const { data, error } = await rpc('personal_spending_by_month', {
        p_from_date: fromDate ?? undefined,
        p_to_date:   toDate   ?? undefined,
      });
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      return rows.map((r: Record<string, unknown>) => ({
        year_month:       String(r.year_month ?? ''),
        categoria:        String(r.categoria ?? 'otro') as Categoria,
        es_negocio:       Boolean(r.es_negocio),
        total_monto:      toNumber(r.total_monto),
        total_count:      toNumber(r.total_count),
        monto_cop:        toNumber(r.monto_cop),
        cuotas_diferidas: toNumber(r.cuotas_diferidas),
      }));
    },
    staleTime: 60_000,
  });
}

/**
 * Top items de un mes, opcionalmente filtrado por categoría. Para drill-down.
 */
export function usePersonalSpendingTopItems(yearMonth: string, categoria?: Categoria, limit = 50) {
  return useQuery<TopItemRow[]>({
    queryKey: ['personal-spending-top', yearMonth, categoria ?? 'all', limit],
    queryFn: async () => {
      const { data, error } = await rpc('personal_spending_top_items', {
        p_year_month: yearMonth,
        p_categoria:  categoria ?? null,
        p_limit:      limit,
      });
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      return rows.map((r: Record<string, unknown>) => ({
        id:                String(r.id ?? ''),
        fecha:             String(r.fecha ?? ''),
        descripcion:       String(r.descripcion ?? ''),
        tarjeta:           String(r.tarjeta ?? ''),
        marca:             String(r.marca ?? 'otro') as 'mastercard' | 'amex' | 'otro',
        monto:             toNumber(r.monto),
        moneda:            (String(r.moneda ?? 'COP') as 'COP' | 'USD'),
        monto_cop:         toNumber(r.monto_cop),
        categoria:         String(r.categoria ?? 'otro') as Categoria,
        subcategoria:      typeof r.subcategoria === 'string' ? r.subcategoria : null,
        es_negocio:        Boolean(r.es_negocio),
        cuotas_total:      r.cuotas_total == null ? null : toNumber(r.cuotas_total),
        interes_anual_pct: r.interes_anual_pct == null ? null : toNumber(r.interes_anual_pct),
      }));
    },
    enabled: Boolean(yearMonth),
    staleTime: 60_000,
  });
}

/**
 * Mutation: ejecuta la edge function parse-bank-pdf-text con el texto
 * extraído del PDF en el cliente. Devuelve metadata + count + upsert result.
 */
export function useParseBankPdf() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { text: string; filename: string; dryRun?: boolean }) => {
      const { data, error } = await supabase.functions.invoke('parse-bank-pdf-text', {
        body: params,
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || 'Error desconocido al parsear PDF');
      return data as {
        ok: true;
        metadata: { tarjeta: string; marca: string; periodo_corte_from: string | null; periodo_corte_to: string | null };
        movements_count?: number;
        movements?: unknown[];
        upsert?: { inserted: number; updated: number; total: number };
        dryRun?: boolean;
      };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personal-spending-by-month'] });
      qc.invalidateQueries({ queryKey: ['personal-spending-top'] });
    },
  });
}

// ─── Pagado vs Pendiente ──────────────────────────────────────────

export interface PaymentsSummaryRow {
  year_month: string;
  compras_cop: number;
  compras_usd: number;
  pagos_cop: number;
  pagos_usd: number;
  intereses_cop: number;
  intereses_usd: number;
  avances_cop: number;
  avances_usd: number;
  comisiones_cop: number;
  count_movimientos: number;
}

export interface ResidualDebtRow {
  tarjeta: string;
  marca: 'mastercard' | 'amex' | 'otro';
  moneda: 'COP' | 'USD';
  saldo_pendiente: number;
  num_compras: number;
}

export interface PaymentRow {
  id: string;
  fecha: string;               // ISO YYYY-MM-DD
  descripcion: string;
  tarjeta: string;
  marca: 'mastercard' | 'amex' | 'otro';
  monto: number;               // valor absoluto (los abonos vienen negativos en BD)
  moneda: 'COP' | 'USD';
}

/**
 * Lista cronológica de pagos individuales (movimientos tipo='abono').
 * Devuelve cada abono con monto en valor absoluto para mostrarlo positivo.
 */
export function usePersonalPaymentsList() {
  return useQuery<PaymentRow[]>({
    queryKey: ['personal-payments-list'],
    queryFn: async () => {
      // Bypass del tipado: la tabla personal_card_movements no está en
      // el types.ts auto-generado todavía (mismo motivo que las RPCs).
      const sb = supabase as unknown as {
        from: (t: string) => {
          select: (cols: string) => {
            eq: (col: string, val: string) => {
              order: (col: string, opts: { ascending: boolean }) => Promise<{
                data: unknown; error: { message?: string } | null;
              }>;
            };
          };
        };
      };
      const { data, error } = await sb
        .from('personal_card_movements')
        .select('id,fecha,descripcion,tarjeta,marca,monto,moneda')
        .eq('tipo', 'abono')
        .order('fecha', { ascending: false });
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      return rows.map((r: Record<string, unknown>) => ({
        id:          String(r.id ?? ''),
        fecha:       String(r.fecha ?? ''),
        descripcion: String(r.descripcion ?? ''),
        tarjeta:     String(r.tarjeta ?? ''),
        marca:       String(r.marca ?? 'otro') as 'mastercard' | 'amex' | 'otro',
        monto:       Math.abs(toNumber(r.monto)),
        moneda:      String(r.moneda ?? 'COP') as 'COP' | 'USD',
      }));
    },
    staleTime: 60_000,
  });
}

/**
 * Resumen mensual de flujo de TC: compras nuevas vs pagos hechos vs
 * intereses vs avances. COP y USD separados (no convertimos en server,
 * la UI aplica la TRM que prefiera).
 */
export function usePersonalPaymentsSummary(opts?: { fromDate?: string; toDate?: string }) {
  const fromDate = opts?.fromDate;
  const toDate = opts?.toDate;
  return useQuery<PaymentsSummaryRow[]>({
    queryKey: ['personal-payments-summary', fromDate ?? 'def', toDate ?? 'def'],
    queryFn: async () => {
      const { data, error } = await rpc('personal_payments_summary', {
        p_from_date: fromDate ?? undefined,
        p_to_date:   toDate   ?? undefined,
      });
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      return rows.map((r: Record<string, unknown>) => ({
        year_month:        String(r.year_month ?? ''),
        compras_cop:       toNumber(r.compras_cop),
        compras_usd:       toNumber(r.compras_usd),
        pagos_cop:         toNumber(r.pagos_cop),
        pagos_usd:         toNumber(r.pagos_usd),
        intereses_cop:     toNumber(r.intereses_cop),
        intereses_usd:     toNumber(r.intereses_usd),
        avances_cop:       toNumber(r.avances_cop),
        avances_usd:       toNumber(r.avances_usd),
        comisiones_cop:    toNumber(r.comisiones_cop),
        count_movimientos: toNumber(r.count_movimientos),
      }));
    },
    staleTime: 60_000,
  });
}

/**
 * Snapshot actual de deuda residual por (tarjeta, moneda). Toma el
 * saldo_pendiente de la cuota más reciente conocida por compra.
 */
export function usePersonalResidualDebt() {
  return useQuery<ResidualDebtRow[]>({
    queryKey: ['personal-residual-debt'],
    queryFn: async () => {
      const { data, error } = await rpc('personal_residual_debt');
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      return rows.map((r: Record<string, unknown>) => ({
        tarjeta:         String(r.tarjeta ?? ''),
        marca:           String(r.marca ?? 'otro') as 'mastercard' | 'amex' | 'otro',
        moneda:          String(r.moneda ?? 'COP') as 'COP' | 'USD',
        saldo_pendiente: toNumber(r.saldo_pendiente),
        num_compras:     toNumber(r.num_compras),
      }));
    },
    staleTime: 60_000,
  });
}

/**
 * Mutation: re-categorización masiva (cuando se agregan nuevos patrones a
 * categorize_personal_movement y querés re-procesar movimientos viejos).
 */
export function useRecategorizePersonalMovements() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await rpc('recategorize_personal_movements');
      if (error) throw error;
      return data as { updated: number };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personal-spending-by-month'] });
      qc.invalidateQueries({ queryKey: ['personal-spending-top'] });
    },
  });
}
