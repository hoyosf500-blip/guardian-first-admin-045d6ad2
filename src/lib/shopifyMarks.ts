/**
 * Lógica pura del historial de marcas "Ya lo metí" (panel anti-fuga de Confirmar).
 * Sin red ni React — todo testeable. El componente y el hook consumen esto.
 *
 * Fechas en zona horaria America/Bogota (UTC-5, sin DST) — sirve para CO y EC,
 * mismo criterio que ShopifyPendingPanel (`localDay`).
 */

export interface ManualMark {
  id: string;
  shopify_order_id: string;
  shopify_name: string | null;
  customer: string | null;
  phone: string | null;
  total: number | null;
  city: string | null;
  marked_at: string;   // ISO
}

export interface DateRange {
  from: string;        // YYYY-MM-DD
  to: string;          // YYYY-MM-DD
}

const BOGOTA = 'America/Bogota';
const DAY_MS = 86_400_000;
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: BOGOTA, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Día calendario (YYYY-MM-DD) en Bogotá para un instante en ms. */
export function bogotaDay(ms: number): string {
  return dayFmt.format(new Date(ms));
}

/** Día calendario (YYYY-MM-DD) en Bogotá de una marca. */
export function markBogotaDay(mark: Pick<ManualMark, 'marked_at'>): string {
  return bogotaDay(new Date(mark.marked_at).getTime());
}

/**
 * Rango por defecto = últimos `days` días calendario en Bogotá, INCLUSIVO de hoy.
 * days=3 → [antier .. hoy]. `nowMs` se inyecta para poder testear.
 */
export function defaultMarkRange(nowMs: number, days = 3): DateRange {
  const safe = Math.max(1, Math.floor(days));
  return {
    from: bogotaDay(nowMs - (safe - 1) * DAY_MS),
    to: bogotaDay(nowMs),
  };
}

/** Marcas cuyo día Bogotá cae dentro de [from, to] (comparación lexicográfica YYYY-MM-DD). */
export function filterMarksByRange(marks: ManualMark[], range: DateRange): ManualMark[] {
  const { from, to } = range;
  return marks.filter(m => {
    const d = markBogotaDay(m);
    return d >= from && d <= to;
  });
}

/**
 * Agrupa por día (más nuevo primero; dentro del día, marca más nueva primero).
 * Devuelve `[díaYYYYMMDD, marcas][]` listo para render.
 */
export function groupMarksByDay(marks: ManualMark[]): Array<[string, ManualMark[]]> {
  const byDay = new Map<string, ManualMark[]>();
  for (const m of marks) {
    const d = markBogotaDay(m);
    const bucket = byDay.get(d);
    if (bucket) bucket.push(m);
    else byDay.set(d, [m]);
  }
  for (const arr of byDay.values()) {
    arr.sort((a, b) => b.marked_at.localeCompare(a.marked_at));
  }
  return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

/**
 * Estado de reconciliación de una marca contra Dropi.
 *  - 'missing': el pedido marcado SIGUE pendiente en Shopify (NO está en Dropi) →
 *               se marcó "ya lo metí" pero no entró. Es la fuga a verificar.
 *  - 'ok':      ya no está pendiente (entró a Dropi) — dentro de la ventana de
 *               reconciliación del panel.
 */
export function markReconStatus(orderId: string, pendingIds: Set<string>): 'missing' | 'ok' {
  return pendingIds.has(orderId) ? 'missing' : 'ok';
}
