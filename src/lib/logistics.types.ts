// Contratos de datos entre RPCs (supabase/migrations/20260427130000)
// y el frontend. Los nombres de campos matchean exactamente los
// `RETURNS TABLE (...)` de cada RPC — si cambia uno, cambia el otro.

export interface LogisticsSummary {
  total_pedidos: number;
  entregados: number;
  devueltos: number;
  en_transito: number;
  tasa_entrega: number;      // 0-100
  tasa_devolucion: number;   // 0-100
  valor_entregado: number;   // COP
  valor_perdido: number;     // COP
}

export interface CarrierStats {
  transportadora: string;
  total_pedidos: number;
  entregados: number;
  devueltos: number;
  en_transito: number;
  novedades: number;
  tasa_entrega: number;
  tasa_devolucion: number;
  valor_entregado: number;
  valor_perdido: number;
  avg_dias_entrega: number | null;
}

export interface CityReturns {
  ciudad: string;
  departamento: string;
  total_pedidos: number;
  entregados: number;
  devueltos: number;
  tasa_devolucion: number;
  tasa_entrega: number;
  valor_perdido: number;
}

export interface ProductFailure {
  producto: string;
  total_pedidos: number;
  entregados: number;
  devueltos: number;
  tasa_entrega: number;
  tasa_devolucion: number;
  valor_entregado: number;
  valor_perdido: number;
}

export interface LogisticsFilters {
  fromDate: string;     // YYYY-MM-DD
  toDate: string;       // YYYY-MM-DD
  minOrders: number;    // default 5
}

// Type guard runtime — defensivo contra payloads malformados de Supabase.
export function isLogisticsSummary(v: unknown): v is LogisticsSummary {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.total_pedidos === 'number' &&
    typeof o.entregados === 'number' &&
    typeof o.devueltos === 'number' &&
    typeof o.tasa_entrega === 'number'
  );
}
