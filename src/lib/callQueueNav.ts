// Navegación PURA de la cola de /confirmar. Sin React, sin red — testeable.
//
// Por qué existe: CallView navegaba con lógica inline frágil — un setTimeout que
// leía la cola 400 ms tarde (stale-closure) y un fallback que saltaba al TOPE
// cuando el pedido anclado desaparecía. Extraer estas 4 funciones puras deja el
// avance/fallback testeable y consistente. El "key" de un pedido = su
// identificador estable (externalId; si no, dbId) — mismo criterio que el BUG B
// fix de CallView (ancla por id, no por índice, porque el índice se rompe cuando
// la cola se reordena por refresh/sync).

export interface NavItem {
  externalId?: string | null;
  dbId?: string | null;
  result?: string;
}

/** Identificador estable del pedido (externalId, si no dbId, si no null). */
export function itemKey(o: NavItem | undefined | null): string | null {
  return o ? (o.externalId || o.dbId || null) : null;
}

/** Índice del pedido cuyo key coincide; -1 si no está o key null. */
export function indexOfKey(items: NavItem[], key: string | null): number {
  if (!key) return -1;
  return items.findIndex((o) => (o.externalId || o.dbId) === key);
}

/** Key del PRÓXIMO pedido sin gestionar (result falsy) DESPUÉS de fromIdx.
 *  Se calcula sobre la cola FRESCA que se le pasa → quien lo llame en el momento
 *  de marcar (no en un setTimeout diferido) evita el stale-closure. null si no
 *  hay siguiente sin gestionar. */
export function nextUnmanagedKey(items: NavItem[], fromIdx: number): string | null {
  const next = items.find((o, i) => i > fromIdx && !o.result);
  return itemKey(next);
}

/** Índice a mostrar cuando el pedido anclado ya NO está en la cola.
 *  En vez de saltar al tope (0), quedarse cerca de la última posición buena:
 *    1) el primer pendiente DESDE lastGoodIdx hacia adelante (el que ocupó el
 *       lugar del que se fue ≈ el siguiente),
 *    2) si no hay, el primer pendiente global,
 *    3) si tampoco (todo gestionado), el clamp de lastGoodIdx.
 *  Mantiene a la operadora en su lugar cuando un pedido desaparece por fuera
 *  (el cron le cambia el estado), en vez de teletransportarla al tope. */
export function resolveFallbackIdx(items: NavItem[], lastGoodIdx: number): number {
  if (!items.length) return 0;
  const anchor = Math.min(Math.max(0, lastGoodIdx), items.length - 1);
  const fromAnchor = items.findIndex((o, i) => i >= anchor && !o.result);
  if (fromAnchor >= 0) return fromAnchor;
  const firstPending = items.findIndex((o) => !o.result);
  return firstPending >= 0 ? firstPending : anchor;
}
