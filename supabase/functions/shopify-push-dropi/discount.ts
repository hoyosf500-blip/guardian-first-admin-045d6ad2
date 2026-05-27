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
