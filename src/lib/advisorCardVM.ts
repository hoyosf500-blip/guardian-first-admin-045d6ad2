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
import { ritmoSeguimiento, RITMO_SEG_META } from './ritmoSeguimiento';
import { semaforoAsesor, motivoSemaforo, type AsesorScore } from './responsabilidadAsesor';
import { porcentajeDificiles, type MezclaAsesor } from './mezclaAsesor';

export type Tono = 'good' | 'warn' | 'bad' | 'muted';
export type Atencion = 'bad' | 'warn' | 'good' | 'idle';

/**
 * En qué carril trabajó la persona. Decide QUÉ cuatro cajas se le muestran.
 *
 * ── Por qué existe (28-ago-2026) ────────────────────────────────────────────
 * Las cuatro cajas de la cara (`trabajó · contestaron · no contestó ·
 * devoluciones`) salen todas de `total_atendidos` / `confirmados` / `noresp`,
 * y esas tres columnas de la RPC filtran `module='confirmar'`. O sea que a quien
 * pasó el día en Seguimiento le decían **0 · 0 · 0**.
 *
 * Es literal la queja del dueño: *"Roberto se ha dedicado a Seguimiento y la
 * tabla no bajó para nada ni se contó en productividad"*. No era un cálculo
 * malo: era que su trabajo no tenía por dónde entrar a esas cajas.
 *
 * `ninguno` cae en las cajas de Confirmar a propósito: una tarjeta sin actividad
 * tiene que seguir viéndose como siempre.
 */
export type Carril = 'confirmar' | 'seguimiento' | 'ambos' | 'ninguno';

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

/** Info del roster para un asesor SIN actividad en el rango: desde cuándo no
 *  trabaja. Permite pintar "sin trabajar hace X días" en vez de esconderlo. */
