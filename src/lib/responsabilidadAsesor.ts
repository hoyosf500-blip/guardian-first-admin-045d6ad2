// responsabilidadAsesor — UNA fila por asesor con TODO junto: esfuerzo (gestionados
// vs meta), resultado (confirmados), calidad (devoluciones + tasa + evitables) y
// disciplina de validación (% despachado en rojo, del sello). El "sistema que
// funciona solo" que pidió el dueño: de un vistazo, quién afloja y quién atropella.
//
// Puro y testeable. Los datos los junta el hook desde fuentes que YA existen
// (operator_productivity_stats, novedades_root_cause, el sello en orders); acá solo
// se combinan y se decide el semáforo. Nada se inventa: un dato que no llegó va en
// null y se pinta "—", NUNCA 0 (un 0 acusa; un "—" dice "no se pudo medir").

/** Meta ORIENTATIVA de gestiones por día laboral. Ajustable — es la palanca que el
 *  dueño calibra. 15 gestiones/hora (la misma del velocímetro) × ~6h de turno. Se
 *  compara contra `total_atendidos` (pedidos distintos trabajados), que incluye los
 *  "no contestó" (rápidos), así que es una vara de ESFUERZO, no de ventas. */
export const META_GESTIONES_DIA = 90;

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
  /** ¿Alcanzó la meta de gestiones del rango? null si no aplica. */
  metaOk: boolean | null;
  /** Meta de gestiones del rango contra la que se comparó. */
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
    const metaOk = metaGestiones > 0 ? i.gestionados >= metaGestiones : null;
    return { ...i, tasaDevolucion, pctEnRojo, metaOk, metaGestiones };
  });
  // Orden: los que más urgen a revisar arriba — primero los que NO llegan a la
  // meta, luego por tasa de devolución desc, luego por volumen.
  return scores.sort((a, b) => {
    const am = a.metaOk === false ? 0 : 1;
    const bm = b.metaOk === false ? 0 : 1;
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
  const malaMeta = s.metaOk === false;
  const malaTasa = s.tasaDevolucion != null && s.tasaDevolucion >= 15;
  const malRojo = s.pctEnRojo != null && s.pctEnRojo >= 30 && s.despachadosConSello >= 5;
  if (malaMeta || malaTasa || malRojo) return 'rojo';
  const flojaTasa = s.tasaDevolucion != null && s.tasaDevolucion >= 10;
  const flojoRojo = s.pctEnRojo != null && s.pctEnRojo >= 15 && s.despachadosConSello >= 5;
  if (flojaTasa || flojoRojo) return 'ambar';
  return 'verde';
}
