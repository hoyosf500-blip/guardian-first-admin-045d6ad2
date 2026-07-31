// Matemática pura de la sección Jornada del dashboard de productividad.
//
// PROBLEMA que resuelve (verificado en producción 2026-07-01): el heartbeat
// (useOperatorHeartbeat) solo acumula segundos mientras la pestaña del CRM
// está ABIERTA. Si la operadora cierra la pestaña, ese rato no suma ni a
// activo ni a inactivo → el viejo "% Activa" = activo ÷ (activo + inactivo)
// mostró 99% cuando el real era ~41%: empezó 7:27, última actividad 9:07
// (100 min transcurridos) pero activo+inactivo del heartbeat = 42 min →
// ~58 min con el CRM CERRADO que la UI escondía.
//
// Acá todo se calcula sobre la VENTANA REAL (última actividad − primer
// movimiento del día):
//
//   hueco         = ventana − (activo + inactivo)  → minutos con el CRM CERRADO
//   pctActivaReal = activo ÷ ventana               → % sobre tiempo transcurrido
//   desconectada  = ahora − última actividad       → hace cuánto no da señales
//
// Funciones puras, sin red, sin DOM, country-agnostic — testeables con Vitest.
//
// ⚠ CONTRATO: esta matemática SOLO es válida para ventanas de UN día
// (range='today'). En 7d/30d operator_activity_stats devuelve
// MIN(first_action_at) / MAX(last_active_at) / SUM(seconds) agregados sobre
// todo el rango, así que la "ventana" incluiría noches y días libres →
// hueco ≈ 100h+, % real ≈ 5-20% y alertas absurdas ("167h sin confirmar").
// El caller (ProductivityDashboard) gatea con range==='today' y cae al
// cálculo viejo activo ÷ (activo + inactivo) en rangos multi-día.

import { workingSecondsLost, bogotaSecondsOfDay, type WorkSchedule } from './inactivityWindow';

/** Minutos de hueco (CRM cerrado) a partir de los cuales se muestra el chip ámbar. */
export const UMBRAL_HUECO_MIN = 10;
/** Minutos sin actividad desde la última señal para mostrar el badge "desconectada". */
export const UMBRAL_DESCONECTADA_MIN = 10;
/** Minutos desde que empezó sin NINGUNA confirmación (con cola) para alertar en rojo. */
export const UMBRAL_SIN_CONF_MIN = 120;

export interface JornadaRealInput {
  /** `first_action_at` de operator_activity_stats (ISO). Primer movimiento del día. */
  startedAt: string | null | undefined;
  /** `last_active_at` (ISO). Último movimiento detectado. */
  lastActivityAt: string | null | undefined;
  /** `active_seconds` del heartbeat (segundos). */
  activeSeconds: number | null | undefined;
  /** `idle_seconds` del heartbeat (segundos). */
  idleSeconds: number | null | undefined;
  /** `Date.now()` del render — se inyecta para que el cálculo sea determinístico en tests. */
  nowMs: number;
}

export interface JornadaReal {
  /** Ventana transcurrida (última act. − empezó) en minutos. null si faltan timestamps. */
  elapsedMin: number | null;
  /** active_seconds en minutos. null si el dato falta o es inválido. */
  activoMin: number | null;
  /** idle_seconds en minutos. null si el dato falta o es inválido. */
  inactivoMin: number | null;
  /** Minutos de la ventana SIN heartbeat (pestaña del CRM cerrada). Nunca negativo. */
  huecoMin: number | null;
  /** activo ÷ ventana, 0..1. Ventana 0 → 0. null si faltan timestamps. */
  pctActivaReal: number | null;
  /** Minutos desde la última actividad hasta `nowMs` (para el badge "desconectada hace Xm"). */
  desconectadaMin: number | null;
}

function parseTsMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

function safeSeconds(s: number | null | undefined): number | null {
  if (s == null || !Number.isFinite(s)) return null;
  return Math.max(0, s);
}

