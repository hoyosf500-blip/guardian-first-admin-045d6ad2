// advisorCardVM — el cerebro de la tarjeta por asesor (rediseño Productividad, 26-ago-2026).
//
// El dueño pidió reemplazar las 7 tablas por-asesor (Responsabilidad, Jornada,
// Confirmar, Seguimiento, Novedades, Mezcla, Top) por UNA tarjeta por asesor que
// cuente toda su historia de un vistazo, en vivo, sin ruido — y que el "mama gallo"
// salte a la cara. Esta función PURA junta todas las fuentes que ya existen y arma
// el modelo de vista (VM) de cada tarjeta, con TODOS los guardas de honestidad del
// resto del archivo: un dato que no se pudo medir va `null` y se pinta "—", NUNCA 0.
//
// Testeable sin DOM. La presentación (AdvisorCard) solo dibuja lo que esto calcula.

import { asWorkedBlocks, sumWorkedSeconds, computeHorarioCompliance } from './jornadaMath';
import { bogotaSecondsOfDay, type WorkSchedule } from './inactivityWindow';
import { minutosSinGestion, mayorHuecoEntreBloques, UMBRAL_SIN_GESTION_MIN } from './huecosGestion';
import { gestionesPorHora, ritmoTone, MIN_INTENTOS_POR_HORA } from './operatorThroughput';
import { ritmoVivo, RITMO_VIVO_META } from './ritmoEnVivo';
import { semaforoAsesor, motivoSemaforo, type AsesorScore } from './responsabilidadAsesor';
import { porcentajeDificiles, type MezclaAsesor } from './mezclaAsesor';

export type Tono = 'good' | 'warn' | 'bad' | 'muted';
export type Atencion = 'bad' | 'warn' | 'good' | 'idle';

/** Fila de productividad (subset que la tarjeta usa). */
export interface AdvisorRow {
  operator_id: string;
  display_name: string;
  confirmados: number;
  cancelados: number;
  noresp: number;
  novedades_resueltas: number;
  seg_acciones: number;
  seg_resueltos: number;
  seg_pedidos?: number;
  seg_resueltos_dist?: number;
  rescate_acciones: number;
  rescate_resueltos: number;
  total_atendidos: number;
  intentos_noresp?: number;
  intentos_total?: number;
}

export interface WorkedLite { worked_seconds: number; first_event: string | null; last_event: string | null; blocks: unknown; }
export interface ActivityLite { first_action_at: string | null; last_active_at: string | null; active_seconds: number; idle_seconds: number; }
export interface InactivityLite { warnings_count: number; total_lost_seconds: number; }
export interface LiveLite {
  estado: 'trabajando' | 'presente_sin_marcar' | 'ausente';
  ultimaAccion: string | null;
  lastWorkMin: number | null;
  enLinea: boolean;
  firstSignalMs: number | null;
  hourly: { hora: number; cantidad: number }[];
  total: number;
}

export interface BuildAdvisorsInput {
  rows: AdvisorRow[];
  // ReadonlyMap: solo leemos, y así un Map<string, WorkedRow> (superset) del
  // dashboard encaja sin chocar con la contravarianza del set() de Map.
  workedByOp: ReadonlyMap<string, WorkedLite>;
  activityByOp: ReadonlyMap<string, ActivityLite>;
  inactivityByOp: ReadonlyMap<string, InactivityLite>;
  closingByOp: Record<string, string>;
  closingError: boolean;
  mezcla: ReadonlyMap<string, MezclaAsesor>;
  scoresByOp: ReadonlyMap<string, AsesorScore>;
  liveByOp: ReadonlyMap<string, LiveLite>;
  schedule: WorkSchedule;
  nowMs: number;
  entrantes: number;
  isToday: boolean;
  confTarget: number;
}

/** Métrica con guarda: `value` null = no medido → la UI pinta "—". */
export interface Metrica { value: number | null; tone?: Tono; }

