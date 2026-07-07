import type { CityCarrierMatrix, CarrierRecommendation } from './logistics.types';

/**
 * Recomendaciones de transportadora por ciudad, RANKEADAS POR TASA MADURA.
 *
 * Reemplaza el ranking del RPC `logistics_recommendations` (que rankea por
 * `entregados ÷ total`, diluido por en-tránsito) con un cálculo client-side sobre
 * la MISMA matriz que alimenta el heatmap (`logistics_by_city_carrier`), usando
 * tasa madura = `entregados ÷ (entregados + devueltos)`.
 *
 * Por qué client-side: el RPC `logistics_recommendations` del repo NO está
 * scopeado por tienda (riesgo de drift si la versión viva fue parcheada). La
 * matriz SÍ está scopeada (`_resolve_scope_store`), así que derivar de ella es
 * seguro y country-agnostic (la tasa madura solo usa buckets terminales →
 * ignora los estados intermedios que EC inventa).
 *
 * La matriz ya viene filtrada: ciudades con ≥ min_orders, top N por volumen, y
 * transportadoras con ≥5 pedidos en esa ciudad.
 */

interface CarrierAgg {
  transportadora: string;
  pedidos: number;
  resueltos: number;        // entregados + devueltos
  tasaMadura: number | null; // entregados ÷ resueltos * 100 (null si resueltos=0)
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Mínimo de pedidos RESUELTOS (entregados+devueltos) para que una transportadora
 *  compita en el ranking. Debajo de esto la tasa es ruido (1 entrega = "100%"). */
export const MIN_RESUELTOS_RANK = 5;

export function deriveCarrierRecommendations(
  rows: CityCarrierMatrix[],
  minOrders = 20,
): CarrierRecommendation[] {
  // Agrupar por ciudad (clave ciudad|departamento, como en el resto del módulo).
  const byCity = new Map<string, { ciudad: string; departamento: string; ciudadTotal: number; carriers: CarrierAgg[] }>();

  for (const r of rows) {
    const key = `${r.ciudad}|${r.departamento ?? ''}`;
    let city = byCity.get(key);
    if (!city) {
      city = { ciudad: r.ciudad, departamento: r.departamento ?? '', ciudadTotal: r.ciudad_total ?? 0, carriers: [] };
      byCity.set(key, city);
    }
    const entregados = Math.max(0, r.entregados || 0);
    // Los rechazos vienen dentro de `devueltos` — la tasa madura los excluye
    // (decisión dueño 2026-06-24; RPC vieja sin la columna → 0, sin cambio).
    const devueltos = Math.max(0, (r.devueltos || 0) - Math.max(0, r.rechazados ?? 0));
    const resueltos = entregados + devueltos;
    city.carriers.push({
      transportadora: r.transportadora,
      pedidos: r.total_pedidos || 0,
      resueltos,
      tasaMadura: resueltos > 0 ? (entregados / resueltos) * 100 : null,
    });
  }

  const out: CarrierRecommendation[] = [];

  for (const city of byCity.values()) {
    if (city.ciudadTotal < minOrders) continue;

    // current_top = transportadora con más volumen (incluye las sin resueltos).
    const currentTop = [...city.carriers].sort((a, b) => b.pedidos - a.pedidos)[0];

    // Ranking de calidad SOLO sobre transportadoras con muestra real de desenlaces.
    // Con resueltos>0 bastaba 1 solo pedido concluido para "ganar" con 100% y
    // disparar "Cambiar urgente" sobre ruido estadístico (bug auditoría 2026-07-02).
    const rankeable = city.carriers.filter(
      c => c.tasaMadura != null && c.resueltos >= MIN_RESUELTOS_RANK,
    );
    if (rankeable.length === 0) continue;

    const best = [...rankeable].sort(
      (a, b) => (b.tasaMadura! - a.tasaMadura!) || (b.pedidos - a.pedidos),
    )[0];
    const worst = [...rankeable].sort(
      (a, b) => (a.tasaMadura! - b.tasaMadura!) || (b.pedidos - a.pedidos),
    )[0];

    const mejorTasa = round1(best.tasaMadura!);
    const peorTasa = round1(worst.tasaMadura!);
    const esMantener = best.transportadora === currentTop.transportadora;

    out.push({
      ciudad: city.ciudad,
      departamento: city.departamento,
      ciudad_total: city.ciudadTotal,
      mejor_transportadora: best.transportadora,
      mejor_tasa_entrega: mejorTasa,
      mejor_pedidos: best.pedidos,
      mejor_resueltos: best.resueltos,
      peor_transportadora: worst.transportadora,
      peor_tasa_entrega: peorTasa,
      peor_pedidos: worst.pedidos,
      peor_resueltos: worst.resueltos,
      delta_puntos: round1(mejorTasa - peorTasa),
      carrier_actual_top: currentTop.transportadora,
      recomendacion: esMantener
        ? `Mantener ${best.transportadora}`
        : `Cambiar a ${best.transportadora}`,
    });
  }

  // Mismo orden que el RPC: ciudades de mayor volumen primero.
  return out.sort((a, b) => b.ciudad_total - a.ciudad_total);
}