/**
 * Calcula la jornada REAL de una operadora sobre el tiempo transcurrido,
 * no solo sobre los segundos que el heartbeat alcanzó a registrar.
 *
 * Reglas:
 * - ventana = lastActivityAt − startedAt, con CLAMP a >= (activo + inactivo):
 *   así el hueco jamás da negativo aunque los relojes vengan desfasados o
 *   `last < started` (dato corrupto → degrada a hueco 0, no a basura).
 * - huecoMin = ventana − (activo + inactivo) → minutos con el CRM CERRADO.
 * - pctActivaReal = activo ÷ ventana (0..1; ventana 0 → 0).
 * - desconectadaMin = (nowMs − lastActivityAt) en minutos, clamp a >= 0.
 * - Si falta un timestamp, los campos que dependen de él vuelven null (la UI
 *   muestra '—' / no muestra chip) — nunca inventa números.
 */
export function computeJornadaReal(input: JornadaRealInput): JornadaReal {
  const startMs = parseTsMs(input.startedAt);
  const lastMs = parseTsMs(input.lastActivityAt);
  const activeS = safeSeconds(input.activeSeconds);
  const idleS = safeSeconds(input.idleSeconds);

  const activoMin = activeS == null ? null : Math.round(activeS / 60);
  const inactivoMin = idleS == null ? null : Math.round(idleS / 60);

  let elapsedMin: number | null = null;
  let huecoMin: number | null = null;
  let pctActivaReal: number | null = null;

  if (startMs != null && lastMs != null) {
    const heartbeatS = (activeS ?? 0) + (idleS ?? 0);
    // Clamp: la ventana nunca es menor que lo que el heartbeat ya registró
    // (ni negativa) → huecoMin >= 0 SIEMPRE.
    const windowS = Math.max((lastMs - startMs) / 1000, heartbeatS, 0);
    elapsedMin = Math.round(windowS / 60);
    huecoMin = Math.round((windowS - heartbeatS) / 60);
    pctActivaReal = windowS > 0 ? Math.min(1, Math.max(0, (activeS ?? 0) / windowS)) : 0;
  }

  const desconectadaMin =
    lastMs != null && Number.isFinite(input.nowMs)
      ? Math.max(0, Math.floor((input.nowMs - lastMs) / 60000))
      : null;

  return { elapsedMin, activoMin, inactivoMin, huecoMin, pctActivaReal, desconectadaMin };
}

// ─────────────────────────────────────────────────────────────────────────────
// HORAS REALES por evidencia de trabajo (RPC operator_worked_blocks).
// La Jornada dejó de liderar con el heartbeat de mouse (que subcuenta el trabajo
// telefónico) y ahora muestra "Trabajó Xh" = suma de los bloques donde la
// operadora registró acciones reales (order_results + touchpoints). Estas
// funciones puras parsean/formatean lo que devuelve el RPC.
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkedBlock {
  /** ISO del primer evento del bloque. */
  start: string;
  /** ISO del último evento del bloque. */
  end: string;
  /** Cantidad de acciones (order_results + touchpoints) dentro del bloque. */
  events: number;
  /** Duración del bloque en segundos (>= c_min_block_sec del RPC). */
  sec: number;
}

function isWorkedBlock(v: unknown): v is WorkedBlock {
  if (v == null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.start === 'string' &&
    typeof o.end === 'string' &&
    typeof o.events === 'number' &&
    typeof o.sec === 'number' &&
    Number.isFinite(o.events) &&
    Number.isFinite(o.sec)
  );
}

/**
 * Parseo DEFENSIVO del jsonb `blocks` de operator_worked_blocks. Nunca tira:
 * si el input no es un array (o viene null porque la migration no se aplicó
 * todavía), devuelve []; filtra entradas con forma inválida. Así un cambio de
 * shape del RPC degrada a "sin bloques", nunca rompe el dashboard.
 */