export interface AdvisorVM {
  operatorId: string;
  name: string;
  initials: string;
  // Estado en vivo (solo hoy tiene sentido; en 7d/30d queda null)
  estado: LiveLite['estado'] | null;
  estadoTexto: string | null;   // "Trabajando · marcó hace 1 min"
  enLinea: boolean;
  // Cabecera
  confirmados: number;
  tasaDia: number | null;       // % del día = conf ÷ atendidos
  atendidos: number;
  // Ritmo en vivo (hoy: ritmoVivo 25/15; rango: pedidos/hora sobre horas trabajadas)
  ritmoPorHora: number | null;
  ritmoTono: Tono;
  ritmoTag: string | null;      // "al ritmo" / "sube" / "lento" / "sin medir"
  ritmoCount: number | null;    // cuántas gestiones producen ese ritmo (el "19" no es pedidos, es el RITMO)
  ritmoElapsedMin: number | null; // en cuánto tiempo (hoy: desde la 1ª señal; rango: horas trabajadas)
  // Entrada
  entroHora: string | null;     // ISO de la primera señal (la UI formatea)
  tardeMin: number | null;      // minutos tarde (>0) o null
  hourly: { hora: number; cantidad: number }[];
  // Métricas de la cara (etiquetas en cristiano)
  trabajo: number;              // = atendidos
  contestaron: number;          // conf + canc
  noContesto: number;           // noresp
  devoluciones: number | null;
  // Atención
  atencion: Atencion;
  motivos: string[];            // por qué está en rojo/ámbar, en cristiano
  // Detalle (Ver detalle)
  detalle: AdvisorDetalle;
}

export interface AdvisorDetalle {
  // Calidad
  tasaDevolucion: number | null;
  dirMalas: number | null;      // % en rojo
  evitables: number;
  // Confirmar hondo
  cancelados: number;
  sinCerrarAun: number;         // noresp que siguen sin cerrar (usamos noresp)
  contactoPct: number | null;
  contactoFaltan: number | null;
  clientesHora: number | null;  // producción (conf+canc ÷ horas)
  llamadasHora: number | null;  // esfuerzo (intentos ÷ horas)
  llamadasHoraTono: Tono;
  // Jornada
  cumplioPct: number | null;    // % del horario que ESTUVO presente (no es cuánto trabajó)
  presenciaSec: number | null;  // tiempo presente dentro del horario (entró→última señal ∩ horario)
  enCrmSec: number | null;
  fueraSec: number | null;
  trabajandoSec: number | null;
  avisos: number;
  avisosMin: number;
  sinGestionMin: number | null;
  peorHuecoMin: number | null;
  minPorPedido: number | null;
  cierreIso: string | null;
  cierreTempranoMin: number;
  trabajoExtraMin: number;
  salioTexto: string;           // "cierre" / "en línea" / "sin cierre"
  // Mezcla (descreme)
  dificiles: number;
  faciles: number;
  otrosMezcla: number;
  pctDificiles: number | null;
  // Seguimiento / Novedades
  segAcciones: number;
  segResueltos: number;
  segTasa: number | null;
  novResueltas: number;
}

