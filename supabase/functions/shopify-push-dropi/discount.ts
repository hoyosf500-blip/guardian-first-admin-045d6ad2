// Reparto del descuento a NIVEL DE ORDEN de Shopify sobre las líneas de producto.
// Vive en su propio módulo (no en index.ts) para poder testearlo sin arrastrar el
// `Deno.serve` del handler (importarlo en el test dejaría un servidor colgado).

/**
 * Reparte el descuento a NIVEL DE ORDEN de Shopify (`total_discounts`) que todavía
 * NO está reflejado en las líneas, proporcional al NETO de cada línea de PRODUCTO.
 * Devuelve el descuento EXTRA (en moneda) a restarle a cada línea, en el mismo orden.
 *
 * Idempotente: si las líneas ya traen todo el descuento (vía `total_discount` /
 * `discount_allocations`), el residual da 0 y no toca nada. La suma de lo repartido
 * es EXACTAMENTE el residual (el redondeo sobrante va a la línea de mayor neto), y
 * nunca se reparte más que el neto disponible (clamp), para no dejar precios < 0.
 */
export function allocateOrderDiscount(
  lines: { gross: number; lineDiscount: number }[],
  orderDiscount: number,
): number[] {
  const out = lines.map(() => 0);
  const alreadyAllocated = lines.reduce((s, l) => s + l.lineDiscount, 0);
  const nets = lines.map((l) => Math.max(0, l.gross - l.lineDiscount));
  const netTotal = nets.reduce((s, n) => s + n, 0);
  let residual = Math.round((orderDiscount || 0) - alreadyAllocated);
  residual = Math.max(0, Math.min(residual, netTotal)); // clamp: nunca > neto disponible
  if (residual <= 0 || netTotal <= 0) return out;
  let assigned = 0;
  for (let i = 0; i < lines.length; i++) {
    out[i] = Math.round((residual * nets[i]) / netTotal);
    assigned += out[i];
  }
  // El sobrante por redondeo va a la línea de mayor neto (mantiene la suma exacta).
  const diff = residual - assigned;
  if (diff !== 0) {
    let maxI = 0;
    for (let i = 1; i < lines.length; i++) if (nets[i] > nets[maxI]) maxI = i;
    out[maxI] += diff;
  }
  return out;
}

/**
 * Red de seguridad (guardrail): ¿el COD que se cobraría supera el total REAL de
 * Shopify (= lo que el cliente vio y aceptó)? Si es así, casi seguro se perdió un
 * descuento y NO hay que subirlo a Dropi.
 *
 * Solo marca la dirección PELIGROSA (cobrar de más). Si Shopify suma IVA aparte y
 * el cobro queda por DEBAJO, no marca (no es el problema). Tolera el redondeo
 * (1% + 2 unidades de moneda); un descuento perdido lo supera de lejos. Si no hay
 * total de Shopify, NO marca (no podemos comparar → no bloqueamos a ciegas).
 */
export function isCodOvercharge(pushedTotal: number, shopifyTotal: number): boolean {
  if (!(shopifyTotal > 0)) return false;
  const tol = Math.max(2, shopifyTotal * 0.01);
  return pushedTotal - shopifyTotal > tol;
}