export function asWorkedBlocks(raw: unknown): WorkedBlock[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isWorkedBlock);
}

/**
 * Suma de segundos trabajados a partir de los bloques. Se usa como fallback si
 * `worked_seconds` del RPC viniera null/negativo — el número debe salir de la
 * misma fuente que los bloques que se muestran, para que "Trabajó" y el detalle
 * de bloques SIEMPRE reconcilien.
 */
export function sumWorkedSeconds(blocks: WorkedBlock[]): number {
  return blocks.reduce((acc, b) => acc + Math.max(0, b.sec), 0);
}

/**
 * Etiqueta compacta de los bloques del día, usando un formateador de hora
 * INYECTADO (para testear sin depender de Intl/zona horaria del runner).
 * Ej con fmt = hora Bogotá: "9:12 a. m.–1:40 p. m. · 6:30 p. m.–8:18 p. m.".
 */
export function blockRangeLabel(blocks: WorkedBlock[], fmt: (iso: string) => string): string {
  return blocks.map((b) => `${fmt(b.start)}–${fmt(b.end)}`).join(' · ');
}

export interface SinConfirmarInput {
  /** Confirmados del período (columna `confirmados` de operator_productivity_stats). */
  conf: number | null | undefined;
  /** Inflow global del período (`total_entrantes`). */
  entrantes: number | null | undefined;
  /** `pendientes_sin_tocar` (v4, puede venir undefined si la migration no está). */
  pendientesSinTocar: number | null | undefined;
  /** `first_action_at` de operator_activity_stats para ESTA operadora. */
  startedAt: string | null | undefined;
  nowMs: number;
  /** Umbral en minutos (default UMBRAL_SIN_CONF_MIN = 120). */
  umbralMin?: number;
}

/**
 * true cuando una operadora lleva `umbralMin`+ minutos de jornada con CERO
 * confirmaciones Y hay pedidos en cola (entrantes o pendientes sin tocar).
 *
 * Conservadora a propósito: si `conf` viene null/undefined (dato faltante) o
 * no hay `startedAt` de actividad para la operadora, NO alerta — solo alerta
 * con evidencia real de "empezó hace rato, hay cola y no confirmó nada".
 */
export function shouldAlertSinConfirmar(input: SinConfirmarInput): boolean {
  const umbral = input.umbralMin ?? UMBRAL_SIN_CONF_MIN;
  // Solo alerta con CERO confirmaciones REALES; dato faltante no es evidencia.
  if (input.conf !== 0) return false;
  const hayCola = (input.entrantes ?? 0) > 0 || (input.pendientesSinTocar ?? 0) > 0;
  if (!hayCola) return false;
  const startMs = parseTsMs(input.startedAt);
  if (startMs == null || !Number.isFinite(input.nowMs)) return false;
  return (input.nowMs - startMs) / 60000 >= umbral;
}

// ─────────────────────────────────────────────────────────────────────────────
// "CUMPLIÓ EL HORARIO" — asistencia vs el horario pactado (decisión del dueño
// 2026-07-18). El dueño DESCUENTA sueldo sobre esto, así que la pregunta no es
// "¿cuántos minutos productivos?" sino "¿me cumplió el horario? ¿entró a tiempo y
// se quedó hasta la salida?".
//
// REGLA CLAVE (pedido explícito): NO penalizar "estar quieta". Si está en una
// llamada con un cliente no mueve el mouse, y eso NO puede restarle. Por eso el %
// se mide sobre la VENTANA entró→salió (dentro del horario, menos almuerzo), sin
// descontar los ratos sin movimiento. Los dos datos duros y confiables son la
// hora de ENTRADA (primera señal) y la de SALIDA (última señal) — de ahí salen
// "llegó tarde" y "se fue temprano".
//
// Punto ciego conocido (aceptado por el dueño a cambio de no castigar el trabajo
// telefónico): si abre el CRM, se va con la pestaña cerrada y vuelve al final, la
// ventana entró→salió la cuenta como presente. La tabla de Confirmar (Intentos/h,
// marcando) es el contrapeso: presencia 100% con 0 marcado = saltó a la vista.
// ─────────────────────────────────────────────────────────────────────────────

