/**
 * Seguimiento "revisión diaria": lógica pura para decidir si un pedido sale de
 * la lista de HOY y para clasificar las acciones simplificadas.
 *
 * Modelo: la card de Seguimiento pasó de 7 botones a "Gestioné hoy" (con método
 * rápido) + cierre (Resuelto/Devolución). Cada acción registra un touchpoint
 * `SEG: <acción>`. Un pedido sale de la lista del día cuando:
 *   - cierre  → oculto 30 días (sale de Seguimiento hasta nuevo ciclo)
 *   - gestión → oculto SOLO si se gestionó hoy → reaparece mañana
 * El reset es automático: depende de `action_date` (zona Bogotá), sin cron.
 *
 * Ver spec: docs/superpowers/specs/2026-05-26-seguimiento-revision-diaria-design.md
 */
import { esContactoEfectivo } from './segMetodosEstado';

/**
 * Métodos de gestión (lo que se despliega bajo "Gestioné hoy").
 * @deprecated 2026-07-30 — la botonera ya no usa esta lista fija: los métodos
 * son POR ESTADO del pedido (src/lib/segMetodosEstado.ts, donde esta lista
 * sigue viva como fallback METODOS_DEFAULT). Se conserva la export por si
 * algún consumidor histórico la referencia.
 */
export const SEG_METHODS = [
  'Llamé',
  'WhatsApp',
  'Reclamé transportadora',
  'Cliente recoge',
] as const;

/** Acciones de cierre (sacan el pedido de Seguimiento). */
export const SEG_CLOSERS = ['Resuelto', 'Devolución'] as const;

/** Días que un pedido cerrado (Resuelto/Devolución) permanece fuera de la vista. */
export const CLOSER_SNOOZE_MS = 30 * 24 * 3600 * 1000;

// Incluye labels viejos para que los touchpoints históricos (pre-rediseño)
// sigan clasificándose bien como cierre.
const CLOSER_LABELS = new Set<string>([
  'Resuelto',
  'Devolución',
  'Devolucion solicitada',
  'Solicite devolucion',
]);

/** Quita el prefijo de módulo (`SEG:` / `RESCUE:`) y espacios. */
export function cleanSegAction(raw: string): string {
  return (raw || '').replace(/^(SEG|RESCUE):\s*/, '').trim();
}

/** ¿La acción es de cierre (saca el pedido de Seguimiento)? */
export function isSegCloser(action: string): boolean {
  return CLOSER_LABELS.has(cleanSegAction(action));
}

/** Último touchpoint relevante de un pedido (por teléfono, el más reciente). */
export interface LatestTouch {
  /** Acción cruda o limpia (`SEG: Llamé` o `Llamé`). */
  action: string;
  /** Fecha del touchpoint en formato `YYYY-MM-DD` (bogotaToday al insertar). */
  actionDate: string;
  /** `created_at` en milisegundos. */
  whenMs: number;
  /** Quién lo registró — permite distinguir gestión propia de ajena. */
  operatorId?: string | null;
}

/**
 * ¿El pedido sale de la lista de HOY?
 *  - cierre: oculto mientras no pasen 30 días desde el touchpoint.
 *  - gestión (cualquier método, o labels viejos): oculto solo si el touchpoint
 *    es de hoy (Bogotá) → al cambiar el día reaparece (revisión diaria).
 *
 * `opts.esMio` (fix C3, auditoría 14-ago-2026): la gestión PROPIA oculta
 * siempre —acabo de tocarlo, volver a marcarlo duplicaría el registro—; la
 * AJENA solo si hubo CONTACTO. El "No contestó" de una compañera deja el
 * pedido pendiente para todo el equipo: es el mismo criterio que
 * `estaGestionadoHoy` le aplicó al Tablero el 31-jul, y la vista Lista se
 * había quedado sin el fix — el cliente que no atendió a la primera se volvía
 * invisible el resto del día y nadie lo volvía a llamar. Sin `opts` se
 * conserva el comportamiento histórico (oculta sin mirar quién ni qué).
 */
export function isHiddenFromTodayList(
  latest: LatestTouch | null | undefined,
  nowMs: number,
  todayBogota: string,
  opts?: { esMio?: boolean },
): boolean {
  if (!latest) return false;
  if (isSegCloser(latest.action)) {
    return nowMs - latest.whenMs < CLOSER_SNOOZE_MS;
  }
  if (opts?.esMio === false && !esContactoEfectivo(cleanSegAction(latest.action))) return false;
  return latest.actionDate === todayBogota;
}

/** Etiqueta corta para la card oculta (chip "gestionado"). */
export function hiddenLabel(latest: LatestTouch): string {
  return isSegCloser(latest.action) ? cleanSegAction(latest.action) : 'Gestionado hoy';
}
