// responsabilidadAsesor — UNA fila por asesor con TODO junto: esfuerzo (gestionados
// vs meta), resultado (confirmados), calidad (devoluciones + tasa + evitables) y
// disciplina de validación (% despachado en rojo, del sello). El "sistema que
// funciona solo" que pidió el dueño: de un vistazo, quién afloja y quién atropella.
//
// Puro y testeable. Los datos los junta el hook desde fuentes que YA existen
// (operator_productivity_stats, novedades_root_cause, el sello en orders); acá solo
// se combinan y se decide el semáforo. Nada se inventa: un dato que no llegó va en
// null y se pinta "—", NUNCA 0 (un 0 acusa; un "—" dice "no se pudo medir").

/** Meta ÓPTIMA de gestiones por día laboral (lo que se MUESTRA como objetivo).
 *  Ajustable — palanca que el dueño calibra. Óptimo: 3 min/pedido = 20/hora (misma
 *  del velocímetro) × ~6h = 120. Se compara contra `total_atendidos` (pedidos
 *  distintos trabajados, incluye los "no contestó"): vara de ESFUERZO, no de ventas. */
export const META_GESTIONES_DIA = 120;

/** La ALERTA roja NO es no-llegar-al-óptimo, sino caer por debajo del 60% de él
 *  (= 12/hora = 5 min/pedido). Entre 60% y 100% es ámbar ("aceptable, no óptimo").
 *  Así el óptimo se muestra como meta pero el rojo solo salta cuando de verdad va
 *  lento — decisión del dueño (25-ago): "el alerta en 5, pero el óptimo son 3". */
export const RATIO_META_ALERTA = 0.6;

/** Nivel de esfuerzo de un asesor contra la meta óptima del rango. */
export function nivelMeta(
  gestionados: number,
  metaOptimo: number,
): 'optimo' | 'aceptable' | 'lento' | null {
  if (metaOptimo <= 0) return null;
  if (gestionados >= metaOptimo) return 'optimo';
  if (gestionados >= metaOptimo * RATIO_META_ALERTA) return 'aceptable';
  return 'lento';
}

/** Días del rango, para escalar la meta. */
export function diasDelRango(range: 'today' | '7d' | '30d'): number {
  return range === 'today' ? 1 : range === '7d' ? 7 : 30;
}

/**
 * Meta de gestiones del rango. Para 'today' se PRORRATEA al turno transcurrido
 * (`fraccionHoy` ∈ 0..1): a media mañana no se le puede exigir el día entero —
 * sin esto, a las 3 h con 37 gestiones TODAS las filas salían rojas por injusto
 * (mismo criterio que el % de horario prorrateado a lo transcurrido del dashboard).
 * Para 7d/30d son días ya cerrados → meta completa.
 */
export function metaGestionesDelRango(
  range: 'today' | '7d' | '30d',
  fraccionHoy = 1,
): number {
  if (range === 'today') {
    const f = Math.max(0, Math.min(1, fraccionHoy));
    return Math.round(META_GESTIONES_DIA * f);
  }
  return META_GESTIONES_DIA * diasDelRango(range);
}

export interface AsesorScoreInput {
  operatorId: string;
  name: string;
  /** Pedidos distintos trabajados (conf+canc+noresp). Vara de esfuerzo. */
  gestionados: number;
  confirmados: number;
  /** Devoluciones del período atribuidas a este asesor como CONFIRMADOR. */
  devoluciones: number;
  evitables: number;
  /** Pedidos que confirmó y se despacharon CON sello (denominador del % en rojo).
   *  El sello arrancó el 22-ago-2026 sin histórico → hoy es un slice reciente. */
  despachadosConSello: number;
  /** De ésos, cuántos salieron con semáforo rojo/amarillo o pickup (mal validados). */
  despachadosEnRojo: number;
}

export interface AsesorScore extends AsesorScoreInput {
  /** devoluciones ÷ confirmados × 100. null si no confirmó nada. */
  tasaDevolucion: number | null;
  /** enRojo ÷ conSello × 100. null si no hay pedidos con sello (aún). */
  pctEnRojo: number | null;
  /** Nivel de esfuerzo: 'optimo' (≥meta) · 'aceptable' (≥60%) · 'lento' (<60%). */
  nivelMeta: 'optimo' | 'aceptable' | 'lento' | null;
  /** Meta ÓPTIMA del rango contra la que se comparó (la que se muestra). */
  metaGestiones: number;
}

export function construirScores(
  inputs: AsesorScoreInput[],
  metaGestiones: number,
): AsesorScore[] {
  const scores = inputs.map((i): AsesorScore => {
    const tasaDevolucion = i.confirmados > 0
      ? Math.round((i.devoluciones / i.confirmados) * 1000) / 10
      : null;
    const pctEnRojo = i.despachadosConSello > 0
      ? Math.round((i.despachadosEnRojo / i.despachadosConSello) * 1000) / 10
      : null;
    return { ...i, tasaDevolucion, pctEnRojo, nivelMeta: nivelMeta(i.gestionados, metaGestiones), metaGestiones };
  });
  // Orden: los que más urgen a revisar arriba — primero los LENTOS (bajo la
  // alerta), luego por tasa de devolución desc, luego por volumen.
  return scores.sort((a, b) => {
    const am = a.nivelMeta === 'lento' ? 0 : 1;
    const bm = b.nivelMeta === 'lento' ? 0 : 1;
    if (am !== bm) return am - bm;
    const at = a.tasaDevolucion ?? -1;
    const bt = b.tasaDevolucion ?? -1;
    if (bt !== at) return bt - at;
    return b.gestionados - a.gestionados;
  });
}

/** Semáforo de una fila: rojo si no llega a la meta O tasa devol alta O % en rojo
 *  alto; ámbar en la banda de alerta; verde si todo bien. 'neutro' si falta el dato
 *  base (sin gestiones medidas). Umbrales tuneables. */
export function semaforoAsesor(s: AsesorScore): 'rojo' | 'ambar' | 'verde' | 'neutro' {
  if (s.gestionados === 0 && s.confirmados === 0) return 'neutro';
  const malaMeta = s.nivelMeta === 'lento';   // bajo la alerta (12/h)
  const malaTasa = s.tasaDevolucion != null && s.tasaDevolucion >= 15;
  const malRojo = s.pctEnRojo != null && s.pctEnRojo >= 30 && s.despachadosConSello >= 5;
  if (malaMeta || malaTasa || malRojo) return 'rojo';
  const flojaMeta = s.nivelMeta === 'aceptable';   // entre alerta y óptimo
  const flojaTasa = s.tasaDevolucion != null && s.tasaDevolucion >= 10;
  const flojoRojo = s.pctEnRojo != null && s.pctEnRojo >= 15 && s.despachadosConSello >= 5;
  if (flojaMeta || flojaTasa || flojoRojo) return 'ambar';
  return 'verde';
}
