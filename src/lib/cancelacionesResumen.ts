/**
 * Resumen del reporte de CANCELACIONES. Puro, sin red, sin hooks.
 *
 * Recibe las filas crudas de la RPC `cancelaciones_analisis` (una por pedido
 * cancelado) y devuelve todo lo que la pantalla necesita. La RPC no agrega nada
 * a propósito: acá se puede testear y se puede cambiar de opinión sobre el
 * histórico sin una migración.
 *
 * TRES REGLAS QUE ATRAVIESAN TODO EL ARCHIVO
 *
 * 1. CERO NUNCA SUSTITUYE A NULL. Toda tasa devuelve `number | null`. `null` =
 *    no hay denominador / no se midió (la pantalla muestra "—"); `0` = se midió
 *    y dio cero. Es la convención que ya usan novedadRootCause y logisticsRates,
 *    y acá es crítica porque medio reporte corre sobre datos que pueden faltar.
 *
 * 2. CADA PORCENTAJE DECLARA SU DENOMINADOR EN EL NOMBRE DEL CAMPO
 *    (`pctSobreConMotivo`, `pctSobreTotal`, `ttfcMedidos`). No hay un `pct`
 *    suelto en toda la interfaz. El top de motivos se calcula sobre los que SÍ
 *    tienen motivo: si 5 de 100 tienen motivo y 3 dicen "precio", el reporte
 *    dice 60% — la verdad sobre lo que sabemos — y no 3%, que es una mentira
 *    construida con datos ausentes.
 *
 * 3. LOS CUATRO TIPOS DE PÉRDIDA PARTICIONAN EL CONJUNTO. evitable + inevitable
 *    + ahorro + sinClasificar === total, en unidades Y en pesos. Está testeado.
 *    Sin ese invariante la pantalla puede perder plata en el camino sin que
 *    nadie lo note.
 */

import {
  classifyCancelRow,
  type CancelCulpa,
  CANCEL_CULPA_ORDER,
} from './cancelTaxonomy';

/** Fila cruda de la RPC `cancelaciones_analisis`, en camelCase. */
export interface CancelacionRow {
  orderId: string;
  externalId: string | null;
  /** Fecha de creación del pedido (cohorte), 'YYYY-MM-DD'. */
  fecha: string | null;
  estado: string | null;
  valor: number | null;
  producto: string | null;
  ciudad: string | null;
  operatorId: string | null;
  operatorName: string | null;
  /** 'guardian' = la canceló una asesora acá. 'externo' = fuera del CRM. */
  origen: 'guardian' | 'externo';
  /** `order_results.reason`. null cuando no hay fila o vino vacío. */
  motivo: string | null;
  canceladoAt: string | null;
  primerToqueAt: string | null;
  /**
   * Filas de `order_results` (conf/canc/noresp) ANTES de la cancelación.
   *
   * ⚠️ `0` NO significa "nadie lo llamó": el flujo normal de una asesora que
   * llama, escucha "no lo quiero" y cancela deja UNA sola fila (la canc), o sea
   * `intentosPrevios = 0` habiendo llamado. Significa "se cerró al primer
   * registro". Para "sin gestión" hay que mirar TAMBIÉN `contactosPrevios`
   * (los touchpoints que escriben los botones Llamar/WhatsApp) — eso hace
   * `tuvoGestion()`, y ni así es prueba: marcar desde el celular propio sin
   * tocar el botón no deja rastro.
   */
  intentosPrevios: number;
  intentosNoresp: number;
  /** APROXIMADO: touchpoints se cruza por teléfono, no por pedido. */
  contactosPrevios: number;
  /** Veces que se reagendó y aun así terminó cancelado. */
  reagendas: number;
  /**
   * El pedido volvió a entrar con otro `external_id` en menos de 48 h (RPC
   * `cancelaciones_recreadas`). NO es una venta perdida: se rehizo.
   * `undefined` = la migración todavía no corrió.
   */
  recreado?: boolean;
  /** `orders.chat_riesgo` — qué hizo el cliente con el botón del WhatsApp.
   *  Solo se usa `'mudo'`, y solo cuando no hay motivo escrito. */
  riesgoChat?: string | null;
}

