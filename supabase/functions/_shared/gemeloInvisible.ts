// El gemelo INVISIBLE: la orden que ya creamos y que ningún candado puede ver.
//
// ── El bug, reportado por el dueño el 3-sep-2026 ────────────────────────────
// Una asesora mandó la foto de un pedido con DOS guías generadas. Los números
// eran consecutivos (…880 y …881): eso no es "ayer se subió y hoy otra vez",
// son dos órdenes creadas con segundos de diferencia. Y no fue una: *"ayer se
// doblaron varios"*.
//
// ── Por qué los tres candados que ya había no lo vieron ─────────────────────
// Los tres —el del robot (`autoPushSelect`), el del panel (`find_duplicate_phones`)
// y el del servidor (`findDuplicatesServiceRole`)— preguntan lo MISMO:
// *¿este teléfono ya tiene una orden en la tabla `orders`?*
//
// Y `orders` es el ESPEJO de Dropi: una fila entra ahí cuando el cron la
// importa, no cuando la orden se crea. Entre una cosa y la otra pasan minutos
// u horas. Esa ventana ciega deja pasar dos casos reales:
//
//   · Dos ventas de Shopify del mismo cliente en la MISMA corrida del robot.
//     El robot arma la lista de teléfonos ocupados UNA vez, al principio; la
//     orden que él mismo crea en el primer push no está en esa lista, ni en
//     `orders`, cuando llega al segundo. Las dos pasan. Dos guías consecutivas.
//   · Lo mismo entre dos corridas seguidas, mientras el cron no importó la
//     primera.
//
// ── La fuente que NO tiene lag ──────────────────────────────────────────────
// `shopify_pushed_orders` es NUESTRO registro y se escribe ANTES del POST a
// Dropi (el claim atómico). Si acabamos de crear una orden para este teléfono,
// ahí está — aunque Dropi todavía no nos la haya devuelto. El teléfono ya
// viaja dentro de `payload`, así que esto no necesita ninguna columna nueva:
// cero DDL, cero migración, cero tabla caliente tocada (REGLA #0).
//
// ⛔ Y NO CAMBIA NINGUNA REGLA DE NEGOCIO. Solo tapa el hueco temporal:
//   · Si la orden gemela YA se ve en `orders`, esta lógica se aparta y decide
//     el guard de siempre — el que sabe la regla del dueño del 18-jul-2026
//     (ENTREGADO = recompra legítima, se sube). Pisar eso sería reintroducir
//     la venta perdida en silencio que esa regla vino a arreglar.
//   · La ventana es de 24 h, no de 60 días. Después el espejo ya la tiene.
//   · Y sigue habiendo escape manual: "No es duplicado".
//
// Puro: sin red, sin Deno. Se prueba desde `src/lib/gemeloInvisible.test.ts`
// (el patrón de este repo: `npm test` no corre las pruebas de las edge).

/** Cuánto atrás se mira. Cubre el lag del espejo, NO el horizonte de recompra. */
export const VENTANA_GEMELO_MS = 24 * 60 * 60 * 1000;

export interface FilaPush {
  shopify_order_id: string;
  dropi_order_id: string | null;
  /** Lo que se le mandó a Dropi. El teléfono va acá dentro. */
  payload: { phone?: string } | null;
}

export interface Gemelo {
  shopify_order_id: string;
  dropi_order_id: string | null;
}

/** Últimos 9 dígitos — mismo criterio que el resto de la cadena Shopify→Dropi. */
export function last9(p: unknown): string {
  return String(p ?? "").replace(/\D/g, "").slice(-9);
}

/**
 * ¿Hay una orden creada hace poco para este mismo teléfono que el espejo
 * todavía no muestra? Devuelve la primera, o `null`.
 *
 * @param filas         intentos recientes de ESTA tienda (created/pending/unknown).
 * @param phoneNorm     teléfono de la venta que se quiere subir, ya en 9 dígitos.
 * @param shopifyOrderId la venta que se está subiendo — no es gemela de sí misma.
 * @param espejadas     `dropi_order_id` que YA aparecen en `orders`: sobre esos
 *                      manda el guard de siempre, no éste.
 */
export function elegirGemeloCiego(
  filas: FilaPush[],
  phoneNorm: string,
  shopifyOrderId: string,
  espejadas: Set<string>,
): Gemelo | null {
  // Un teléfono corto no identifica a nadie: con 3 dígitos "coincidirían"
  // clientes distintos y frenaríamos ventas buenas. Mismo piso que el robot.
  if (!phoneNorm || phoneNorm.length < 7) return null;
  for (const f of filas) {
    if (String(f.shopify_order_id) === String(shopifyOrderId)) continue;
    if (last9(f.payload?.phone) !== phoneNorm) continue;
    // Sin `dropi_order_id` (un 'pending' en curso, o un 'unknown' que quedó sin
    // confirmar) NO se puede comprobar en el espejo: se trata como ciego. Es la
    // dirección segura — la orden probablemente existe en Dropi, y equivocarse
    // acá cuesta un aviso; equivocarse al revés cuesta un flete doble.
    if (!f.dropi_order_id || !espejadas.has(String(f.dropi_order_id))) {
      return { shopify_order_id: f.shopify_order_id, dropi_order_id: f.dropi_order_id };
    }
  }
  return null;
}
