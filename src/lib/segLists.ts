import type { OrderData } from './orderUtils';
import { calcBusinessDays, parseDate } from './orderUtils';

/**
 * "Listas SLA" estilo Boostec, ORGANIZADAS POR EMBUDO DE PRIORIDAD.
 *
 * Filosofía: el operador necesita atender PRIMERO los pedidos más cerca de
 * entregarse (oficina, reparto, novedad-cliente) porque ahí está el dinero;
 * después los del medio (tránsito) y por último los iniciales (guía generada,
 * pendientes de guía). Esto reemplaza el orden viejo "solo por SLA vencido",
 * que dejaba países con operación reciente (EC) con TODO en "otros estados"
 * porque ningún pedido había cruzado los umbrales de días.
 *
 * Orden de las listas (= prioridad visual + ranking del "sugerido"):
 *  1. Pendientes de confirmación (link a /confirmar) — pre-embudo
 *  2. En oficina        | FINAL — cliente va a recoger
 *  3. En reparto/novedad| FINAL — en mano del repartidor o intento fallido
 *  4. En tránsito       | MEDIO
 *  5. Guía generada     | INICIO post-confirmación
 *  6. Indem. guía generada (+5d) | sub-lista crítica disjoint de la anterior
 *  7. Pendientes de guía         | INICIO — sin guía aún
 *  8. Indem. pendientes de guía (+4d) | sub-lista crítica disjoint
 *  9. Otros estados     | catch-all
 *
 * Reglas de diseño:
 *  - Las listas de FASE matchean por ESTADO solamente (sin umbral de SLA),
 *    para que pedidos recientes también aparezcan en su fase. Antes
 *    `pendientes_guia_2d` y `guia_generada_2d` exigían >= 2d → países con
 *    pedidos < 2d quedaban sin lista de fase visible.
 *  - Las listas con prefijo "indem_" son sub-conjuntos críticos (excedieron
 *    SLA de indemnización). La lista de fase correspondiente se acota con
 *    `< N días` para NO duplicar (un pedido con 5d sin guía cae SOLO en
 *    indem, no en pendientes_guia).
 *  - "pendientes_confirmacion" vive en /confirmar — no se filtra acá, es
 *    sólo un link visual.
 *  - "otros_estados" es el catch-all (excluye terminales: ENTREGADO/CANCELADO/
 *    DEVOLUCION/RECHAZADO/INDEMNIZADA).
 */

export type SegListSlug =
  | 'pendientes_confirmacion_2d'
  | 'en_oficina'
  | 'en_reparto_novedad'
  | 'en_transito'
  | 'guia_generada'
  | 'indem_guia_generada_5d'
  | 'pendientes_guia'
  | 'indem_pendientes_guia_4d'
  | 'otros_estados';

export interface SegListDef {
  slug: SegListSlug;
  label: string;
  /** SLA en días hábiles para mostrar en el badge / hint (0 = no aplica) */
  slaDias: number;
  /** Tono visual de la lista (urgencia) */
  tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  /** Predicado que indica si una orden cae en esta lista */
  matches: (o: OrderData) => boolean;
  /** Link externo si la lista vive en otra ruta (ej. confirmación → /confirmar) */
  externalRoute?: string;
}

const E = (s: string | null | undefined): string => (s || '').toUpperCase().trim();

const ESTADOS_TRANSITO_EXACT = new Set([
  'EN TRANSPORTE',
  'EN DESPACHO',
  'EN TRASLADO NACIONAL',
  'EN TERMINAL ORIGEN',
  'EN TERMINAL DESTINO',
  'EN DISTRIBUCION',
  'EN REEXPEDICION',
  'ENTREGADA A CONEXIONES',
  'TELEMERCADEO',
  'REENVIO',
  'REENVÍO',
  'EN BODEGA TRANSPORTADORA',
  'EN BODEGA DROPI',
  'EN BODEGA ORIGEN',
  'BODEGA DESTINO',
  'RECOGIDO POR DROPI',
  'DESPACHADA',
  'EN ESPERA DE RUTA DOMESTICA',
]);
const matchTransito = (e: string): boolean => {
  if (ESTADOS_TRANSITO_EXACT.has(e)) return true;
  // Variantes EC que Dropi inventa con sufijos: "EN RUTA A CENTRO LOGISTICO",
  // "INGRESANDO OPERATIVO A", "ASIGNADO A <transportadora>".
  if (e.startsWith('EN RUTA')) return true;
  if (e.startsWith('INGRESANDO')) return true;
  if (e.startsWith('ASIGNADO')) return true;
  return false;
};

// FASE FINAL: pedido en mano del repartidor o intento de entrega fallido —
// la atención del operador acá impacta directo en la entrega.
const ESTADOS_REPARTO_NOVEDAD = [
  'EN REPARTO',
  'NOVEDAD',
  'INTENTO DE ENTREGA',
  'NOVEDAD SOLUCIONADA',
];

const ESTADOS_GUIA_GENERADA = ['GUIA_GENERADA', 'GUIA GENERADA', 'ADMITIDA', 'PREPARADO PARA TRANSPORTADORA', 'ENTREGADO A TRANSPORTADORA'];

// FASE FINAL: cliente debe ir a recoger a oficina (alta prioridad).
// Incluye "PARA RETIRO EN AGENCIA SERVIENTREGA" (EC) y "EN PUNTO DROOP" (CO).
const ESTADOS_OFICINA = (e: string): boolean =>
  e.includes('OFICINA') || e.includes('RECLAME') || e.includes('RECLAMAR') ||
  e.includes('EN PUNTO') || e.startsWith('PARA RETIRO') || e.startsWith('RETIRO');