function iniciales(nombre: string): string {
  const p = (nombre || '').trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return '?';
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

function haceTexto(min: number | null): string {
  if (min == null) return '';
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  return `hace ${Math.floor(min / 60)} h`;
}

const ESTADO_TXT: Record<LiveLite['estado'], string> = {
  trabajando: 'Trabajando',
  presente_sin_marcar: 'Presente sin marcar',
  ausente: 'Ausente',
};

export function buildAdvisorVMs(input: BuildAdvisorsInput): AdvisorVM[] {
  const { schedule, nowMs, entrantes, isToday } = input;

  const vms = input.rows.map((r): AdvisorVM => {
    const id = r.operator_id;
    const live = isToday ? input.liveByOp.get(id) ?? null : null;
    const worked = input.workedByOp.get(id);
    const act = input.activityByOp.get(id);
    const inact = input.inactivityByOp.get(id);
    const score = input.scoresByOp.get(id) ?? null;
    const mez = input.mezcla.get(id) ?? null;

    const atendidos = Number(r.total_atendidos) || 0;
    const contestaron = r.confirmados + r.cancelados;
    // % del día = confirmó ÷ trabajó (misma matemática del aro del equipo).
    const tasaDia = atendidos > 0 ? Math.min(100, Math.round((r.confirmados / atendidos) * 100)) : null;

    // ── Ritmo ────────────────────────────────────────────────────────────────
    // Hoy: velocidad EN VIVO con la vara estricta del dueño (25/15) sobre las
    // gestiones del día y la primera señal. En 7d/30d no hay "vivo": se usa
    // pedidos/hora sobre horas TRABAJADAS (evidencia), como la tabla vieja.
    let ritmoPorHora: number | null = null;
    let ritmoTono: Tono = 'muted';
    let ritmoTag: string | null = null;
    // El "19" que confunde al dueño NO es "19 pedidos": es el RITMO. Guardamos
    // el conteo real y el tiempo que le tomó para que la tarjeta muestre
    // "marcó 98 en 5h 05m", y ahí el 19/hora se lea como lo que es.
    let ritmoCount: number | null = null;
    let ritmoElapsedMin: number | null = null;
    if (isToday && live) {
      const rv = ritmoVivo({ gestionados: live.total, desdeMs: live.firstSignalMs, nowMs, faltan: 0 });
      ritmoPorHora = rv.porHora;
      ritmoCount = live.total;
      ritmoElapsedMin = live.firstSignalMs != null
        ? Math.max(0, Math.round((nowMs - live.firstSignalMs) / 60000))
        : null;
      if (rv.porHora == null) { ritmoTono = 'muted'; ritmoTag = 'midiendo'; }
      else if (rv.vaLento) { ritmoTono = 'bad'; ritmoTag = 'lento'; }
      else if (rv.bajoOptimo) { ritmoTono = 'warn'; ritmoTag = `sube (óptimo ${RITMO_VIVO_META})`; }
      else { ritmoTono = 'good'; ritmoTag = 'al ritmo'; }
    } else {
      const intentosRitmo = r.intentos_total ?? atendidos;
      const iph = gestionesPorHora(intentosRitmo, worked?.worked_seconds);
      ritmoPorHora = iph == null ? null : Math.round(iph * 10) / 10;
      ritmoCount = intentosRitmo;
      const wsRitmo = worked ? Number(worked.worked_seconds) : NaN;
      ritmoElapsedMin = Number.isFinite(wsRitmo) && wsRitmo > 0 ? Math.round(wsRitmo / 60) : null;
      if (iph == null) { ritmoTono = 'muted'; ritmoTag = null; }
      else {
        const t = ritmoTone(iph, MIN_INTENTOS_POR_HORA);
        ritmoTono = t === 'muted' ? 'muted' : (t as Tono);
        ritmoTag = null;
      }
    }

    // ── Jornada (solo hoy tiene puntualidad/huecos; el resto sí en rango) ──────
    const blocks = worked ? asWorkedBlocks(worked.blocks) : [];
    const wsNum = worked ? Number(worked.worked_seconds) : NaN;
    const trabajandoSec = worked ? (Number.isFinite(wsNum) && wsNum > 0 ? wsNum : sumWorkedSeconds(blocks)) : null;

    const firstSignalMs = Math.min(
      Date.parse(worked?.first_event ?? '') || Infinity,
      Date.parse(act?.first_action_at ?? '') || Infinity,
    );
    const turnoStart = Number.isFinite(firstSignalMs) ? new Date(firstSignalMs).toISOString() : null;
    const lastSignalMs = Math.max(
      Date.parse(worked?.last_event ?? '') || 0,
      Date.parse(act?.last_active_at ?? '') || 0,
    );
    const turnoEnd = lastSignalMs > 0 ? new Date(lastSignalMs).toISOString() : null;
    const comp = isToday ? computeHorarioCompliance({ turnoStart, turnoEnd, schedule, nowMs }) : null;
    const cumplioPct = comp?.cumplimientoPctTranscurrido ?? null;
    // Presencia REAL en el horario (entró→última señal ∩ horario − almuerzo). Es el
    // "estuvo", NO el "trabajó": por eso puede dar 96% con solo 3h de trabajo medido.
    const presenciaSec = comp?.cubiertoSec ?? null;
    const tardeMin = isToday && comp && (comp.tardeMin ?? 0) > 0 ? comp.tardeMin ?? null : null;

    const enCrmSec = act ? (Number(act.active_seconds) || 0) + (Number(act.idle_seconds) || 0) : null;
    const fueraSec = comp && enCrmSec != null
      ? Math.max(0, (comp.horarioTranscurridoSec ?? comp.horarioNetoSec) - enCrmSec)
      : null;

    const sinGestionMin = isToday
      ? minutosSinGestion(Date.parse(worked?.last_event ?? '') || null, nowMs, schedule)
      : null;
    const peorHuecoMin = isToday
      ? mayorHuecoEntreBloques(
          blocks.map((b) => ({ startMs: Date.parse(b.start), endMs: Date.parse(b.end) }))
            .filter((b) => Number.isFinite(b.startMs) && Number.isFinite(b.endMs)),
          schedule,
        )
      : null;

    const intentos = r.intentos_total ?? atendidos;
    const minPorPedido = trabajandoSec != null && trabajandoSec > 0 && intentos > 0
      ? Math.round(trabajandoSec / 60 / intentos)
      : null;

    const lastWorkEventMs = Date.parse(worked?.last_event ?? '') || 0;
    const trabajoExtraMin = isToday && lastWorkEventMs > 0
      ? Math.max(0, Math.round((bogotaSecondsOfDay(new Date(lastWorkEventMs)) - schedule.workEndSec) / 60))
      : 0;

    const cierreIso = input.closingByOp[id] ?? null;
    const cierreTempranoMin = isToday && cierreIso
      ? Math.max(0, Math.round((schedule.workEndSec - bogotaSecondsOfDay(new Date(cierreIso))) / 60))
      : 0;
    const salioTexto = input.closingError ? 'sin dato' : cierreIso ? 'cierre' : live?.enLinea ? 'en línea' : 'sin cierre';

    // ── Confirmar hondo ───────────────────────────────────────────────────────
    const contactoPct = entrantes > 0 ? Math.min(100, Math.round((contestaron / entrantes) * 100)) : null;
    const contactoFaltan = entrantes > 0 ? Math.max(0, entrantes - contestaron) : null;
    const clientesHoraRaw = gestionesPorHora(contestaron, worked?.worked_seconds);
    const clientesHora = clientesHoraRaw == null ? null : Math.round(clientesHoraRaw * 10) / 10;
    const llamadasHoraRaw = gestionesPorHora(intentos, worked?.worked_seconds);
    const llamadasHora = llamadasHoraRaw == null ? null : Math.round(llamadasHoraRaw * 10) / 10;
    const llTone = llamadasHoraRaw == null ? 'muted' : (ritmoTone(llamadasHoraRaw, MIN_INTENTOS_POR_HORA) as Tono);

    // ── Mezcla (descreme) ─────────────────────────────────────────────────────
    const dificiles = mez ? mez.dificiles : 0;
    const faciles = mez ? mez.faciles : 0;
    const otrosMezcla = mez ? mez.sin_dato + mez.sinSenal : 0;
    const pctDificiles = mez ? porcentajeDificiles(mez) : null;

    // ── Seguimiento / Novedades ───────────────────────────────────────────────
    const segDenom = r.seg_pedidos != null && r.seg_resueltos_dist != null ? r.seg_pedidos : r.seg_acciones;
    const segRes = r.seg_pedidos != null && r.seg_resueltos_dist != null ? r.seg_resueltos_dist : r.seg_resueltos;
    const segTasa = segDenom > 0 ? Math.round((segRes / segDenom) * 100) : null;

    // ── Calidad ───────────────────────────────────────────────────────────────
    const tasaDevolucion = score?.tasaDevolucion ?? null;
    const dirMalas = score?.pctEnRojo ?? null;
    const devoluciones = score ? score.devoluciones : null;
    const evitables = score ? score.evitables : 0;

    // ── Atención + motivos (en cristiano) ─────────────────────────────────────
    const motivos: string[] = [];
    let atencion: Atencion;
    const semaforo = score ? semaforoAsesor(score) : 'neutro';
    if (score) {
      const m = motivoSemaforo(score);
      if (m) motivos.push(m);
    }
    // Señales EN VIVO que la tabla vieja no juntaba en un solo lugar:
    if (isToday) {
      if (tardeMin != null && tardeMin > 0) motivos.push(`entró ${tardeMin >= 60 ? `${Math.floor(tardeMin / 60)} h ${tardeMin % 60} min` : `${tardeMin} min`} tarde`);
      if (sinGestionMin != null && sinGestionMin >= UMBRAL_SIN_GESTION_MIN) motivos.push(`sin marcar hace ${sinGestionMin} min`);
      if (live && live.estado === 'presente_sin_marcar') motivos.push('presente pero sin marcar');
    }
    const inflowSuelto = isToday && entrantes > 0;
    const sinDato = atendidos === 0 && r.confirmados === 0 && (!live || live.estado === 'ausente');
    if (sinDato) {
      atencion = 'idle';
    } else if (semaforo === 'rojo' || (ritmoTono === 'bad') || (sinGestionMin != null && sinGestionMin >= UMBRAL_SIN_GESTION_MIN) || (tardeMin != null && tardeMin >= 30)) {
      atencion = 'bad';
    } else if (semaforo === 'ambar' || ritmoTono === 'warn' || motivos.length > 0) {
      atencion = 'warn';
    } else {
      atencion = 'good';
    }
    void inflowSuelto;

    const avisos = inact ? Number(inact.warnings_count) || 0 : 0;
    const avisosMin = inact ? Math.round((Number(inact.total_lost_seconds) || 0) / 60) : 0;

    // Texto de estado (hoy): "Trabajando · marcó hace 1 min"
    let estadoTexto: string | null = null;
    if (isToday && live) {
      const h = live.ultimaAccion ? `${live.ultimaAccion} ${haceTexto(live.lastWorkMin)}` : (live.estado === 'ausente' ? 'sin señal hoy' : 'sin marcar aún');
      estadoTexto = `${ESTADO_TXT[live.estado]} · ${h}`;
    }

    return {
      operatorId: id,
      name: r.display_name,
      initials: iniciales(r.display_name),
      estado: live?.estado ?? null,
      estadoTexto,
      enLinea: Boolean(live?.enLinea),
      confirmados: r.confirmados,
      tasaDia,
      atendidos,
      ritmoPorHora,
      ritmoTono,
      ritmoTag,
      ritmoCount,
      ritmoElapsedMin,
      entroHora: isToday ? turnoStart : null,
      tardeMin,
      hourly: live?.hourly ?? [],
      trabajo: atendidos,
      contestaron,
      noContesto: r.noresp,
      devoluciones,
      atencion,
      motivos,
      detalle: {
        tasaDevolucion, dirMalas, evitables,
        cancelados: r.cancelados,
        sinCerrarAun: r.noresp,
        contactoPct, contactoFaltan,
        clientesHora, llamadasHora, llamadasHoraTono: llTone,
        cumplioPct, presenciaSec, enCrmSec, fueraSec, trabajandoSec,
        avisos, avisosMin,
        sinGestionMin, peorHuecoMin, minPorPedido,
        cierreIso, cierreTempranoMin, trabajoExtraMin, salioTexto,
        dificiles, faciles, otrosMezcla, pctDificiles,
        segAcciones: r.seg_acciones, segResueltos: segRes, segTasa,
        novResueltas: r.novedades_resueltas,
      },
    };
  });

  return sortByAttention(vms);
}

/** Orden: primero los que hay que REVISAR (bad), luego ojo (warn), luego bien
 *  (good, por confirmados desc), y al fondo los sin actividad (idle). */
export function sortByAttention(vms: AdvisorVM[]): AdvisorVM[] {
  const rank: Record<Atencion, number> = { bad: 0, warn: 1, good: 2, idle: 3 };
  return [...vms].sort((a, b) =>
    rank[a.atencion] - rank[b.atencion] ||
    b.confirmados - a.confirmados ||
    a.name.localeCompare(b.name),
  );
}
