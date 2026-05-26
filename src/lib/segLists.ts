import type { OrderData } from './orderUtils';
import { calcBusinessDays, parseDate } from './orderUtils';

/**
 * "Listas SLA" estilo Boostec: 8 sublistas pre-clasificadas que el operador
 * elige desde un dropdown para enfocarse en pedidos por estado + antigüedad
 * en días hábiles (en lugar de filtrar mentalmente por estado).
 *
 * Reglas de diseño:
 *  - Las listas con prefijo "indem_" son sub-conjuntos críticos (excedieron
 *    el SLA de indemnización). La lista no-indem se acota con < N días para
 *    NO duplicar (un pedido con 5 días pendiente de guía cae solo en indem,
 *    no en pendientes_guia_2d).
 *  - "pendientes_confirmacion_2d" vive en /confirmar — no se filtra acá, es
 *    sólo un link visual para mantener paridad con Boostec.
 *  - "otros_estados" es el catch-all para no perder pedidos que no encajen
 *    en ningún bucket conocido (excluye terminales: ENTREGADO/CANCELADO/DEVOLUCION).
 */

export type SegListSlug =
  | 'pendientes_confirmacion_2d'
  | 'pendientes_guia_2d'
  | 'indem_pendientes_guia_4d'
  | 'guia_generada_2d'
  | 'indem_guia_generada_5d'
  | 'reclamar_oficina_4d'
  | 'en_proceso_7d'
  | 'otros_estados';

export interface SegListDef {
  slug: SegListSlug;
  label: string;
  /** SLA en días hábiles para mostrar en el badge / hint */
  slaDias: number;
  /** Tono visual de la lista (urgencia) */
  tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  /** Predicado que indica si una orden cae en esta lista */
  matches: (o: OrderData) => boolean;
  /** Link externo si la lista vive en otra ruta (ej. confirmación → /confirmar) */
  externalRoute?: string;
}

const E = (s: string | null | undefined): string => (s || '').toUpperCase().trim();

const ESTADOS_TRANSITO = [
  'EN TRANSPORTE',
  'EN DESPACHO',
  'EN TRASLADO NACIONAL',
  'EN TERMINAL ORIGEN',
  'EN TERMINAL DESTINO',
  'EN REPARTO',
  'EN DISTRIBUCION',
  'EN REEXPEDICION',
  'ENTREGADA A CONEXIONES',
  'TELEMERCADEO',
  'REENVIO',
  'REENVÍO',
  'EN BODEGA TRANSPORTADORA',
  'EN BODEGA DROPI',
  'RECOGIDO POR DROPI',
];

const ESTADOS_GUIA_GENERADA = ['GUIA_GENERADA', 'GUIA GENERADA', 'ADMITIDA'];

const ESTADOS_RECLAMAR = (e: string): boolean =>
  e.includes('RECLAMAR') || e.includes('EN PUNTO');

const ESTADOS_TERMINALES = [
  'ENTREGADO',
  'CANCELADO',
  'DEVOLUCION',
  'DEVOLUCION EN TRANSITO',
  'DEVUELTO',
  'RECHAZADO',
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
 * la semántica correcta (guía generada / en proceso / reclamar oficina): un
 * pedido VIEJO pero que se movió ayer NO debe contar como atrasado — antes esto
 * usaba antigüedad desde creación y marcaba como "sin movimiento" guías que de
 * hecho ya se habían entregado/movido.
 *
 * 0 es un valor VÁLIDO (se movió hoy) — por eso NO usamos el patrón
 * `if (d > 0)` de diasDesdeCreacion. Solo caemos al fallback de creación si
 * `lastMovementAt` falta o no parsea: la columna aún no está viva en la DB
 * (ver orderColumns.ts) o el pedido nunca registró updated_at. Con el fallback
 * el comportamiento es idéntico al previo a la migración 20260526120000.
 */
function diasSinMovimiento(o: OrderData): number {
  if (o.lastMovementAt && parseDate(o.lastMovementAt)) {
    return calcBusinessDays(o.lastMovementAt);
  }
  return diasDesdeCreacion(o);
}

export const SEG_LISTS: SegListDef[] = [
  {
    slug: 'pendientes_confirmacion_2d',
    label: 'Pendientes de confirmación (+2 días)',
    slaDias: 2,
    tone: 'warning',
    externalRoute: '/confirmar',
    matches: () => false, // vive en /confirmar — esta lista solo es link
  },
  {
    slug: 'pendientes_guia_2d',
    label: 'Pendientes de guía (+2 días)',
    slaDias: 2,
    tone: 'warning',
    matches: (o) => {
      if (E(o.estado) !== 'PENDIENTE') return false;
      if (o.guia && o.guia.trim()) return false;
      const d = diasDesdeCreacion(o);
      return d >= 2 && d < 4;
    },
  },
  {
    slug: 'indem_pendientes_guia_4d',
    label: 'Indemnización pendientes de guía (+4 días)',
    slaDias: 4,
    tone: 'danger',
    matches: (o) => {
      if (E(o.estado) !== 'PENDIENTE') return false;
      if (o.guia && o.guia.trim()) return false;
      return diasDesdeCreacion(o) >= 4;
    },
  },
  {
    slug: 'guia_generada_2d',
    label: 'Guía generada (+2 días)',
    slaDias: 2,
    tone: 'warning',
    matches: (o) => {
      if (!ESTADOS_GUIA_GENERADA.includes(E(o.estado))) return false;
      const d = diasSinMovimiento(o);
      return d >= 2 && d < 5;
    },
  },
  {
    slug: 'indem_guia_generada_5d',
    label: 'Indemnización guía generada (+5 días)',
    slaDias: 5,
    tone: 'danger',
    matches: (o) => {
      if (!ESTADOS_GUIA_GENERADA.includes(E(o.estado))) return false;
      return diasSinMovimiento(o) >= 5;
    },
  },
  {
    slug: 'reclamar_oficina_4d',
    label: 'Reclamar en oficina (+4 días)',
    slaDias: 4,
    tone: 'danger',
    matches: (o) => {
      if (!ESTADOS_RECLAMAR(E(o.estado))) return false;
      return diasSinMovimiento(o) >= 4;
    },
  },
  {
    slug: 'en_proceso_7d',
    label: 'En proceso (+7 días)',
    slaDias: 7,
    tone: 'danger',
    matches: (o) => {
      if (!ESTADOS_TRANSITO.includes(E(o.estado))) return false;
      return diasSinMovimiento(o) >= 7;
    },
  },
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
      if (ESTADOS_TRANSITO.includes(e)) return false;
      if (ESTADOS_RECLAMAR(e)) return false;
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
