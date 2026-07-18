// Selección de candidatos para el auto-push Shopify → Dropi.
//
// Lógica PURA (sin red, sin Deno) para poder testearla con datos fijos. Decide
// qué pedidos de Shopify el robot debe intentar subir AHORA, aplicando las
// reglas de seguridad ANTES de gastar una llamada al push:
//   - Necesita teléfono usable (sin él no se puede cruzar ni crear en Dropi).
//   - GRACIA: no tocar pedidos con menos de `minAgeMs` — le damos tiempo a
//     Dropify (la app de Shopify) para que los suba solo primero. También cierra
//     la carrera con el sync: a los 30 min un pedido que Dropify creó ya está en
//     `orders`, así el cruce por teléfono lo detecta y no lo duplicamos.
//   - TECHO de edad: pedidos más viejos que `maxAgeMs` NO se persiguen (suelen
//     ser zonas sin cobertura / imposibles) — quedan para revisión manual.
//   - Si el teléfono YA está en Dropi (`orders`) → ya llegó, no lo subimos.
//   - Si ya hay un intento 'created'/'pending'/'unknown' → no reintentar
//     (idempotencia; 'unknown' exige verificación humana, nunca automático).
//   - Un intento 'error' se reintenta, pero con enfriamiento (`errorCooldownMs`)
//     para no martillar cada 15 min un pedido que falla siempre (ej. remoto).
//
// El resultado va ORDENADO del más viejo al más nuevo (drena el backlog en
// orden) y CAPADO a `cap` por corrida (acota la carga sobre Dropi).

export interface ShopifyPendingLike {
  shopify_order_id: string;
  /** Últimos 9 dígitos del teléfono (mismo criterio que shopify-reconcile). */
  phoneLast9: string;
  createdAtMs: number;
}

export interface PushedRecord {
  status: string; // created | pending | error | unknown
  pushedAtMs: number;
}

export interface SelectOpts {
  nowMs: number;
  minAgeMs: number;       // gracia mínima antes de subir (ej. 30 min)
  maxAgeMs: number;       // techo de edad (ej. 3 días)
  errorCooldownMs: number; // reintento de 'error' no antes de esto (ej. 2 h)
  cap: number;            // tope por corrida por tienda
}

/** Estados de un intento previo que BLOQUEAN un nuevo intento automático. */
function blocksRetry(rec: PushedRecord, nowMs: number, errorCooldownMs: number): boolean {
  if (rec.status === "created" || rec.status === "pending" || rec.status === "unknown") return true;
  // 'error' → reintentable, pero respetando el enfriamiento.
  if (rec.status === "error" && nowMs - rec.pushedAtMs < errorCooldownMs) return true;
  return false;
}

export function selectAutoPushCandidates(
  orders: ShopifyPendingLike[],
  dropiPhoneLast9: Set<string>,
  pushedByOrderId: Map<string, PushedRecord>,
  opts: SelectOpts,
): ShopifyPendingLike[] {
  const picked = orders.filter((o) => {
    if (!o.phoneLast9 || o.phoneLast9.length < 7) return false; // sin teléfono usable
    const age = opts.nowMs - o.createdAtMs;
    if (age < opts.minAgeMs) return false;   // gracia (Dropify / carrera con el sync)
    if (age > opts.maxAgeMs) return false;   // muy viejo → manual
    if (dropiPhoneLast9.has(o.phoneLast9)) return false; // ya está en Dropi
    const prev = pushedByOrderId.get(o.shopify_order_id);
    if (prev && blocksRetry(prev, opts.nowMs, opts.errorCooldownMs)) return false;
    return true;
  });
  picked.sort((a, b) => a.createdAtMs - b.createdAtMs); // más viejos primero
  return opts.cap > 0 ? picked.slice(0, opts.cap) : picked;
}
