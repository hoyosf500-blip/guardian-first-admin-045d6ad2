// Fuente ÚNICA de verdad de la tasa de confirmación.
//
// ⚖️ DECISIÓN FINAL DEL DUEÑO (30-jul-2026, tras la disputa del "Tasa: 99%"):
// UNA sola matemática oficial en todo el CRM —
//
//   CONFIRMACIÓN DEL DÍA = confirmados ÷ GESTIONADOS (conf + canc + noresp)
//   (ej. 71 ÷ 107 = 66%) · meta = CONF_TARGET_PCT (85%) · helper confRateOficial()
//
// Cuenta TODO lo confirmado en la ventana, sea el pedido nuevo o viejo, y el
// denominador incluye a los que NO contestaron — porque también son ventas por
// sacar. Es la tasa con la que el dueño PAGA al equipo.
//
// Las demás fórmulas SOBREVIVEN pero con nombre propio y rol secundario:
//   - confRateBySample (conf ÷ conf+canc)  → "CIERRE DE LLAMADA" / "aceptación"
//     (~99%): de los que contestaron, cuántos dijeron sí. NUNCA rotularla
//     "confirmación" a secas — fue la causa de la disputa.
//   - confRateByCohort.tasaDia (conf ÷ entró) → "DE LO QUE ENTRÓ" (informativo
//     por fecha, ej. en "Cómo terminó el día"). Tampoco es LA confirmación.
// Funciones puras, sin red, country-agnostic.

/**
 * META OFICIAL de confirmación (%). FUENTE ÚNICA DE VERDAD — decisión del dueño,
 * exigida por escrito varias veces: la meta es 85%. Antes cada pantalla usaba su
 * propio umbral (70, 70/50, 80, 80/60) y todas le decían a la operadora que iba
 * bien estando por DEBAJO de meta. Toda pantalla que pinte "en meta / por debajo"
 * DEBE comparar contra esta constante — no hardcodear números.
 */
export const CONF_TARGET_PCT = 85;

/**
 * META del DÍA sobre INFLOW (%). Es la "confirmación del día" = confirmados ÷ lo
 * que ENTRÓ en el período (no ÷resueltos). Distinta de CONF_TARGET_PCT: aquí la
 * meta es ~55%, NO 85%, porque confirmar 85 de cada 100 que entran es imposible
 * (los que no contestan el teléfono bajan el techo real a ~50-60%). Es el número
 * de "cómo va el día" del manager. VALOR INICIAL a calibrar tras ver datos reales.
 */
export const CONF_DIA_TARGET_PCT = 55;

/** Muestra mínima para que una tasa por-operadora/personal sea concluyente. */
export const MATURITY_MIN_RESUELTOS = 5;
/** % del inflow que debe estar resuelto para que el cohorte (día) sea concluyente. */
export const COHORTE_MATURITY_PCT = 90;

/**
 * ¿La tasa está por DEBAJO de la meta oficial? null (sin datos) → false: no se
 * penaliza una muestra vacía. Respetá aparte el estado "inmaduro" (gris) de
 * confRateBySample/confRateByCohort: una muestra chica NO se pinta roja.
 */
export function isBelowTarget(tasa: number | null | undefined): boolean {
  return tasa != null && tasa < CONF_TARGET_PCT;
}

/**
 * ¿La confirmación del día (÷inflow) está por DEBAJO de la meta del día (~55%)?
 * null → false. Igual que isBelowTarget pero contra CONF_DIA_TARGET_PCT. NO
 * pintes rojo un cohorte inmaduro (día en curso) — respetá `inmaduro` aparte.
 */
export function isBelowDailyTarget(tasaDia: number | null | undefined): boolean {
  return tasaDia != null && tasaDia < CONF_DIA_TARGET_PCT;
}

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
  /** confirmados ÷ ENTRANTES (0-100). La "confirmación del día": de todo lo que
   *  entró, cuánto quedó confirmado. Distinta de `tasa` (÷resueltos). null si no
   *  hay entrantes. Se juzga contra CONF_DIA_TARGET_PCT (~55%), no contra 85%. */
  tasaDia: number | null;
}

/**
 * Redondeo DIRECCIONAL, no simétrico (23-ago-2026, misma regla que
 * logisticsRates): las tasas favorables van con floor y las adversas con ceil.
 * Con Math.round, 250 confirmados y 1 cancelado (99,6%) imprimía "100%" de
 * cierre — un 100% con una cancelación existente es mentira — y 199 resueltos
 * de 200 marcaban "100% procesado" con un pedido sin tocar. floor solo llega a
 * 100 cuando NO queda nada en contra, y floor+ceil de tasas complementarias
 * siguen sumando 100 exacto.
 */
function abajo(n: number): number {
  return Math.floor(n);
}
function arriba(n: number): number {
  return Math.ceil(n);
}

export interface OfficialRate {
  /** confirmados ÷ gestionados (conf+canc+noresp), 0-100. null sin gestiones. */
  tasa: number | null;
  /** conf + canc + noresp — el denominador oficial. */
  gestionados: number;
  /** true con muy pocas gestiones → mostrar gris, no veredicto. */
  inmaduro: boolean;
}

/**
 * LA tasa oficial: CONFIRMACIÓN DEL DÍA = confirmados ÷ gestionados.
 * Es la única fórmula que puede llamarse "confirmación" en la UI y la única que
 * se compara contra CONF_TARGET_PCT (85%). Cualquier pantalla nueva que muestre
 * confirmación DEBE usar este helper — no recalcular a mano ni usar
 * confRateBySample (esa es el "cierre de llamada", otra cosa).
 */
export function confRateOficial(
  conf: number,
  canc: number,
  noresp: number,
  minGestionados: number = MATURITY_MIN_RESUELTOS,
): OfficialRate {
  const c = Math.max(0, conf || 0);
  const x = Math.max(0, canc || 0);
  const n = Math.max(0, noresp || 0);
  const gestionados = c + x + n;
  return {
    tasa: gestionados > 0 ? abajo((c / gestionados) * 100) : null,
    gestionados,
    inmaduro: gestionados < minGestionados,
  };
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
    tasa: resueltos > 0 ? abajo((c / resueltos) * 100) : null,
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
  const pctProcesado = e > 0 ? abajo((resueltos / e) * 100) : 0;
  return {
    tasa: resueltos > 0 ? abajo((c / resueltos) * 100) : null,
    tasaCanc: resueltos > 0 ? arriba((x / resueltos) * 100) : null,
    tasaDia: e > 0 ? abajo((c / e) * 100) : null,
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
  return abajo(((Math.max(0, conf || 0) + Math.max(0, canc || 0)) / a) * 100);
}