export type NivelConfianza = 'alta' | 'media' | 'baja' | 'nula';
export type TipoPerdida = 'evitable' | 'inevitable' | 'ahorro' | 'sin_clasificar' | 'recreado';
export type MotivoClasificacion = 'sin_gestion' | 'taxonomia' | 'sin_dato';
export type IntentoBucket = '0' | '1' | '2' | '3+';

/** Umbrales de confianza. Exportados para que test y UI usen el mismo número. */
export const UMBRAL_COBERTURA_ALTA = 0.7;
export const UMBRAL_COBERTURA_MEDIA = 0.4;

/** Mínimo de cancelaciones para juzgar a una operadora. Debajo, no se pinta rojo. */
export const MIN_MUESTRA_OPERADORA = 5;

/**
 * Intentos de llamada a partir de los cuales un "no contestó" deja de ser una
 * pérdida evitable. Es el mismo 3 que usa el sistema de reintentos
 * (`MAX_DAILY_ATTEMPTS`): agotar los intentos del día ES haber hecho el trabajo.
 */
export const INTENTOS_SUFICIENTES = 3;

/** Hasta cuántos días desde el pedido una cancelación cuenta como "fresca". */
export const ES_FRESCO_DIAS = 1;

/** Etiqueta del bucket "sin operadora". */
export const SIN_OPERADORA = 'Sin operadora / canceló en Dropi';

const val = (n: number | null | undefined): number =>
  typeof n === 'number' && Number.isFinite(n) ? n : 0;

function pct(num: number, den: number): number | null {
  if (!den) return null;
  return num / den;
}

export function nivelConfianza(p: number | null): NivelConfianza {
  if (p === null) return 'nula';
  if (p >= UMBRAL_COBERTURA_ALTA) return 'alta';
  if (p >= UMBRAL_COBERTURA_MEDIA) return 'media';
  if (p > 0) return 'baja';
  return 'nula';
}

