import { bogotaSecondsOfDay } from './inactivityWindow';

/**
 * "Entraste 32 min tarde · 3ª vez esta semana".
 *
 * ── Por qué existe (3-sep-2026) ─────────────────────────────────────────────
 * Pedido del dueño: *"si entran tarde que les salga una advertencia"*. El dato
 * ya se calculaba (`jornadaMath.computeHorarioCompliance` → `tardeMin`) pero
 * **solo lo veía él**, en la tarjeta de Productividad. La asesora nunca se
 * enteraba, así que no podía corregirse sola y cada conversación arrancaba de
 * cero.
 *
 * El acumulado de la semana es la parte que cambia la conducta: el reto de un
 * día se olvida, "3ª vez esta semana" no.
 *
 * ── Lo que estas funciones se niegan a hacer ────────────────────────────────
 * ⛔ **No inventan una hora.** Sin marca de entrada devuelven `null`, que la
 * pantalla dibuja como "no se midió". Un turno anunciado con una hora inventada
 * es peor que no anunciarlo: después no cuadra con el reporte y quien queda mal
 * es el sistema.
 * ⛔ **Un margen de gracia, y está escrito.** Menos de {@link GRACIA_MIN} no es
 * llegar tarde: es el reloj del navegador, el login, o que el CRM abrió lento.
 * Acusar por dos minutos quema la herramienta.
 */

/** Debajo de esto no se dice nada. El primer latido llega cuando la persona ya
 *  se sentó, abrió el navegador y cargó la app: eso solo ya son minutos. */
export const GRACIA_MIN = 5;

/**
 * Minutos de retraso respecto de la hora de apertura de la tienda.
 *
 * @param entradaIso  primera señal de actividad del día (`first_action_at`)
 * @param workStartMin hora de apertura, en minutos desde medianoche (Bogotá)
 * @returns minutos tarde, `0` si llegó a horario o dentro de la gracia,
 *          `null` si no se puede medir.
 */
export function minutosTarde(
  entradaIso: string | null | undefined,
  workStartMin: number | null | undefined,
): number | null {
  if (!entradaIso) return null;
  if (workStartMin == null || !Number.isFinite(workStartMin)) return null;
  const t = Date.parse(entradaIso);
  if (!Number.isFinite(t)) return null;
  const entradaMin = bogotaSecondsOfDay(new Date(t)) / 60;
  const diff = Math.round(entradaMin - workStartMin);
  if (diff <= GRACIA_MIN) return 0;
  return diff;
}

/** ¿Cuenta como tardanza? Solo un retraso medido y por encima de la gracia. */
export function llegoTarde(min: number | null): boolean {
  return min != null && min > 0;
}

/**
 * Cuántas veces llegó tarde en las entradas dadas (incluida la de hoy).
 *
 * Las que no se pudieron medir **no suman**: no saber a qué hora entró alguien
 * no es prueba de que llegó tarde.
 */
export function contarTardanzas(
  entradas: Array<string | null | undefined>,
  workStartMin: number | null | undefined,
): number {
  let n = 0;
  for (const e of entradas) if (llegoTarde(minutosTarde(e, workStartMin))) n += 1;
  return n;
}

/** "1ª", "2ª", "3ª"… en femenino, que es como se dice "vez". */
export function ordinalFem(n: number): string {
  return `${Math.max(1, Math.round(n))}ª`;
}

/** "32 min" · "1 h 05 min". Un retraso de dos horas en minutos no se lee. */
export function retrasoLegible(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')} min`;
}

export interface AvisoEntrada {
  /** Minutos tarde. `null` = no se midió; `0` = puntual. */
  tardeMin: number | null;
  /** Cuántas veces llegó tarde en la ventana mirada, contando hoy. */
  vecesEnLaSemana: number;
  /** El texto listo, o `null` si no hay nada que decir. */
  texto: string | null;
}

/**
 * El aviso completo, listo para pintar.
 *
 * Puntual → `texto: null`: no se le dice nada, el chip verde de "Turno iniciado"
 * ya es todo el mensaje. Solo se habla cuando hay algo que decir.
 */
export function avisoEntrada(
  entradaHoyIso: string | null | undefined,
  entradasPrevias: Array<string | null | undefined>,
  workStartMin: number | null | undefined,
): AvisoEntrada {
  const tardeMin = minutosTarde(entradaHoyIso, workStartMin);
  const veces = contarTardanzas([entradaHoyIso, ...entradasPrevias], workStartMin);
  if (!llegoTarde(tardeMin)) return { tardeMin, vecesEnLaSemana: veces, texto: null };
  const base = `${retrasoLegible(tardeMin as number)} tarde`;
  // La primera vez no lleva contador: "1ª vez esta semana" se lee como una
  // amenaza sobre algo que todavía no es un patrón.
  return {
    tardeMin,
    vecesEnLaSemana: veces,
    texto: veces > 1 ? `${base} · ${ordinalFem(veces)} vez esta semana` : base,
  };
}
