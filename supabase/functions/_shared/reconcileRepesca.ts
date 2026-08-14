// Repesca de fantasmas rezagados — la mitad que le faltaba al barrido nocturno.
//
// EL AGUJERO QUE TAPA
// `dropi-nightly-reconcile` detecta pedidos BORRADOS en Dropi comparando contra un
// barrido por FECHA DE CREADO de los últimos `RECONCILE_DAYS_BACK` (30) días. Para
// no cancelar por inferencia inválida, exige que el pedido tenga su `fecha` DENTRO
// de esa misma ventana (guard de 2026-07-03, que evitó cancelar 24 pedidos CO
// buenos). El guard está bien; lo que falta es la otra mitad: **si un fantasma no
// se detecta dentro de esos 30 días, no se detecta NUNCA.** Cada día que pasa se
// aleja más de la ventana.
//
// Medido el 2026-08-05, las dos tiendas: 76 pedidos no-terminales congelados fuera
// de la ventana — 49 PENDIENTE en Colombia por $5.376.049 desde el 15 de abril, y
// en Ecuador hasta pedidos de NOVIEMBRE de 2025 todavía figurando como si
// estuvieran en la calle. De los 11 de julio de Ecuador se verificó uno por uno
// contra la API de Dropi: los 11 responden "esta guía no existe en nuestro
// sistema". No estaban en camino, no existían.
//
// CÓMO REPESCA SIN REVENTAR LA API
// Un barrido por cada mes rezagado en la misma corrida es justo lo que el
// rate-limit de Ecuador mata (y un pull incompleto NO archiva nada, así que sería
// trabajo tirado). En vez de eso: **un solo mes por corrida, el más viejo
// primero**. La deuda se salda de a un mes por noche y después, sin rezagados, la
// repesca no dispara ni un request. El costo en régimen es cero.
//
// TODO ES FAIL-CLOSED. Ante la duda no se archiva: un pedido vivo marcado como
// fantasma desaparece de los tableros de la operación, que es mucho peor que un
// fantasma de más contado un día más.

/** Días sin movimiento para considerar a un pedido "congelado". Por debajo de esto
 *  puede estar simplemente lento, y un pedido lento NO es un fantasma.
 *
 *  Bajó de 30 → 10 el 14-ago-2026 (auditoría devoluciones): la repesca dejó de
 *  ser solo caza-fantasmas — ahora también ESCRIBE el estado fresco que el
 *  barrido trae (ver dropi-nightly-reconcile). Con 30, una devolución de un
 *  pedido viejo fuera de la ventana del cron EC (28d) esperaba hasta un mes
 *  congelada como "EN REPARTO" antes de entrar acá. Con 10, entra a la
 *  siguiente ronda de noches. El costo NO cambia: sigue siendo UN mes barrido
 *  por corrida — el umbral solo decide QUIÉNES son candidatos. */
export const REPESCA_FROZEN_DAYS = 10;

/** Tope de archivados por corrida. Si un cambio futuro rompe la lógica, el daño
 *  queda acotado a este número y se ve en el log en vez de barrer la base entera
 *  en una noche. Con 76 rezagados en total, nunca debería activarse. */
export const REPESCA_MAX_ARCHIVE_PER_RUN = 200;

/** Mínimo de pedidos que tiene que devolver el barrido para creerle. Un barrido
 *  vacío es indistinguible de "todo el mes fue borrado" — y actuar sobre eso
 *  archivaría el mes completo. */
export const REPESCA_MIN_SWEEP_ORDERS = 1;

export interface RepescaRow {
  id: string;
  external_id: string | null;
  /** Fecha de creación en Dropi, 'YYYY-MM-DD'. Es la que usa el barrido. */
  fecha: string | null;
  /** Timestamp de alta en Guardian (ISO). */
  created_at: string | null;
}

export interface RepescaPlan {
  /** Mes que se va a barrer, 'YYYY-MM'. */
  yearMonth: string;
  /** Rango del barrido: primer y último día del mes. */
  from: string;
  to: string;
  /** Los rezagados de ESE mes — los únicos sobre los que se puede concluir. */
  candidatos: RepescaRow[];
  /** Menor external_id de los candidatos: corte temprano del paginado (mismo
   *  truco anti-throttle que ya usa el barrido principal). */
  stopBeforeId?: number;
  /** Cuántos meses quedan pendientes DESPUÉS de este. Va al log para que se vea
   *  cuántas noches falta para saldar la deuda. */
  mesesRestantes: number;
}

function esFechaValida(f: string | null | undefined): f is string {
  return typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f);
}