export interface RosterLite { role: 'operator' | 'supervisor'; lastActivityIso: string | null; }
export interface WorkedLite { worked_seconds: number; first_event: string | null; last_event: string | null; blocks: unknown; }
export interface ActivityLite { first_action_at: string | null; last_active_at: string | null; active_seconds: number; idle_seconds: number; }
export interface InactivityLite { warnings_count: number; total_lost_seconds: number; }
export interface LiveLite {
  estado: 'trabajando' | 'presente_sin_marcar' | 'ausente';
  ultimaAccion: string | null;
  lastWorkMin: number | null;
  enLinea: boolean;
  firstSignalMs: number | null;
  total: number;
  /** Gestiones de HOY por carril + el reloj de cada uno. Opcionales para que un
   *  llamador viejo (o un test) siga compilando: sin ellos no hay ritmo de
   *  Seguimiento, y no haberlo es honesto — inventarlo no. */
  confirmar?: number;
  seguimiento?: number;
  novedades?: number;
  firstConfirmarMs?: number | null;
  firstSegMs?: number | null;
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
  /** ¿La lectura de "última marca" del día está COMPLETA? `false` = falló o se
   *  cortó por el tope de filas de `useLiveTeam`. Con false, "sin marcar" NO se
   *  puede afirmar: es un hueco de lectura, no un cero. Default true para no
   *  cambiar el comportamiento de quien todavía no lo pasa. */
  workEventsOk?: boolean;
  /** Roster completo (para mostrar inactivos con su "última vez"). Opcional: sin
   *  él, un asesor sin actividad simplemente no trae días de inactividad. */
  rosterByOp?: ReadonlyMap<string, RosterLite>;
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
  // Asesor SIN actividad en el rango (no gestionó nada). Para "sin trabajar hace
  // X días" — el que dejó de venir, que antes se escondía. null = sí trabajó.
  inactivoDias: number | null;
  ultimaVezIso: string | null;
  // Se ACTIVÓ hoy (hizo apertura / entró) pero todavía no marcó nada. El "presente
  // sin marcar" que el dueño quiere ver salir aunque no haya gestionado.
  soloApertura: boolean;
  // Cabecera
  confirmados: number;
  tasaDia: number | null;       // % del día = conf ÷ atendidos (SOLO Confirmar)
  atendidos: number;
  /**
   * El aro grande, POR CARRIL. `tasaDia` es confirmar-only, así que a quien
   * trabajó Seguimiento el aro le quedaba vacío con un "—" al lado de una
   * tarjeta llena de trabajo — el dueño lo reportó como *"ya marca pero la
   * barra no se mueve como Estefano"*. Para ese carril el aro muestra los
   * resueltos sobre los pedidos que tocó.
   */
  anilloPct: number | null;
  /** Qué mide el aro: "del día" (Confirmar) o "resueltos" (Seguimiento). */
  anilloEtiqueta: string;
  // Ritmo en vivo (hoy: ritmoVivo 25/15; rango: pedidos/hora sobre horas trabajadas)
  ritmoPorHora: number | null;
  ritmoTono: Tono;
  ritmoTag: string | null;      // "al ritmo" / "sube" / "lento" / "sin medir"
  ritmoCount: number | null;    // cuántas gestiones producen ese ritmo (el "19" no es pedidos, es el RITMO)
  ritmoElapsedMin: number | null; // en cuánto tiempo (hoy: desde la 1ª señal; rango: horas trabajadas)
  /**
   * Ritmo de SEGUIMIENTO (seguimiento + novedades) con su propia vara 40/25.
   * Solo HOY: en 7d/30d no hay primera marca por carril y partir el ritmo sin
   * ese dato sería inventarlo. `null` también cuando la lectura de marcas quedó
   * truncada — un ritmo calculado con un reloj incompleto sale INFLADO, y decir
   * "al ritmo" de alguien que va lento es tan falso como lo contrario.
   */
  ritmoSegPorHora: number | null;
  ritmoSegTono: Tono;
  ritmoSegTag: string | null;
  /** Gestiones de Seguimiento + Novedades de HOY. Va en la cara de TODA tarjeta
   *  (antes vivía en una línea de 11px condicional a `> 0`). */
  segHoy: number | null;
  ritmoSegElapsedMin: number | null;
  // Entrada
  entroHora: string | null;     // ISO de la primera señal (la UI formatea)
  tardeMin: number | null;      // minutos tarde (>0) o null
  // Métricas de la cara (etiquetas en cristiano)
  trabajo: number;              // = atendidos (SOLO Confirmar)
  /** Gestiones fuera de Confirmar: seguimiento + novedades + rescate. Existe
   *  porque la cara de la tarjeta era confirmar-only y quien trabajaba
   *  Seguimiento se leía "0". */
  otroTrabajo: number;
  /** No tocó Confirmar pero SÍ trabajó. La cabecera muestra ese trabajo en vez
   *  de un cero que se lee como que no hizo nada. */
  soloOtroTrabajo: boolean;
  /** Qué cuatro cajas mostrarle. Ver el comentario de `Carril`. */
  carril: Carril;
  /** Pedidos DISTINTOS que tocó en Seguimiento. `null` si la RPC desplegada
   *  todavía no devuelve la columna — entonces se pinta "—", nunca 0. */
  segPedidos: number | null;
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
  /** Acciones de rescate. Se surfacea porque entra en el carril: si alguien solo
   *  hizo rescate, sin esto la fila de Seguimiento le mostraría ceros — el mismo
   *  error que este cambio vino a corregir. */
  rescateAcciones: number;
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
      // ⛔ HOY el ritmo grande es el de CONFIRMAR, no el de todo junto
      // (28-ago-2026). Antes se calculaba sobre `live.total` —confirmar + seg +
      // novedades— con la vara telefónica 25/15, y por eso ROBERTO MORAN salía
      // **"3,7 por hora · lento"** con 51 gestiones de agencia hechas: se le
      // medía tocar un botón como si estuviera marcando y esperando el tono.
      // Seguimiento ahora se mide aparte, abajo, con su vara 40/25.
      //
      // Se cae a `live.total` solo si el llamador no manda los carriles: para
      // quien únicamente trabaja Confirmar los dos números son el mismo, así que
      // no cambia nada para ellos.
      const confHoy = live.confirmar ?? live.total;
      const desdeConf = live.confirmar != null ? (live.firstConfirmarMs ?? null) : live.firstSignalMs;
      const rv = ritmoVivo({ gestionados: confHoy, desdeMs: desdeConf, nowMs, faltan: 0 });
      ritmoPorHora = rv.porHora;
      ritmoCount = confHoy;
      ritmoElapsedMin = desdeConf != null
        ? Math.max(0, Math.round((nowMs - desdeConf) / 60000))
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

