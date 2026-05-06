import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

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
      const { data, error } = await supabase.rpc('personal_spending_by_month', {
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
      const { data, error } = await supabase.rpc('personal_spending_top_items', {
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

/**
 * Mutation: re-categorización masiva (cuando se agregan nuevos patrones a
 * categorize_personal_movement y querés re-procesar movimientos viejos).
 */
export function useRecategorizePersonalMovements() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('recategorize_personal_movements');
      if (error) throw error;
      return data as { updated: number };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personal-spending-by-month'] });
      qc.invalidateQueries({ queryKey: ['personal-spending-top'] });
    },
  });
}
