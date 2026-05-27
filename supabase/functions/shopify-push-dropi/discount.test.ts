// Tests del reparto de descuento de orden. Correr con:
//   deno test supabase/functions/shopify-push-dropi/discount.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { allocateOrderDiscount } from "./discount.ts";

// Caso del bug real (#1132): 2 × $45 = $90, descuento de ORDEN $20, sin descuento
// de línea. Debe repartir los $20 a la única línea → precio neto 70 → $35/u.
Deno.test("descuento de orden sobre 1 línea sin descuento de línea", () => {
  const extras = allocateOrderDiscount([{ gross: 90, lineDiscount: 0 }], 20);
  assertEquals(extras, [20]);
  // Verificación del precio resultante como lo hace index.ts:
  const newLineTotal = 90 - 0 - extras[0]; // 70
  assertEquals(Math.round(newLineTotal / 2), 35);
});

// Idempotente: si la línea ya trae TODO el descuento (total_discount), el residual
// es 0 y no se reparte nada extra (no doble-cuenta).
Deno.test("descuento ya aplicado en la línea → no reparte de más", () => {
  const extras = allocateOrderDiscount([{ gross: 90, lineDiscount: 20 }], 20);
  assertEquals(extras, [0]);
});

// Sin descuento de orden → no toca nada.
Deno.test("sin descuento de orden → ceros", () => {
  const extras = allocateOrderDiscount([{ gross: 90, lineDiscount: 0 }, { gross: 30, lineDiscount: 0 }], 0);
  assertEquals(extras, [0, 0]);
});

// 2 líneas: reparto proporcional al neto + el redondeo cae en la línea de mayor neto,
// manteniendo la suma EXACTA = descuento de orden.
Deno.test("reparto proporcional en 2 líneas con redondeo exacto", () => {
  // netos 100 y 50 (total 150), descuento 15 → 10 y 5.
  const extras = allocateOrderDiscount([{ gross: 100, lineDiscount: 0 }, { gross: 50, lineDiscount: 0 }], 15);
  assertEquals(extras, [10, 5]);
  assertEquals(extras[0] + extras[1], 15);

  // Caso con redondeo no exacto: netos 70 y 30 (total 100), descuento 11 →
  // 70*11/100=7.7→8 ; 30*11/100=3.3→3 ; suma 11. El sobrante (0) ya está bien;
  // probamos uno que fuerce ajuste: descuento 1 → 0.7→1 y 0.3→0 ; suma 1.
  const e2 = allocateOrderDiscount([{ gross: 70, lineDiscount: 0 }, { gross: 30, lineDiscount: 0 }], 1);
  assertEquals(e2[0] + e2[1], 1);
});

// Clamp: nunca reparte más que el neto disponible (evita precios negativos).
Deno.test("clamp cuando el descuento supera el neto", () => {
  const extras = allocateOrderDiscount([{ gross: 50, lineDiscount: 0 }], 999);
  assertEquals(extras, [50]); // a lo sumo todo el neto
  assertEquals(50 - 0 - extras[0], 0); // precio neto no baja de 0
});
