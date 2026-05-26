// Fuente ÚNICA de verdad de la tasa de confirmación. Antes cada pantalla la
// calculaba distinto (ProductivityDashboard ÷entrantes, banner personal
// ÷(conf+canc+noresp), Reportes Diarios ÷(conf+canc)) → los números no cuadraban
// y confundían al dueño. Toda la app usa AHORA la tasa MADURA:
//
//   tasa de confirmación = confirmados ÷ (confirmados + cancelados)
//
// Por qué madura (decisión de consultor, aceptada por el dueño):
//   - Mide CALIDAD de venta: de los pedidos donde el cliente YA decidió, cuántos
//     compraron. Es el estándar COD.
//   - NO mete `noresp` en el denominador: los que no contestan son CONTACTABILIDAD
//     (problema de datos/timing), métrica aparte — no ensucian la confirmación.
//   - NO divide por `entrantes`: eso mezcla calidad con volumen del equipo. La
//     COBERTURA (resueltos÷entrantes) es métrica de equipo, aparte.
// Funciones puras, sin red, country-agnostic.

/** Muestra mínima para que una tasa por-operadora/personal sea concluyente. */
export const MATURITY_MIN_RESUELTOS = 5;
/** % del inflow que debe estar resuelto para que el cohorte (día) sea concluyente. */
export const COHORTE_MATURITY_PCT = 90;

export interface SampleRate {
  /** confirmados ÷ (confirmados + cancelados). null si no hay resueltos aún. */
  tasa: number | null;
  /** confirmados + cancelados (denominador real). */
  resueltos: number;
  /** true cuando hay muy pocos resueltos → la tasa no es concluyente (mostrar gris). */
  inmaduro: boolean;
}

export interface CohortRate extends SampleRate {
  /** cancelados ÷ resueltos. null si no hay resueltos. */
  tasaCanc: number | null;
  /** (conf + canc) ÷ entrantes — qué tan trabajado está el cohorte. */
  pctProcesado: number;
}

function round(n: number): number {
  return Math.round(n);
}

/**
 * Tasa madura para una MUESTRA por-operadora o personal (no hay "entrantes"
 * asignados por persona). Inmadura cuando hay pocos resueltos.
 */
export function confRateBySample(
  conf: number,
  canc: number,
  minResueltos: number = MATURITY_MIN_RESUELTOS,
): SampleRate {
  const c = Math.max(0, conf || 0);
  const x = Math.max(0, canc || 0);
  const resueltos = c + x;
  return {
    tasa: resueltos > 0 ? round((c / resueltos) * 100) : null,
    resueltos,
    inmaduro: resueltos < minResueltos,
  };
}

/**
 * Tasa madura para un COHORTE (día) que SÍ tiene inflow conocido (entrantes).
 * La inmadurez se mide por % procesado: un día recién entrado con muchos
 * pendientes no es concluyente aunque tenga >5 resueltos.
 * Reemplaza al viejo deriveDayMetrics local de DailyReportsView.
 */
export function confRateByCohort(conf: number, canc: number, entrantes: number): CohortRate {
  const c = Math.max(0, conf || 0);
  const x = Math.max(0, canc || 0);
  const e = Math.max(0, entrantes || 0);
  const resueltos = c + x;
  const pctProcesado = e > 0 ? round((resueltos / e) * 100) : 0;
  return {
    tasa: resueltos > 0 ? round((c / resueltos) * 100) : null,
    tasaCanc: resueltos > 0 ? round((x / resueltos) * 100) : null,
    resueltos,
    pctProcesado,
    inmaduro: pctProcesado < COHORTE_MATURITY_PCT,
  };
}

/**
 * Contactabilidad: de los pedidos que la operadora ATENDIÓ, qué % contestó
 * (confirmó o canceló, vs los que no respondieron). NO cuenta los pendientes
 * que todavía no tocó. 0-100, redondeado.
 */
export function contactRate(conf: number, canc: number, atendidos: number): number {
  const a = Math.max(0, atendidos || 0);
  if (a === 0) return 0;
  return round(((Math.max(0, conf || 0) + Math.max(0, canc || 0)) / a) * 100);
}