export function mediana(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentil(nums: number[], p: number): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

/** ¿Alguien tocó este pedido antes de cancelarlo? */
export function tuvoGestion(r: CancelacionRow): boolean {
  return val(r.intentosPrevios) > 0 || val(r.contactosPrevios) > 0;
}

/**
 * Clasifica el impacto económico de UNA cancelación.
 *
 * El orden importa y el paso 2 es la regla discutible, sostenida a propósito:
 * un pedido que entró al CRM, que NADIE llamó nunca, y que terminó cancelado, es
 * fallo de proceso **aunque el texto del motivo diga que el cliente no lo
 * quería** — nadie verificó eso. Es la mecánica que reproduce el hallazgo de
 * julio EC (68 de 345 sin ninguna gestión). Queda contado aparte en
 * `evitablesPorSinGestion` para que el dueño pueda ver cuánto pesa esa regla y
 * decidir si la acepta.
 *
 * El paso 1 va antes que el 2 a propósito: una cancelación SANA (duplicado, mal
 * historial) es sana aunque nadie haya llamado — no había a quién llamar.
 */
export function clasificarPerdida(r: CancelacionRow): {
  tipo: TipoPerdida;
  motivo: MotivoClasificacion;
} {
  const clase = classifyCancelRow({ motivo: r.motivo, origen: r.origen, recreado: r.recreado, riesgoChat: r.riesgoChat });
  // Va PRIMERO: un pedido recreado no es ni pérdida ni ahorro, así que no puede
  // caer en ninguno de los buckets de abajo. `cuentaEnTasa === false` es la
  // misma marca que ya lo saca del denominador de la tasa.
  if (clase.cuentaEnTasa === false) return { tipo: 'recreado', motivo: 'taxonomia' };
  if (clase.tipo === 'ahorro') return { tipo: 'ahorro', motivo: 'taxonomia' };
  if (!tuvoGestion(r)) return { tipo: 'evitable', motivo: 'sin_gestion' };
  if (clase.tipo === 'desconocido') return { tipo: 'sin_clasificar', motivo: 'sin_dato' };
  // "No contestó" NO es evitable por definición: depende de cuántas veces se
  // intentó. De los que nunca se confirmaron por teléfono, 63 fueron llamados
  // hasta SEIS veces sin que nadie atendiera. Llamar más no los salvaba, y
  // cobrárselo al equipo como "pérdida evitable" es un reclamo injusto. Es el
  // mismo criterio que ya se aplicó a `sin_whatsapp`, que hasta ahora no se
  // había aplicado acá aunque es el mismo hecho contado por la asesora en vez
  // de por el bot — y `no_contesta` es el motivo #1 del picklist.
  if (clase.categoria === 'no_contesta' && val(r.intentosPrevios) >= INTENTOS_SUFICIENTES) {
    return { tipo: 'inevitable', motivo: 'taxonomia' };
  }
  if (clase.tipo === 'perdida_evitable') return { tipo: 'evitable', motivo: 'taxonomia' };
  return { tipo: 'inevitable', motivo: 'taxonomia' };
}

export function bucketIntentos(r: CancelacionRow): IntentoBucket {
  const n = val(r.intentosPrevios);
  if (n <= 0) return '0';
  if (n === 1) return '1';
  if (n === 2) return '2';
  return '3+';
}

/** Días entre la creación del pedido y su cancelación. null si falta alguna fecha. */
export function diasHastaCancelar(r: CancelacionRow): number | null {
  if (!r.fecha || !r.canceladoAt) return null;
  const ini = Date.parse(`${r.fecha}T00:00:00`);
  const fin = Date.parse(r.canceladoAt);
  if (!Number.isFinite(ini) || !Number.isFinite(fin)) return null;
  // Se compara contra el ARRANQUE del día del pedido: cancelar a las 8 pm del
  // mismo día es 0 días, no 1. Es la clase de error de zona horaria que este
  // repo ya pagó en otros contadores.
  return Math.max(0, Math.floor((fin - ini) / 86_400_000));
}

/** Horas entre la creación del pedido y el PRIMER toque. null si nunca lo tocaron. */
export function horasAPrimerToque(r: CancelacionRow): number | null {
  if (!r.fecha || !r.primerToqueAt) return null;
  const ini = Date.parse(`${r.fecha}T00:00:00`);
  const fin = Date.parse(r.primerToqueAt);
  if (!Number.isFinite(ini) || !Number.isFinite(fin)) return null;
  // Negativo (relojes desfasados / backfill) se clampa a 0 en vez de descartarse:
  // el pedido SÍ se tocó, y tirar la fila movería la mediana.
  return Math.max(0, (fin - ini) / 3_600_000);
}

export interface CoberturaMotivo {
  total: number;
  conMotivo: number;
  sinMotivo: number;
  pctConMotivo: number | null;
  nivel: NivelConfianza;
  porOrigen: Array<{
    origen: 'guardian' | 'externo';
    cancelados: number;
    conMotivo: number;
    pctConMotivo: number | null;
  }>;
}

export interface PlataCancelada {
  valorCancelado: number;
  evitable: { cancelados: number; valor: number; pctSobreTotal: number | null };
  inevitable: { cancelados: number; valor: number; pctSobreTotal: number | null };
  ahorro: { cancelados: number; valor: number; pctSobreTotal: number | null };
  sinClasificar: { cancelados: number; valor: number; pctSobreTotal: number | null };
  /**
   * NI pérdida NI ahorro: el pedido se recreó con otro `external_id` (cambio de
   * transportadora, edición, o el reemplazo que detecta `cancelaciones_recreadas`).
   *
   * Tenía `tipo:'ahorro'` y por lo tanto entraba a la tarjeta "Ahorro (estuvo
   * bien cancelar)", cuyo texto al pie nombra "duplicados / mal historial" —
   * una población que no era la que contaba. No ahorró nada: no evitó ninguna
   * devolución. Simplemente no es una cancelación.
   */
  recreado: { cancelados: number; valor: number; pctSobreTotal: number | null };
  /** evitable + inevitable. Es la plata que sí se fue. */
  perdidoBruto: number;
  /** Cuántas evitables lo son SOLO porque nadie llamó. */
  evitablesPorSinGestion: number;
  valorEvitablePorSinGestion: number;
}

export interface MotivoBucket {
  categoria: string;
  culpa: CancelCulpa;
  cancelados: number;
  valor: number;
  /** Denominador = cobertura.conMotivo. */
  pctSobreConMotivo: number | null;
  evitables: number;
  /** Hasta 3 textos CRUDOS distintos, tal cual los escribió la asesora. */
  ejemplos: string[];
}

export interface MotivoCrudo { texto: string; veces: number; valor: number }

export interface CulpaBucket {
  culpa: CancelCulpa;
  cancelados: number;
  valor: number;
  /** Denominador = totalCancelados. */
  pctSobreTotal: number | null;
}

export interface GestionCancelacion {
  distribucionIntentos: Array<{
    bucket: IntentoBucket; cancelados: number; valor: number; pctSobreTotal: number | null;
  }>;
  sinGestion: number;
  sinGestionValor: number;
  pctSinGestion: number | null;
  ttfcMedianaHoras: number | null;
  ttfcP90Horas: number | null;
  /** Denominador de la mediana. Se imprime al lado: una mediana sin su n decora. */
  ttfcMedidos: number;
  ttfcNunca: number;
  reagendasQuemadas: number;
}

export interface OperadoraCancelacion {
  operatorId: string | null;
  name: string;
  cancelados: number;
  valor: number;
  conMotivo: number;
  /** LA métrica de disciplina de registro. Denominador = sus cancelados. */
  pctConMotivo: number | null;
  sinGestion: number;
  pctSinGestion: number | null;
  evitables: number;
  valorEvitable: number;
  /** cancelados >= MIN_MUESTRA_OPERADORA. Debajo, la UI no pinta rojo. */
  muestraSuficiente: boolean;
}

export interface DimensionBucket {
  key: string;
  cancelados: number;
  valor: number;
  evitables: number;
  valorEvitable: number;
  /** Participación sobre el total de cancelados. NO es una tasa. */
  pctSobreCancelados: number | null;
  topMotivo: string | null;
  topMotivoCancelados: number;
}

export interface AntiguedadCancelacion {
  frescos: number;
  arrastre: number;
  sinFecha: number;
  medianaDias: number | null;
  valorFrescos: number;
  valorArrastre: number;
}

export interface CancelacionesResumen {
  totalCancelados: number;
  valorCancelado: number;
  /** Filas realmente traídas vs el total real del período. */
  mostrados: number;
  totalPeriodo: number;
  truncado: boolean;
  /** Pedidos creados en el período (cancelados incluidos, borrados fuera). */
  generados: number | null;
  tasaCancelacion: number | null;
  /**
   * La tasa SIN los pedidos que se recrearon en vez de perderse.
   *
   * ⛔ `cuentaEnTasa` existía en la taxonomía desde el 15-ago y **no lo leía
   * nadie** (`cancelTaxonomy.ts:81` vs. el cálculo de acá): un cambio de
   * transportadora y una edición de pedido salen como CANCELADO en Dropi y
   * entran con otro `external_id`, así que la tasa contaba la misma venta dos
   * veces — una como cancelada y otra como nueva. Medido en agosto-EC: **19
   * pedidos, ~1,6 puntos de tasa** que no son pérdidas de nadie.
   *
   * `null` cuando la consulta vino truncada: `recreados` se cuenta sobre las
   * filas cargadas y `totalPeriodo` describe el período entero — restar una
   * cuenta parcial de un total completo daría un número peor que no darlo.
   */
  tasaCancelacionReal: number | null;
  /** Cancelados que en realidad se recrearon con otro id. No son pérdida. */
  recreados: number;
  valorRecreados: number;
  /** generados < cancelados → dato incoherente, la tasa NO se imprime. */
  universoInconsistente: boolean;
  cobertura: CoberturaMotivo;
  plata: PlataCancelada;
  topMotivos: MotivoBucket[];
  motivosCrudos: MotivoCrudo[];
  porCulpa: CulpaBucket[];
  gestion: GestionCancelacion;
  porOperadora: OperadoraCancelacion[];
  porProducto: DimensionBucket[];
  porCiudad: DimensionBucket[];
  antiguedad: AntiguedadCancelacion;
}

export const EMPTY_RESUMEN: CancelacionesResumen = {
  totalCancelados: 0, valorCancelado: 0, mostrados: 0, totalPeriodo: 0, truncado: false,
  generados: null, tasaCancelacion: null, tasaCancelacionReal: null,
  recreados: 0, valorRecreados: 0, universoInconsistente: false,
  cobertura: { total: 0, conMotivo: 0, sinMotivo: 0, pctConMotivo: null, nivel: 'nula', porOrigen: [] },
  plata: {
    valorCancelado: 0,
    evitable: { cancelados: 0, valor: 0, pctSobreTotal: null },
    inevitable: { cancelados: 0, valor: 0, pctSobreTotal: null },
    ahorro: { cancelados: 0, valor: 0, pctSobreTotal: null },
    sinClasificar: { cancelados: 0, valor: 0, pctSobreTotal: null },
    recreado: { cancelados: 0, valor: 0, pctSobreTotal: null },
    perdidoBruto: 0, evitablesPorSinGestion: 0, valorEvitablePorSinGestion: 0,
  },
  topMotivos: [], motivosCrudos: [], porCulpa: [],
  gestion: {
    distribucionIntentos: [], sinGestion: 0, sinGestionValor: 0, pctSinGestion: null,
    ttfcMedianaHoras: null, ttfcP90Horas: null, ttfcMedidos: 0, ttfcNunca: 0,
    reagendasQuemadas: 0,
  },
  porOperadora: [], porProducto: [], porCiudad: [],
  antiguedad: { frescos: 0, arrastre: 0, sinFecha: 0, medianaDias: null, valorFrescos: 0, valorArrastre: 0 },
};

interface Opts {
  /** Pedidos creados en el período (viene de la propia RPC). */
  generados?: number | null;
  /** Total real de cancelados antes del LIMIT (viene de la propia RPC). */
  totalPeriodo?: number | null;
}

/** Clave de agrupación insensible a mayúsculas, tildes y espacios dobles.
 *  "GOTAS RELAX", "Gotas  Relax" y "gotas relax" son EL MISMO producto; si cada
 *  grafía fuera su propia fila, el ranking "cuál se cancela más" coronaría al
 *  equivocado (12+9 partidos en dos filas pierden contra uno de 15). La ciudad
 *  la tipea el cliente ("BOGOTA" vs "Bogotá"), así que ahí la varianza es peor. */
function claveDimension(raw: string): string {
  return raw
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

/** Agrupa por una dimensión (producto / ciudad) sin descartar los sin dato. */
function agruparDimension(
  rows: CancelacionRow[],
  keyOf: (r: CancelacionRow) => string | null,
  totalCancelados: number,
): DimensionBucket[] {
  const map = new Map<string, {
    label: string;
    cancelados: number; valor: number; evitables: number; valorEvitable: number;
    motivos: Map<string, number>;
  }>();
  for (const r of rows) {
    const label = (keyOf(r) || '').trim() || '(sin dato)';
    const k = label === '(sin dato)' ? label : claveDimension(label);
    let b = map.get(k);
    // La etiqueta visible es la PRIMERA grafía vista (no la normalizada en
    // mayúsculas planas) — mismo truco que los `ejemplos` de topMotivos.
    if (!b) { b = { label, cancelados: 0, valor: 0, evitables: 0, valorEvitable: 0, motivos: new Map() }; map.set(k, b); }
    b.cancelados += 1;
    b.valor += val(r.valor);
    const { tipo } = clasificarPerdida(r);
    if (tipo === 'evitable') { b.evitables += 1; b.valorEvitable += val(r.valor); }
    const clase = classifyCancelRow({ motivo: r.motivo, origen: r.origen, recreado: r.recreado, riesgoChat: r.riesgoChat });
    // `cuentaEnTasa === false` (pedido rehecho) se salta acá igual que en el
    // desglose global de motivos. Medido en pantalla el 22-ago-2026: Quito
    // aparecía como «32 cancelaciones · Pedido rehecho» cuando en TODO el
    // período hubo 19 rehechos — el motivo dominante salía de un puñado de
    // filas clasificadas y se leía como si describiera las 32. Y encima
    // nombraba una categoría que el resto de la pantalla excluye a propósito.
    if (!clase.esGenerica && clase.cuentaEnTasa !== false) {
      b.motivos.set(clase.categoria, (b.motivos.get(clase.categoria) || 0) + 1);
    }
  }
  return [...map.entries()].map(([key, b]) => {
    let topMotivo: string | null = null;
    let topMotivoCancelados = 0;
    for (const [cat, n] of b.motivos) {
      // Empate → gana el alfabéticamente menor, para que el orden sea estable
      // entre refetches (si no, la lista "se mueve sola" y parece rota).
      if (n > topMotivoCancelados || (n === topMotivoCancelados && topMotivo !== null && cat < topMotivo)) {
        topMotivo = cat; topMotivoCancelados = n;
      }
    }
    return {
      key: b.label, cancelados: b.cancelados, valor: b.valor,
      evitables: b.evitables, valorEvitable: b.valorEvitable,
      pctSobreCancelados: pct(b.cancelados, totalCancelados),
      topMotivo, topMotivoCancelados,
    };
  }).sort((a, b) =>
    b.cancelados - a.cancelados || b.valor - a.valor || a.key.localeCompare(b.key));
}

export function summarizeCancelaciones(
  rows: CancelacionRow[] | null | undefined,
  opts: Opts = {},
): CancelacionesResumen {
  const list = rows || [];
  const total = list.length;
  if (!total) {
    return {
      ...EMPTY_RESUMEN,
      generados: typeof opts.generados === 'number' ? opts.generados : null,
      totalPeriodo: val(opts.totalPeriodo),
    };
  }

  const valorCancelado = list.reduce((s, r) => s + val(r.valor), 0);

  // ── (a) Cobertura ─────────────────────────────────────────────────────────
  const clases = list.map(r => classifyCancelRow({ motivo: r.motivo, origen: r.origen, recreado: r.recreado, riesgoChat: r.riesgoChat }));
  const conMotivoFlags = clases.map(c => c.categoria !== 'sin_motivo' && c.categoria !== 'externo_dropi');
  const conMotivo = conMotivoFlags.filter(Boolean).length;
  const pctCob = pct(conMotivo, total);
  const porOrigen = (['guardian', 'externo'] as const).map(origen => {
    const idx = list.map((r, i) => (r.origen === origen ? i : -1)).filter(i => i >= 0);
    const cm = idx.filter(i => conMotivoFlags[i]).length;
    return { origen, cancelados: idx.length, conMotivo: cm, pctConMotivo: pct(cm, idx.length) };
  });
  const cobertura: CoberturaMotivo = {
    total, conMotivo, sinMotivo: total - conMotivo,
    pctConMotivo: pctCob, nivel: nivelConfianza(pctCob), porOrigen,
  };

  // ── (b) Plata ─────────────────────────────────────────────────────────────
  const acc: Record<TipoPerdida, { cancelados: number; valor: number }> = {
    evitable: { cancelados: 0, valor: 0 },
    inevitable: { cancelados: 0, valor: 0 },
    ahorro: { cancelados: 0, valor: 0 },
    sin_clasificar: { cancelados: 0, valor: 0 },
    recreado: { cancelados: 0, valor: 0 },
  };
  let evitablesPorSinGestion = 0;
  let valorEvitablePorSinGestion = 0;
  const tipos: TipoPerdida[] = [];
  for (const r of list) {
    const { tipo, motivo } = clasificarPerdida(r);
    tipos.push(tipo);
    acc[tipo].cancelados += 1;
    acc[tipo].valor += val(r.valor);
    if (tipo === 'evitable' && motivo === 'sin_gestion') {
      evitablesPorSinGestion += 1;
      valorEvitablePorSinGestion += val(r.valor);
    }
  }
  const conPct = (b: { cancelados: number; valor: number }) => ({
    ...b, pctSobreTotal: pct(b.cancelados, total),
  });
  const plata: PlataCancelada = {
    valorCancelado,
    evitable: conPct(acc.evitable),
    inevitable: conPct(acc.inevitable),
    ahorro: conPct(acc.ahorro),
    sinClasificar: conPct(acc.sin_clasificar),
    recreado: conPct(acc.recreado),
    perdidoBruto: acc.evitable.valor + acc.inevitable.valor,
    evitablesPorSinGestion, valorEvitablePorSinGestion,
  };

  // ── (c) Top motivos + los crudos sin clasificar ───────────────────────────
  const motMap = new Map<string, {
    culpa: CancelCulpa; cancelados: number; valor: number; evitables: number;
    ejemplos: Map<string, string>;
  }>();
  const crudos = new Map<string, { texto: string; veces: number; valor: number }>();
  list.forEach((r, i) => {
    const clase = clases[i];
    if (!conMotivoFlags[i]) return;      // sin motivo no entra al top de motivos
    // Un pedido recreado no es un MOTIVO de cancelación: la venta siguió con
    // otro número. Listarlo entre los motivos lo pone a competir con las
    // pérdidas de verdad.
    if (clase.cuentaEnTasa === false) return;
    let b = motMap.get(clase.categoria);
    if (!b) { b = { culpa: clase.culpa, cancelados: 0, valor: 0, evitables: 0, ejemplos: new Map() }; motMap.set(clase.categoria, b); }
    b.cancelados += 1;
    b.valor += val(r.valor);
    if (tipos[i] === 'evitable') b.evitables += 1;
    const texto = (r.motivo || '').trim();
    // Se conserva la PRIMERA grafía vista, no la última: con `set` a secas, dos
    // filas que dicen lo mismo con distinta capitalización se pisaban y el
    // ejemplo mostrado cambiaba según el orden en que llegaran las filas.
    const ek = texto.toLowerCase();
    if (texto && b.ejemplos.size < 3 && !b.ejemplos.has(ek)) b.ejemplos.set(ek, texto);
    // Detector permanente de vocabulario que la taxonomía todavía no entiende.
    // Mismo espíritu que `estadosSinMapear` en estadoBuckets: nunca esconder lo
    // no clasificado — es la lista de tareas de la próxima iteración.
    if (clase.categoria === 'otro' && texto) {
      const k = texto.toLowerCase();
      const c = crudos.get(k);
      if (c) { c.veces += 1; c.valor += val(r.valor); }
      else crudos.set(k, { texto, veces: 1, valor: val(r.valor) });
    }
  });
  const topMotivos: MotivoBucket[] = [...motMap.entries()].map(([categoria, b]) => ({
    categoria, culpa: b.culpa, cancelados: b.cancelados, valor: b.valor,
    pctSobreConMotivo: pct(b.cancelados, conMotivo),
    evitables: b.evitables, ejemplos: [...b.ejemplos.values()],
  })).sort((a, b) =>
    b.cancelados - a.cancelados || b.valor - a.valor || a.categoria.localeCompare(b.categoria));
  const motivosCrudos: MotivoCrudo[] = [...crudos.values()]
    .sort((a, b) => b.veces - a.veces || a.texto.localeCompare(b.texto))
    .slice(0, 25);

  // ── (d) Por culpa — la fila "sin motivo" es OBLIGATORIA y a su tamaño real ─
  const culpaMap = new Map<CancelCulpa, { cancelados: number; valor: number }>();
  clases.forEach((c, i) => {
    // Los recreados quedan afuera. Llevan `culpa:'operacion'` (es la operación
    // la que rehace el pedido) y sin este filtro engordaban la barra
    // "Nosotros" de la portada con pedidos que no son falla de nadie — la misma
    // clase de doble conteo que ya se había corregido para la tasa.
    if (c.cuentaEnTasa === false) return;
    const b = culpaMap.get(c.culpa) || { cancelados: 0, valor: 0 };
    b.cancelados += 1;
    b.valor += val(list[i].valor);
    culpaMap.set(c.culpa, b);
  });
  const porCulpa: CulpaBucket[] = CANCEL_CULPA_ORDER
    .filter(c => culpaMap.has(c))
    .map(culpa => {
      const b = culpaMap.get(culpa)!;
      return { culpa, cancelados: b.cancelados, valor: b.valor, pctSobreTotal: pct(b.cancelados, total) };
    });

  // ── (e) Gestión: intentos y tiempo hasta el primer toque ──────────────────
  const buckets: IntentoBucket[] = ['0', '1', '2', '3+'];
  const distribucionIntentos = buckets.map(bucket => {
    const sel = list.filter(r => bucketIntentos(r) === bucket);
    return {
      bucket, cancelados: sel.length,
      valor: sel.reduce((s, r) => s + val(r.valor), 0),
      pctSobreTotal: pct(sel.length, total),
    };
  });
  const sinGestionRows = list.filter(r => !tuvoGestion(r));
  const ttfc = list.map(horasAPrimerToque).filter((h): h is number => h !== null);
  const gestion: GestionCancelacion = {
    distribucionIntentos,
    sinGestion: sinGestionRows.length,
    sinGestionValor: sinGestionRows.reduce((s, r) => s + val(r.valor), 0),
    pctSinGestion: pct(sinGestionRows.length, total),
    ttfcMedianaHoras: mediana(ttfc),
    ttfcP90Horas: percentil(ttfc, 90),
    ttfcMedidos: ttfc.length,
    ttfcNunca: total - ttfc.length,
    reagendasQuemadas: list.filter(r => val(r.reagendas) > 0).length,
  };

  // ── (f) Por operadora ─────────────────────────────────────────────────────
  const opMap = new Map<string, {
    operatorId: string | null; name: string; cancelados: number; valor: number;
    conMotivo: number; sinGestion: number; evitables: number; valorEvitable: number;
  }>();
  list.forEach((r, i) => {
    const id = r.operatorId || '';
    let b = opMap.get(id);
    if (!b) {
      b = {
        operatorId: r.operatorId || null,
        name: r.operatorName || SIN_OPERADORA,
        cancelados: 0, valor: 0, conMotivo: 0, sinGestion: 0, evitables: 0, valorEvitable: 0,
      };
      opMap.set(id, b);
    }
    b.cancelados += 1;
    b.valor += val(r.valor);
    if (conMotivoFlags[i]) b.conMotivo += 1;
    if (!tuvoGestion(r)) b.sinGestion += 1;
    if (tipos[i] === 'evitable') { b.evitables += 1; b.valorEvitable += val(r.valor); }
  });
  const porOperadora: OperadoraCancelacion[] = [...opMap.values()].map(b => ({
    ...b,
    pctConMotivo: pct(b.conMotivo, b.cancelados),
    pctSinGestion: pct(b.sinGestion, b.cancelados),
    muestraSuficiente: b.cancelados >= MIN_MUESTRA_OPERADORA,
  })).sort((a, b) =>
    // Se ordena por SIN GESTIÓN, no por volumen: rankear por cancelados
    // absolutos es rankear por cuánto trabaja cada una — la que más pedidos
    // atiende siempre cancela más, y eso no dice nada.
    b.sinGestion - a.sinGestion || b.cancelados - a.cancelados || a.name.localeCompare(b.name));

  // ── (g) Producto y ciudad ─────────────────────────────────────────────────
  const porProducto = agruparDimension(list, r => r.producto, total);
  const porCiudad = agruparDimension(list, r => r.ciudad, total);

  // ── (h) Antigüedad: cancelar hoy ≠ cancelar a los 9 días ──────────────────
  let frescos = 0, arrastre = 0, sinFecha = 0, valorFrescos = 0, valorArrastre = 0;
  const dias: number[] = [];
  for (const r of list) {
    const d = diasHastaCancelar(r);
    if (d === null) { sinFecha += 1; continue; }
    dias.push(d);
    if (d <= ES_FRESCO_DIAS) { frescos += 1; valorFrescos += val(r.valor); }
    else { arrastre += 1; valorArrastre += val(r.valor); }
  }
  const antiguedad: AntiguedadCancelacion = {
    frescos, arrastre, sinFecha, medianaDias: mediana(dias), valorFrescos, valorArrastre,
  };

  // ── Tasa: un solo denominador, y si no cierra NO se imprime ───────────────
  const generados = typeof opts.generados === 'number' ? opts.generados : null;
  const totalPeriodo = val(opts.totalPeriodo) || total;
  const universoInconsistente = generados !== null && generados < totalPeriodo;
  // Se usa `totalPeriodo` y no `total`: si la consulta vino truncada, la tasa
  // tiene que seguir describiendo el período completo, no la muestra.
  const tasaCancelacion = generados === null || universoInconsistente
    ? null
    : pct(totalPeriodo, generados);

  // ── Los que NO se perdieron: se recrearon con otro id ─────────────────────
  // `cuentaEnTasa:false` lo pone la taxonomía en `cambio_transportadora` y
  // `recreado_edicion`. El campo existía desde agosto y no lo leía nadie, así
  // que esas dos salían como pérdida y contaban la misma venta dos veces.
  const recreados = clases.filter(c => c.cuentaEnTasa === false).length;
  const valorRecreados = list.reduce(
    (s, r, i) => (clases[i].cuentaEnTasa === false ? s + val(r.valor) : s), 0);
  const truncado = totalPeriodo > total;
  // Con la consulta truncada NO se publica: `recreados` sale de las filas
  // cargadas y `totalPeriodo` del período entero. Restar una cuenta parcial de
  // un total completo da un número peor que no dar ninguno.
  const tasaCancelacionReal = tasaCancelacion === null || truncado
    ? null
    : pct(Math.max(totalPeriodo - recreados, 0), generados as number);

  return {
    totalCancelados: total,
    valorCancelado,
    mostrados: total,
    totalPeriodo,
    truncado,
    generados,
    tasaCancelacion,
    tasaCancelacionReal,
    recreados,
    valorRecreados,
    universoInconsistente,
    cobertura, plata, topMotivos, motivosCrudos, porCulpa, gestion,
    porOperadora, porProducto, porCiudad, antiguedad,
  };
}
