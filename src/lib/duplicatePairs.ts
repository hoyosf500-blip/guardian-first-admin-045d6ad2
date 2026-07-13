// Detección de pares "stub + reenvío" entre pedidos ACTIVOS.
//
// Caso real (auditoría 2026-07-12): al reenviar/editar un pedido (típico bot
// LucidBot), Dropi crea uno NUEVO y el viejo queda vivo — 2 pedidos activos
// con el mismo teléfono (ej. Alicia Chancay #6078098 GINTRACOM viejo +
// #6083663 SERVIENTREGA nuevo). Si la asesora gestiona el VIEJO, el cliente
// recibe doble envío o se confirma la guía equivocada.
//
// Util puro (sin red, sin React): agrupa los pedidos ACTIVOS
// (PENDIENTE / PENDIENTE CONFIRMACION) por los últimos 9 dígitos del teléfono
// (mismo criterio de match que shopify-reconcile) y devuelve, por teléfono,
// el par {viejo, nuevo}. Con 3+ activos (trío) devuelve los extremos.

export interface DupPairOrder {
  externalId: string;
  phone: string | null | undefined;
  estado: string | null | undefined;
  createdAt?: string | null;
}

export interface DuplicatePair<T extends DupPairOrder = DupPairOrder> {
  /** El pedido MÁS VIEJO del grupo — el que NO hay que gestionar. */
  viejo: T;
  /** El pedido MÁS NUEVO del grupo — el reenvío que vale. */
  nuevo: T;
}

const ACTIVE_STATES = new Set(['PENDIENTE', 'PENDIENTE CONFIRMACION']);

/**
 * Últimos 9 dígitos del teléfono. Devuelve null si quedan <7 dígitos
 * (teléfono vacío/basura) para no generar matches falsos.
 */
export function phoneKey9(phone: string | null | undefined): string | null {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (d.length < 7) return null;
  return d.slice(-9);
}

function isActive(estado: string | null | undefined): boolean {
  return ACTIVE_STATES.has(String(estado ?? '').trim().toUpperCase());
}

/**
 * Orden cronológico: externalId numérico primero (Dropi asigna IDs
 * auto-incrementales — misma señal que findSupersededInSeg); createdAt como
 * fallback cuando algún id no es numérico.
 */
function chronoCompare(a: DupPairOrder, b: DupPairOrder): number {
  const na = Number(a.externalId);
  const nb = Number(b.externalId);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  const ta = Date.parse(String(a.createdAt ?? ''));
  const tb = Date.parse(String(b.createdAt ?? ''));
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
  return 0;
}

/**
 * Detecta pares de pedidos ACTIVOS (PENDIENTE / PENDIENTE CONFIRMACION) que
 * comparten los últimos 9 dígitos del teléfono.
 *
 * - Ignora pedidos sin teléfono usable, sin externalId o en estados no activos.
 * - Dedupea por externalId (la misma orden puede llegar 2 veces si se mezclan
 *   la cola visible y los "progressed" de la misma pantalla).
 * - Con 3+ activos del mismo teléfono devuelve los extremos (más viejo / más
 *   nuevo) — los intermedios también son sospechosos pero el accionable es
 *   "gestioná el más nuevo".
 *
 * @returns Map de clave-teléfono (últimos 9 dígitos) → {viejo, nuevo}.
 */
export function detectDuplicatePairs<T extends DupPairOrder>(
  orders: T[],
): Map<string, DuplicatePair<T>> {
  const byPhone = new Map<string, T[]>();
  const seen = new Set<string>();
  for (const o of orders) {
    if (!o || !isActive(o.estado)) continue;
    const key = phoneKey9(o.phone);
    if (!key) continue;
    const ext = String(o.externalId ?? '').trim();
    if (!ext || seen.has(ext)) continue;
    seen.add(ext);
    const list = byPhone.get(key);
    if (list) list.push(o);
    else byPhone.set(key, [o]);
  }

  const out = new Map<string, DuplicatePair<T>>();
  for (const [key, list] of byPhone) {
    if (list.length < 2) continue;
    const sorted = [...list].sort(chronoCompare);
    out.set(key, { viejo: sorted[0], nuevo: sorted[sorted.length - 1] });
  }
  return out;
}
