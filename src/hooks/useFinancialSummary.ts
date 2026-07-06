import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';

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
  perdida_total_devoluciones: number;  // RPC v6 — flete_devs + costo_devs (cargo extra Dropi)
  costo_promedio_devolucion: number;   // RPC v6 — perdida_total / total_devueltas
  mantenimiento_tarjeta: number;       // RPC v6 — gasto mensual tarjeta virtual Dropi
  indemnizaciones: number;             // RPC v6 — ingreso ocasional de Dropi (proveedor no despacha, etc)
  comision_referidos: number;   // RPC v3 — se resta de utilidad_bruta (sigue en payload por compat, fuera de la UI desde v4)
  ganancia_markup: number;      // RPC v3 — informativo (no se suma hasta sanity check)
  valor_cancelado: number;      // RPC v4 — SUM(valor) de canceladas, valor potencial perdido (no se descuenta de utilidad)
  total_cancelados: number;     // RPC v4 — conteo de canceladas en el período
  tasa_cancelacion_pct: number; // RPC v4 — % cancelados sobre total_ordenes
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
    perdida_total_devoluciones: toNumber(o.perdida_total_devoluciones),
    costo_promedio_devolucion:  toNumber(o.costo_promedio_devolucion),
    mantenimiento_tarjeta:      toNumber(o.mantenimiento_tarjeta),
    indemnizaciones:            toNumber(o.indemnizaciones),
    comision_referidos: toNumber(o.comision_referidos),
    ganancia_markup:    toNumber(o.ganancia_markup),
    valor_cancelado:    toNumber(o.valor_cancelado),
    total_cancelados:   toNumber(o.total_cancelados),
    tasa_cancelacion_pct: toNumber(o.tasa_cancelacion_pct),
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
  // El RPC `financial_summary` (v7) se scopea server-side por la tienda activa vía
  // _resolve_scope_store(); no recibe store_id. Pero incluimos `storeId` en la
  // queryKey para que React Query cachee POR TIENDA y refetchee al cambiar de
  // tienda (antes la key era solo [from,to] → al cambiar de tienda servía el cache
  // de la anterior). Ver StoreContext.setActiveStoreId + migration v7.
  const storeId = useActiveStoreId();
  return useQuery<FinancialSummary>({
    queryKey: ['financial-summary', storeId ?? 'all', from, to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('financial_summary', {
        p_from_date: from,
        p_to_date: to,
      });
      if (error) throw error;
      // El RPC hace `IF v_store IS NULL THEN RETURN` → jsonb NULL (sin error)
      // cuando no hay tienda activa resuelta (admin con active_store_id
      // desincronizado). Sin este guard, parseFinancialSummary coerce null→{}→
      // TODO en $0 y la pestaña Finanzas se ve en ceros indistinguible de "no
      // hubo ventas". Lanzamos → FinanzasTab pinta su banner de error (isError).
      if (data == null) throw new Error('Sin tienda activa: no se pudo calcular el resumen financiero. Recargá la página.');
      return parseFinancialSummary(data);
    },
    staleTime: 60_000,
    // Frescura de Finanzas: refrescar al volver a la pestaña + poll 5 min (el
    // default global es refetchOnWindowFocus:false → se quedaba fotografiado).
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60 * 1000,
    enabled: Boolean(from && to && storeId),
  });
}