/** Último día del mes 'YYYY-MM', como 'YYYY-MM-DD'. */
export function finDeMes(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  // Día 0 del mes siguiente = último día de este. UTC para que no dependa del
  // huso donde corra la función.
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

/**
 * Arma el plan de repesca: elige UN mes (el más viejo con rezagados) y devuelve
 * sus candidatos. `null` cuando no hay nada que repescar — el caso normal una vez
 * saldada la deuda, y el que hace que esto no cueste nada en régimen.
 *
 * @param rows        No-terminales de la tienda, FUERA de la ventana del barrido
 *                    principal (el llamador ya filtró por store_id y por estado).
 * @param ahoraMs     Reloj inyectado — así el comportamiento se puede testear sin
 *                    depender de la fecha en que se corran las pruebas.
 * @param minAgeMs    Edad mínima del registro en Guardian (lag de sync).
 */
export function planRepesca(
  rows: RepescaRow[],
  opts: { ahoraMs: number; minAgeMs: number },
): RepescaPlan | null {
  const { ahoraMs, minAgeMs } = opts;

  const elegibles = (rows || []).filter((r) => {
    if (!r.external_id) return false;          // sin id no hay nada que buscar en Dropi
    if (!esFechaValida(r.fecha)) return false; // sin fecha no se sabe qué mes barrer
    if (!Number.isFinite(Number(r.external_id))) return false;
    // Recién sincronizado: puede ser lag, no un fantasma.
    const alta = r.created_at ? Date.parse(r.created_at) : NaN;
    if (Number.isFinite(alta) && ahoraMs - alta < minAgeMs) return false;
    return true;
  });

  if (elegibles.length === 0) return null;

  // Agrupar por mes de creación: el barrido de Dropi va por rango de fechas, así
  // que el mes es la unidad natural de trabajo.
  const porMes = new Map<string, RepescaRow[]>();
  for (const r of elegibles) {
    const ym = (r.fecha as string).slice(0, 7);
    const lista = porMes.get(ym);
    if (lista) lista.push(r); else porMes.set(ym, [r]);
  }

  const meses = [...porMes.keys()].sort(); // más viejo primero
  const yearMonth = meses[0];
  const candidatos = porMes.get(yearMonth)!;
  const ids = candidatos.map((r) => Number(r.external_id)).filter(Number.isFinite);

  return {
    yearMonth,
    from: `${yearMonth}-01`,
    to: finDeMes(yearMonth),
    candidatos,
    stopBeforeId: ids.length ? Math.min(...ids) : undefined,
    mesesRestantes: meses.length - 1,
  };
}

export interface DecisionRepesca {
  /** Filas a marcar 'ARCHIVADO GHOST'. Vacío = no se toca nada esta corrida. */
  archivar: RepescaRow[];
  /** Por qué se decidió así. Va al log: una repesca que no archiva nada tiene que
   *  poder distinguirse de una que no encontró fantasmas. */
  motivo: string;
}

/**
 * Decide qué archivar cruzando los candidatos contra el barrido del mes.
 *
 * La única conclusión válida es: "el barrido del mes vino COMPLETO y este pedido
 * no está en él, entonces Dropi ya no lo tiene". Cualquier otra cosa —barrido
 * truncado por throttle, barrido vacío, error— NO habilita ninguna conclusión.
 */
export function decidirArchivado(
  plan: RepescaPlan,
  barrido: { ids: Set<string>; complete: boolean; total: number },
  maxPorCorrida: number = REPESCA_MAX_ARCHIVE_PER_RUN,
): DecisionRepesca {
  if (!barrido.complete) {
    return { archivar: [], motivo: `barrido de ${plan.yearMonth} INCOMPLETO (throttle) — no se concluye nada` };
  }
  if (barrido.total < REPESCA_MIN_SWEEP_ORDERS) {
    // Un mes que de verdad no tuvo pedidos tampoco tendría rezagados, así que si
    // llegamos acá con candidatos es que el barrido falló sin decirlo.
    return { archivar: [], motivo: `barrido de ${plan.yearMonth} vino VACÍO con ${plan.candidatos.length} candidatos — sospechoso, no se archiva` };
  }

  const ausentes = plan.candidatos.filter((r) => !barrido.ids.has(String(r.external_id)));
  if (ausentes.length === 0) {
    return { archivar: [], motivo: `${plan.yearMonth}: los ${plan.candidatos.length} candidatos SÍ existen en Dropi — no eran fantasmas` };
  }
  if (ausentes.length > maxPorCorrida) {
    return {
      archivar: [],
      motivo: `${plan.yearMonth}: ${ausentes.length} ausentes supera el tope de ${maxPorCorrida} — se frena por seguridad, revisar a mano`,
    };
  }
  return {
    archivar: ausentes,
    motivo: `${plan.yearMonth}: ${ausentes.length} de ${plan.candidatos.length} ausentes del barrido (${barrido.total} pedidos) → ARCHIVADO GHOST`,
  };
}