    // ── Ritmo de SEGUIMIENTO, con su propia vara (28-ago-2026) ────────────────
    // Pedido del dueño: *"a todos necesito ver el rendimiento en Seguimiento
    // cuando marquen"* y *"como es presionar un botón tienen que trabajar más
    // rápido"*. Por eso es un ritmo aparte y con umbrales más altos (40/25):
    // avisar por WhatsApp no cuesta lo que cuesta una llamada.
    let ritmoSegPorHora: number | null = null;
    let ritmoSegTono: Tono = 'muted';
    let ritmoSegTag: string | null = null;
    let ritmoSegElapsedMin: number | null = null;
    let segHoy: number | null = null;
    if (isToday && live && live.seguimiento != null) {
      segHoy = (live.seguimiento ?? 0) + (live.novedades ?? 0);
      const desdeSeg = live.firstSegMs ?? null;
      // ⛔ Con la lectura truncada NO se calcula. El conteo viene entero de la
      // RPC pero la primera marca sale del barrido de 400 filas: si se cortó,
      // el reloj arranca más tarde de lo real y el ritmo sale INFLADO. Decirle
      // "al ritmo" a quien va lento es tan falso como el "3,7 · lento" que
      // originó todo esto — al revés, pero igual de inventado.
      const medible = input.workEventsOk !== false;
      const rs = medible
        ? ritmoSeguimiento({ gestionados: segHoy, desdeMs: desdeSeg, nowMs, faltan: 0 })
        : null;
      ritmoSegElapsedMin = medible && desdeSeg != null
        ? Math.max(0, Math.round((nowMs - desdeSeg) / 60000))
        : null;
      if (!rs || rs.porHora == null) {
        ritmoSegTono = 'muted';
        ritmoSegTag = !medible ? 'no se pudo medir' : segHoy > 0 ? 'midiendo' : null;
      } else {
        ritmoSegPorHora = rs.porHora;
        if (rs.vaLento) { ritmoSegTono = 'bad'; ritmoSegTag = 'lento'; }
        else if (rs.bajoOptimo) { ritmoSegTono = 'warn'; ritmoSegTag = `sube (óptimo ${RITMO_SEG_META})`; }
        else { ritmoSegTono = 'good'; ritmoSegTag = 'al ritmo'; }
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
    // ⛔ Sin lectura completa NO se acusa a nadie (27-ago-2026).
    //
    // `presente pero sin marcar` es la frase que hizo que el dueño le reclamara
    // por WhatsApp a un asesor que estaba trabajando. Puede ser un hecho o
    // puede ser un hueco de lectura —la consulta de `useLiveTeam` trae 400
    // filas y en un día movido las viejas quedan afuera—, y esos dos casos se
    // veían EXACTAMENTE IGUAL. Cero nunca sustituye a "no se pudo medir": con
    // el dato incompleto se calla en vez de afirmar.
    const marcasMedidas = input.workEventsOk !== false;
    // Señales EN VIVO que la tabla vieja no juntaba en un solo lugar:
    if (isToday) {
      if (tardeMin != null && tardeMin > 0) motivos.push(`entró ${tardeMin >= 60 ? `${Math.floor(tardeMin / 60)} h ${tardeMin % 60} min` : `${tardeMin} min`} tarde`);
      if (marcasMedidas && sinGestionMin != null && sinGestionMin >= UMBRAL_SIN_GESTION_MIN) motivos.push(`sin marcar hace ${sinGestionMin} min`);
      if (marcasMedidas && live && live.estado === 'presente_sin_marcar') motivos.push('presente pero sin marcar');
    }
    // ── Inactivo (dejó de trabajar) vs apertura (se activó, aún sin marcar) ────
    // Sin NINGUNA gestión en el rango (confirmar + seg + nov + rescate).
    const sinActividadRango =
      atendidos === 0 && contestaron === 0 &&
      r.seg_acciones === 0 && r.novedades_resueltas === 0 && r.rescate_acciones === 0;
    const presenteHoy = Boolean(isToday && live && live.estado !== 'ausente');
    // soloApertura: se activó hoy pero no marcó nada → el "presente sin marcar".
    const soloApertura = sinActividadRango && presenteHoy;
    // inactivo: sin actividad en el rango Y sin apertura hoy → días desde su
    // última gestión (del roster). Solo se calcula con dato; nunca inventa.
    const rosterInfo = input.rosterByOp?.get(id) ?? null;
    let inactivoDias: number | null = null;
    let ultimaVezIso: string | null = null;
    if (sinActividadRango && !presenteHoy && rosterInfo) {
      ultimaVezIso = rosterInfo.lastActivityIso;
      inactivoDias = rosterInfo.lastActivityIso
        ? Math.max(0, Math.floor((nowMs - Date.parse(rosterInfo.lastActivityIso)) / 86400000))
        : null;
    }

    const inflowSuelto = isToday && entrantes > 0;
    // ⛔ Trabajo que NO es Confirmar (27-ago-2026). La cara de esta tarjeta era
    // confirmar-only: `total_atendidos` filtra `module='confirmar'`, así que un
    // asesor que pasó la mañana avisando clientes en agencia se leía
    // **"0 · trabajó 0"** — y así es como el dueño terminó reclamándole a
    // alguien que sí había trabajado. El dato ya venía en la RPC desde abril
    // (`seg_acciones`), pero salía en una línea de 11px condicional a `> 0`.
    const otroTrabajo = r.seg_acciones + r.novedades_resueltas + r.rescate_acciones;
    // Nadie tocó Confirmar pero SÍ hubo trabajo: la cabecera tiene que contarlo
    // en vez de mostrar un cero que se lee como pereza.
    const soloOtroTrabajo = atendidos === 0 && r.confirmados === 0 && otroTrabajo > 0;
    // Qué cajas mostrarle. `rescate_acciones` cuenta como Seguimiento: si no,
    // quien solo hizo rescate caería en las cajas de Confirmar y volvería a ver
    // ceros — exactamente el bug que esto corrige.
    const huboConfirmar = atendidos > 0 || contestaron > 0 || r.noresp > 0;
    const huboSeguimiento = otroTrabajo > 0;
    const carril: Carril = huboConfirmar && huboSeguimiento ? 'ambos'
      : huboSeguimiento ? 'seguimiento'
      : huboConfirmar ? 'confirmar'
      : 'ninguno';
    // `sinDato` = no hay NADA que mostrar. Con gestiones de Seguimiento sí hay:
    // sin este término la tarjeta caía en 'idle' ("sin datos") sobre alguien con
    // 40 gestiones hechas.
    const sinDato = atendidos === 0 && r.confirmados === 0 && otroTrabajo === 0 && (!live || live.estado === 'ausente');
    // ⛔ Cada carril se juzga con SU vara, y basta con que uno esté en rojo
    // (28-ago-2026). Antes había un solo `ritmoTono`, calculado sobre todo el
    // trabajo junto con la vara telefónica: quien solo hacía Seguimiento entraba
    // en rojo por una vara que no era la suya. Ahora el que no tocó Confirmar
    // tiene `ritmoTono = 'muted'` y se lo mide por `ritmoSegTono`.
    const ritmoMalo = ritmoTono === 'bad' || ritmoSegTono === 'bad';
    const ritmoTibio = ritmoTono === 'warn' || ritmoSegTono === 'warn';
    if (sinDato) {
      atencion = 'idle';
    } else if (semaforo === 'rojo' || ritmoMalo || (marcasMedidas && sinGestionMin != null && sinGestionMin >= UMBRAL_SIN_GESTION_MIN) || (tardeMin != null && tardeMin >= 30)) {
      atencion = 'bad';
    } else if (semaforo === 'ambar' || ritmoTibio || motivos.length > 0) {
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
      const h = live.ultimaAccion
        ? `${live.ultimaAccion} ${haceTexto(live.lastWorkMin)}`
        // "sin marcar aún" es una afirmación; con la lectura truncada no la
        // podemos hacer. Se dice lo único cierto: que no se pudo medir.
        : !marcasMedidas ? 'no se pudo medir'
        : live.estado === 'ausente' ? 'sin señal hoy'
        : 'sin marcar aún';
      estadoTexto = `${ESTADO_TXT[live.estado]} · ${h}`;
    }

    return {
      operatorId: id,
      name: r.display_name,
      initials: iniciales(r.display_name),
      estado: live?.estado ?? null,
      estadoTexto,
      enLinea: Boolean(live?.enLinea),
      inactivoDias,
      ultimaVezIso,
      soloApertura,
      confirmados: r.confirmados,
      tasaDia,
      // El aro sigue al carril. Ojo: el % de Seguimiento tiene techo por cómo se
      // cuenta "resuelto" en la RPC (cuatro marcas literales, y el aviso de
      // agencia no está entre ellas) — la tarjeta lo aclara en el globo.
      anilloPct: carril === 'seguimiento' ? segTasa : tasaDia,
      anilloEtiqueta: carril === 'seguimiento' ? 'resueltos' : 'del día',
      atendidos,
      ritmoPorHora,
      ritmoTono,
      ritmoTag,
      ritmoCount,
      ritmoElapsedMin,
      ritmoSegPorHora,
      ritmoSegTono,
      ritmoSegTag,
      ritmoSegElapsedMin,
      segHoy,
      entroHora: isToday ? turnoStart : null,
      tardeMin,
      trabajo: atendidos,
      otroTrabajo,
      soloOtroTrabajo,
      carril,
      segPedidos: r.seg_pedidos ?? null,
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
        rescateAcciones: r.rescate_acciones,
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
