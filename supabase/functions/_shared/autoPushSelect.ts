// Selección de candidatos para el auto-push Shopify → Dropi.
//
// Lógica PURA (sin red, sin Deno) para poder testearla con datos fijos. Decide
// qué pedidos de Shopify el robot debe intentar subir AHORA:
//   - Necesita teléfono usable (sin él no se puede cruzar ni crear en Dropi).
//   - GRACIA: no tocar pedidos con menos de `minAgeMs` — le damos tiempo a
//     Dropify (la app de Shopify) para que los suba solo primero. También cierra
//     la carrera con el sync: a los 30 min un pedido que Dropify creó ya está en
//     `orders` (como orden ACTIVA), así el cruce lo detecta y no lo duplicamos.
//   - TECHO de edad: pedidos más viejos que `maxAgeMs` NO se persiguen (suelen
//     ser zonas sin cobertura / imposibles) — quedan para revisión manual.
//   - DUPLICADO vs RECOMPRA (regla del dueño 2026-07-18): NO subimos si el
//     teléfono ya tiene una orden ACTIVA en Dropi (cualquier estatus que NO sea
//     ENTREGADO ni CANCELADO) — es un pedido en curso, no hay que duplicarlo.
//     Pero SÍ subimos si su única orden es ENTREGADA (o cancelada): eso es una
//     RECOMPRA, una venta nueva que debe entrar a Dropi. El robot recibe en
//     `dropiActivePhones` los teléfonos QUE YA TIENEN una orden activa; el
//     caller (shopify-auto-push) decide qué cuenta como "activa" con esa regla.
//   - ⚠️ CONTRAPARTE (arreglo 2026-08-21): la regla de arriba, SOLA, duplicaba
//     pedidos. "Entregado ⇒ recompra" es cierto solo si la venta de Shopify es
//     POSTERIOR a esa entrega. Si es la MISMA venta que ya se despachó y se
//     entregó rápido, el teléfono sale del set de activos y el robot la vuelve a
//     subir como si fuera nueva → DOS envíos al mismo cliente.
//     Caso real (EC, 21-ago-2026): pedido creado el 19-ago 8:56, ENTREGADO al
//     día siguiente; el 20-ago 10:03 apareció el duplicado en PENDIENTE
//     CONFIRMACION. Por eso "no pasa con todos": solo con los que se entregan
//     DENTRO de la ventana de `maxAgeMs` (3 días). En Colombia, con entregas de
//     4-5 días, la venta de Shopify ya salió de la ventana antes de entregarse y
//     el bug no se ve; en Ecuador con LAAR entregando al otro día, sí.
//     Defensa: `contraparteDropiMs` mapea teléfono → fecha de la orden Dropi MÁS
//     RECIENTE de ese teléfono, EN CUALQUIER ESTADO (entregadas Y CANCELADAS
//     incluidas; solo REEMPLAZADA y ARCHIVADO GHOST quedan fuera, igual que en
//     shopify-reconcile). Si esa orden nació DESPUÉS de la venta de Shopify, ES
//     su contraparte y no se sube — aunque alguien la haya cancelado: cancelar
//     fue una decisión sobre ESA venta, no una venta nueva (5-sep-2026, caso
//     Felipe Flores EC: el robot recreó una venta cuya orden acababan de
//     cancelar, y la operadora la vio "volver a la cola").
//     Una recompra real es al revés: su venta de Shopify es más nueva que la
//     orden anterior, así que sigue pasando.
//     Ojo: la idempotencia por `shopify_order_id` NO cubre esto — solo conoce lo
//     que subió ESTE robot, y el original lo suele subir Dropify (la app de
//     Shopify), que no deja ninguna fila nuestra.
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
  /** Teléfonos que YA tienen una orden ACTIVA en Dropi (no entregada ni
   *  cancelada). Un teléfono cuya única orden está ENTREGADA no va acá → recompra. */
  dropiActivePhones: Set<string>,
  pushedByOrderId: Map<string, PushedRecord>,
  opts: SelectOpts,
  /** Teléfono → fecha (ms) de la orden Dropi MÁS RECIENTE de ese teléfono, en
   *  CUALQUIER estado (entregadas incluidas). Ver la nota CONTRAPARTE arriba.
   *  Vacío = se comporta como antes del arreglo. */
  contraparteDropiMs: Map<string, number> = new Map(),
): ShopifyPendingLike[] {
  const picked = orders.filter((o) => {
    if (!o.phoneLast9 || o.phoneLast9.length < 7) return false; // sin teléfono usable
    const age = opts.nowMs - o.createdAtMs;
    if (age < opts.minAgeMs) return false;   // gracia (Dropify / carrera con el sync)
    if (age > opts.maxAgeMs) return false;   // muy viejo → manual
    if (dropiActivePhones.has(o.phoneLast9)) return false; // ya tiene orden ACTIVA → duplicado
    // Esta venta de Shopify YA tiene contraparte en Dropi (aunque esté entregada
    // y por eso no figure como "activa"). Sin comparar contra su propia fecha,
    // una entrega rápida se leía como recompra y se despachaba dos veces.
    const contraparte = contraparteDropiMs.get(o.phoneLast9);
    if (contraparte != null && contraparte >= o.createdAtMs) return false;
    const prev = pushedByOrderId.get(o.shopify_order_id);
    if (prev && blocksRetry(prev, opts.nowMs, opts.errorCooldownMs)) return false;
    return true;
  });
  picked.sort((a, b) => a.createdAtMs - b.createdAtMs); // más viejos primero
  // ⛔ EL LOTE CONTRA SÍ MISMO (4-sep-2026). Dos ventas del mismo teléfono en
  // la misma corrida no estaban en `orders` ninguna de las dos (el espejo llega
  // tarde) y las dos pasaban los filtros de arriba. El push tiene su propio
  // candado sin lag (el gemelo invisible), pero es defensa de un solo nivel:
  // acá se sube UNA por teléfono y por corrida —la más vieja— y la otra espera
  // a la próxima, cuando el espejo ya la muestra o el gemelo la frena.
  const vistos = new Set<string>();
  const unaPorTelefono = picked.filter((o) => {
    if (vistos.has(o.phoneLast9)) return false;
    vistos.add(o.phoneLast9);
    return true;
  });
  return opts.cap > 0 ? unaPorTelefono.slice(0, opts.cap) : unaPorTelefono;
}