export interface HorarioComplianceInput {
  /** Primera señal del día (ISO): la más temprana entre acción de trabajo y mouse. */
  turnoStart: string | null | undefined;
  /** Última señal del día (ISO): la más reciente entre acción de trabajo y mouse. */
  turnoEnd: string | null | undefined;
  /** Horario de la tienda (segundos-del-día) — excluye almuerzo. */
  schedule: WorkSchedule;
}

export interface HorarioCompliance {
  /** ms de la entrada (primera señal). null si falta. */
  entradaMs: number | null;
  /** ms de la salida (última señal). null si falta. */
  salidaMs: number | null;
  /** Segundos del horario que cubrió (ventana entró→salió ∩ horario − almuerzo). */
  cubiertoSec: number | null;
  /** Segundos netos del horario pactado (jornada − almuerzo). */
  horarioNetoSec: number;
  /** cubierto ÷ horarioNeto, 0-100. null si no hay ventana. */
  cumplimientoPct: number | null;
  /** Minutos que llegó TARDE respecto al inicio del horario (0 si puntual/antes). */
  tardeMin: number | null;
  /** Minutos que salió ANTES del fin del horario (0 si cumplió/se quedó). */
  tempranoMin: number | null;
}

/** Segundos netos del horario pactado (jornada − almuerzo, solo el solapamiento). */
export function horarioNetoSeconds(s: WorkSchedule): number {
  const shift = Math.max(0, s.workEndSec - s.workStartSec);
  const lunch = Math.max(0, Math.min(s.lunchEndSec, s.workEndSec) - Math.max(s.lunchStartSec, s.workStartSec));
  return Math.max(0, shift - lunch);
}

/**
 * Cumplimiento del horario a partir de la ventana entró→salió. NO usa el heartbeat
 * de mouse ni resta inactividad (una operadora en llamada no mueve el mouse y eso
 * no puede castigarla). Solo válido para UN día (range='today'): en multi-día la
 * ventana MIN→MAX cruza fechas y `workingSecondsLost` devuelve 0 — el caller cae a
 * las horas trabajadas del rango.
 */
export function computeHorarioCompliance(input: HorarioComplianceInput): HorarioCompliance {
  const horarioNetoSec = horarioNetoSeconds(input.schedule);
  const entradaMs = parseTsMs(input.turnoStart);
  const salidaMs = parseTsMs(input.turnoEnd);
  const base: HorarioCompliance = {
    entradaMs, salidaMs, cubiertoSec: null, horarioNetoSec,
    cumplimientoPct: null, tardeMin: null, tempranoMin: null,
  };
  if (entradaMs == null || salidaMs == null || salidaMs <= entradaMs) return base;

  // Ventana entró→salió ∩ horario − almuerzo. NO se descuenta inactividad.
  const cubiertoSec = workingSecondsLost(new Date(entradaMs), new Date(salidaMs), input.schedule);
  const cumplimientoPct = horarioNetoSec > 0
    ? Math.min(100, Math.round((cubiertoSec / horarioNetoSec) * 100))
    : null;

  // Tarde / temprano por segundo-del-día Bogotá vs el horario pactado.
  const entradaSod = bogotaSecondsOfDay(new Date(entradaMs));
  const salidaSod = bogotaSecondsOfDay(new Date(salidaMs));
  const tardeMin = Math.max(0, Math.round((entradaSod - input.schedule.workStartSec) / 60));
  const tempranoMin = Math.max(0, Math.round((input.schedule.workEndSec - salidaSod) / 60));

  return { entradaMs, salidaMs, cubiertoSec, horarioNetoSec, cumplimientoPct, tardeMin, tempranoMin };
}