const ESTADOS_TERMINALES = [
  'ENTREGADO',
  'CANCELADO',
  'DEVOLUCION',
  'DEVOLUCION EN TRANSITO',
  'DEVUELTO',
  'RECHAZADO',
  'INDEMNIZADA',
];

/**
 * Días hábiles desde la creación del pedido. Si la fecha es inválida o falta,
 * cae al campo `dias` (calendario) que ya viene en la fila como fallback —
 * esto evita que un pedido con fecha mal parseada quede invisible al filtro.
 */
function diasDesdeCreacion(o: OrderData): number {
  try {
    if (o.fecha) {
      const d = calcBusinessDays(o.fecha);
      if (d > 0) return d;
    }
  } catch {
    // ignore — caemos al fallback
  }
  return Math.max(0, o.dias || 0);
}

/**
 * Días hábiles desde el ÚLTIMO MOVIMIENTO real del pedido en Dropi
 * (`o.lastMovementAt` = updated_at). Para los buckets donde "sin movimiento" es
 * la semántica correcta (guía generada): un pedido VIEJO pero que se movió ayer
 * NO debe contar como atrasado.
 *
 * 0 es un valor VÁLIDO (se movió hoy) — por eso NO usamos el patrón
 * `if (d > 0)` de diasDesdeCreacion. Solo caemos al fallback de creación si
 * `lastMovementAt` falta o no parsea.
 */
function diasSinMovimiento(o: OrderData): number {
  if (o.lastMovementAt && parseDate(o.lastMovementAt)) {
    return calcBusinessDays(o.lastMovementAt);
  }
  return diasDesdeCreacion(o);
}

export const SEG_LISTS: SegListDef[] = [
  // ── Pre-embudo ──────────────────────────────────────────────────────────
  {
    slug: 'pendientes_confirmacion_2d',
    label: 'Pendientes de confirmación (+2 días)',
    slaDias: 2,
    tone: 'warning',
    externalRoute: '/confirmar',
    matches: () => false, // vive en /confirmar — esta lista solo es link
  },

  // ── FASE FINAL (alta prioridad — pedido a punto de entregarse) ──────────
  {
    slug: 'en_oficina',
    label: 'En oficina (cliente recoge)',
    slaDias: 0,
    tone: 'warning',
    matches: (o) => ESTADOS_OFICINA(E(o.estado)),
  },
  {
    slug: 'en_reparto_novedad',
    label: 'En reparto / Novedad cliente',
    slaDias: 0,
    tone: 'warning',
    matches: (o) => ESTADOS_REPARTO_NOVEDAD.includes(E(o.estado)),
  },

  // ── FASE MEDIA ──────────────────────────────────────────────────────────
  {
    slug: 'en_transito',
    label: 'En tránsito',
    slaDias: 7,
    tone: 'info',
    matches: (o) => matchTransito(E(o.estado)),
  },

  // ── FASE INICIAL — guía generada ────────────────────────────────────────
  {
    slug: 'guia_generada',
    label: 'Guía generada',
    slaDias: 5,
    tone: 'info',
    matches: (o) => {
      if (!ESTADOS_GUIA_GENERADA.includes(E(o.estado))) return false;
      // Disjoint con indem (>= 5d). Pedido nuevo o reciente cae acá.
      return diasSinMovimiento(o) < 5;
    },
  },
  {
    slug: 'indem_guia_generada_5d',
    label: 'Indem. guía generada (+5 días)',
    slaDias: 5,
    tone: 'danger',
    matches: (o) => {
      if (!ESTADOS_GUIA_GENERADA.includes(E(o.estado))) return false;
      return diasSinMovimiento(o) >= 5;
    },
  },

  // ── FASE INICIAL — sin guía aún ─────────────────────────────────────────
  {
    slug: 'pendientes_guia',
    label: 'Pendientes de guía',
    slaDias: 4,
    tone: 'info',
    matches: (o) => {
      if (E(o.estado) !== 'PENDIENTE') return false;
      if (o.guia && o.guia.trim()) return false;
      // Disjoint con indem (>= 4d). Recientes caen acá.
      return diasDesdeCreacion(o) < 4;
    },
  },
  {
    slug: 'indem_pendientes_guia_4d',
    label: 'Indem. pendientes de guía (+4 días)',
    slaDias: 4,
    tone: 'danger',
    matches: (o) => {
      if (E(o.estado) !== 'PENDIENTE') return false;
      if (o.guia && o.guia.trim()) return false;
      return diasDesdeCreacion(o) >= 4;
    },
  },

  // ── Catch-all ───────────────────────────────────────────────────────────
  {
    slug: 'otros_estados',
    label: 'Otros estados',
    slaDias: 0,
    tone: 'neutral',
    matches: (o) => {
      const e = E(o.estado);
      if (!e) return false;
      if (ESTADOS_TERMINALES.includes(e)) return false;
      if (e === 'PENDIENTE') return false;
      if (e === 'PENDIENTE CONFIRMACION') return false;
      if (ESTADOS_GUIA_GENERADA.includes(e)) return false;
      if (matchTransito(e)) return false;
      if (ESTADOS_REPARTO_NOVEDAD.includes(e)) return false;
      if (ESTADOS_OFICINA(e)) return false;
      return true;
    },
  },
];

export function findSegList(slug: SegListSlug): SegListDef | undefined {
  return SEG_LISTS.find((l) => l.slug === slug);
}

export function isValidSegListSlug(s: string | null | undefined): s is SegListSlug {
  if (!s) return false;
  return SEG_LISTS.some((l) => l.slug === s);
}
