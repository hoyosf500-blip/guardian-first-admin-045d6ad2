import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// Fase A del módulo financiero — utilidad bruta operativa.
// Mapea 1:1 al RETURNS jsonb del RPC `financial_summary`
// (supabase/migrations/20260502000001_financial_summary.sql).
//
// IMPORTANTE: la utilidad NO incluye gasto pauta Meta/TikTok. Eso es
// Fase B cuando se conecte el token de Ads. Mostrar siempre el banner
// informativo arriba de los KPIs para que el operador no confunda
// "utilidad bruta" con "ROAS / margen neto".

export interface FinancialSummary {
  ingresos_brutos: number;
  cogs: number;
  flete_entregadas: number;
  flete_devoluciones: number;
  costo_devoluciones: number;
  utilidad_bruta: number;
  total_ordenes: number;
  total_entregadas: number;
  total_devueltas: number;
  tasa_entrega_pct: number;
  ticket_promedio: number;
  wallet_neto: number;
}

// Coerce numeric — Postgres devuelve NUMERIC como string en algunos casos
// (drivers que preservan precisión arbitraria). Forzamos Number() para
// que los componentes puedan formatear con Intl.NumberFormat sin sorpresas.
function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }
  return 0;
}

function parseFinancialSummary(raw: unknown): FinancialSummary {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    ingresos_brutos:    toNumber(o.ingresos_brutos),
    cogs:               toNumber(o.cogs),
    flete_entregadas:   toNumber(o.flete_entregadas),
    flete_devoluciones: toNumber(o.flete_devoluciones),
    costo_devoluciones: toNumber(o.costo_devoluciones),
    utilidad_bruta:     toNumber(o.utilidad_bruta),
    total_ordenes:      toNumber(o.total_ordenes),
    total_entregadas:   toNumber(o.total_entregadas),
    total_devueltas:    toNumber(o.total_devueltas),
    tasa_entrega_pct:   toNumber(o.tasa_entrega_pct),
    ticket_promedio:    toNumber(o.ticket_promedio),
    wallet_neto:        toNumber(o.wallet_neto),
  };
}

export function useFinancialSummary(from: string, to: string) {
  return useQuery<FinancialSummary>({
    queryKey: ['financial-summary', from, to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('financial_summary', {
        p_from_date: from,
        p_to_date: to,
      });
      if (error) throw error;
      return parseFinancialSummary(data);
    },
    staleTime: 60_000,
    enabled: Boolean(from && to),
  });
}
