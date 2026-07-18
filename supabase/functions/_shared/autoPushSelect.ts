// Selección de candidatos para el auto-push Shopify → Dropi.
//
// Lógica PURA (sin red, sin Deno) para poder testearla con datos fijos. Decide
// qué pedidos de Shopify el robot debe intentar subir AHORA:
//   - Necesita teléfono usable (sin él no se puede cruzar ni crear en Dropi).
//   - GRACIA: no tocar pedidos con menos de `minAgeMs` — le damos tiempo a
//     Dropify (la app de Shopify) para que los suba solo primero. También cierra
//     la carrera con el sync: a los 30 min un pedido que Dropify creó ya está en
//     `orders`, así el cruce por fecha+teléfono lo detecta y no lo duplicamos.
//   - TECHO de edad: pedidos más viejos que `maxAgeMs` NO se persiguen (suelen
//     ser zonas sin cobertura / imposibles) — quedan para revisión manual.
//   - MISMO PEDIDO vs RECOMPRA (clave): NO subimos si el teléfono ya tiene una
//     orden en Dropi creada CERCA de la fecha de este pedido (= el mismo pedido,
//     ya está en Dropi). Pero SÍ subimos si la única orden Dropi de ese teléfono
//     es VIEJA (una compra anterior ya entregada) — eso es una RECOMPRA, una
//     venta nueva que debe entrar a Dropi. (Antes se bloqueaba por "teléfono
//     repetido" a secas y las recompras quedaban trabadas — pedido del dueño
//     2026-07-18: "que suba todos, el asesor cancela en Dropi lo que sobre".)
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
  minAgeMs: number;        // gracia mínima antes de subir (ej. 30 min)
  maxAgeMs: number;        // techo de edad (ej. 3 días)
  errorCooldownMs: number; // reintento de 'error' no antes de esto (ej. 2 h)
  cap: number;             // tope por corrida por tienda
  // Ventana de "mismo pedido" para el cruce contra Dropi: una orden Dropi del
  // mismo teléfono creada en [shopifyMs - matchBackMs, shopifyMs + matchFwdMs]
  // se considera EL MISMO pedido (ya en Dropi) → NO subir. Una orden Dropi ANTES
  // de esa ventana = compra anterior (recompra) → SÍ subir. Replica el criterio
  // de shopify-reconcile (así el robot y el panel anti-fuga ven la misma lista).
  matchBackMs: number;     // ej. 1 día
  matchFwdMs: number;      // ej. 45 días (cubre el catch-up de subidas tardías)
}

/** Estados de un intento previo que BLOQUEAN un nuevo intento automático. */
function blocksRetry(rec: PushedRecord, nowMs: number, errorCooldownMs: number): boolean {
  if (rec.status === "created" || rec.status === "pending" || rec.status === "unknown") return true;
  // 'error' → reintentable, pero respetando el enfriamiento.
  if (rec.status === "error" && nowMs - rec.pushedAtMs < errorCooldownMs) return true;
  return false;
}

/** ¿Este pedido de Shopify YA está en Dropi? Sí solo si hay una orden Dropi del
 *  mismo teléfono creada CERCA de su fecha (el mismo pedido). Una orden Dropi
 *  vieja del mismo teléfono es una compra anterior (recompra) → NO cuenta como
 *  "ya está" → el pedido debe subir. */
function alreadyInDropi(
  shopifyMs: number, dropiTimes: number[] | undefined, backMs: number, fwdMs: number,
): boolean {
  if (!dropiTimes || dropiTimes.length === 0) return false;
  const lo = shopifyMs - backMs;
  const hi = shopifyMs + fwdMs;
  return dropiTimes.some((t) => t >= lo && t <= hi);
}

export function selectAutoPushCandidates(
  orders: ShopifyPendingLike[],
  dropiOrdersByPhone: Map<string, number[]>,
  pushedByOrderId: Map<string, PushedRecord>,
  opts: SelectOpts,
): ShopifyPendingLike[] {
  const picked = orders.filter((o) => {
    if (!o.phoneLast9 || o.phoneLast9.length < 7) return false; // sin teléfono usable
    const age = opts.nowMs - o.createdAtMs;
    if (age < opts.minAgeMs) return false;   // gracia (Dropify / carrera con el sync)
    if (age > opts.maxAgeMs) return false;   // muy viejo → manual
    // ¿El mismo pedido ya está en Dropi? (recompra vieja NO cuenta → sí sube)
    if (alreadyInDropi(o.createdAtMs, dropiOrdersByPhone.get(o.phoneLast9), opts.matchBackMs, opts.matchFwdMs)) return false;
    const prev = pushedByOrderId.get(o.shopify_order_id);
    if (prev && blocksRetry(prev, opts.nowMs, opts.errorCooldownMs)) return false;
    return true;
  });
  picked.sort((a, b) => a.createdAtMs - b.createdAtMs); // más viejos primero
  return opts.cap > 0 ? picked.slice(0, opts.cap) : picked;
}
