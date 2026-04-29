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
  // v2: trazabilidad — añadidos en migration 20260428000000.
  // Opcionales (?) porque las RPCs viejas (cache de TanStack
  // pre-deploy) podrían devolver el shape v1.
  valor_en_transito?: number;
  pendientes_sin_despachar?: number;
  pendientes_por_confirmar?: number;
  valor_pendientes?: number;
  cancelados?: number;
  valor_cancelado?: number;
  // v3: novedades — añadidos en migration 20260428100000.
  // Sin esto, ~20% de los pedidos quedaban sin asignar a ningún bucket.
  novedades?: number;
  valor_novedades?: number;
}

/** Una fila del timeline de guías (RPC `logistics_timeline`). */
export interface TimelineEntry {
  id: string;
  fecha: string;            // YYYY-MM-DD
  guia: string;
  external_id: string;
  estado: string;
  transportadora: string;
  ciudad: string;
  producto: string;
  valor: number;
  total_count: number;      // total de filas que matchean los filtros (para paginación)
}

/** Filtros para `logistics_timeline`. */
export interface TimelineFilters {
  estados?: string[];        // ej: ['ENTREGADO', 'EN TRANSPORTE']
  transportadora?: string;
  search?: string;           // matchea guia o external_id (ILIKE)
  page?: number;             // 0-based
  pageSize?: number;
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
  /** Ciudad opcional. Si está, todas las RPCs filtran por ciudad = this. */
  ciudad?: string;
}

/** Una fila de la matriz transportadora × ciudad (heatmap). */
export interface CityCarrierMatrix {
  ciudad: string;
  departamento: string;
  transportadora: string;
  total_pedidos: number;
  entregados: number;
  devueltos: number;
  tasa_entrega: number;
  tasa_devolucion: number;
  ciudad_total: number;
}

/** Recomendación de transportadora por ciudad. */
export interface CarrierRecommendation {
  ciudad: string;
  departamento: string;
  ciudad_total: number;
  mejor_transportadora: string;
  mejor_tasa_entrega: number;
  mejor_pedidos: number;
  peor_transportadora: string;
  peor_tasa_entrega: number;
  peor_pedidos: number;
  delta_puntos: number;
  carrier_actual_top: string;
  recomendacion: string;       // "Mantener X" | "Cambiar a X"
}

/** Una ciudad disponible para el dropdown de filtro. */
export interface CityOption {
  ciudad: string;
  departamento: string;
  total_pedidos: number;
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
