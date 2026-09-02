/**
 * Elegir QUÉ pedido de Dropi cubre una venta de Shopify.
 *
 * Vive acá y no dentro de `shopify-reconcile/index.ts` porque `npm test` NO
 * corre las pruebas de las edge functions (`vitest.config.ts` solo mira `src/`).
 * El patrón del repo: lógica pura en `_shared/`, prueba en `src/lib/`
 * (igual que `autoPushSelect` y `walletCategoria`).
 *
 * ⛔ Por qué importa quién gana (2-sep-2026). Antes se tomaba EL PRIMERO de la
 * lista, y la lista no viene ordenada. Con dos pedidos del mismo cliente —uno
 * CANCELADO y el vivo— podía emparejar el cancelado: el cuadre del día mostraba
 * "en Dropi · CANCELADO" sobre una venta que sí está andando, y el reporte de
 * duplicados señalaba **el pedido bueno** como el que sobra. Si el operador le
 * hace caso, borra el pedido que sí se va a entregar.
 *
 * Medido en Colombia 2: Alexánder Álvarez atehortua tenía `#88086322`
 * (CANCELADO, $113.386) y `#88087212` (PENDIENTE, $114.900) contra la venta
 * #1019. El bueno es el segundo.
 */

export interface CandidatoDropi {
  /** Últimos 9 dígitos del teléfono. */
  tel: string;
  /** `created_at` en milisegundos. */
  t: number;
  /** Estado en Dropi, tal cual viene. */
  estado: string;
}

/** Un pedido cancelado no cubre una venta si hay otro vivo del mismo cliente. */
export function estaCancelado(estado: string): boolean {
  return String(estado ?? "").toUpperCase().trim().startsWith("CANCELAD");
}

/**
 * Devuelve el índice del pedido de Dropi que mejor cubre esa venta, o -1.
 *
 * Ventana: desde 1 día ANTES de la venta hasta 45 días DESPUÉS (al subir
 * pedidos viejos en bloque, la orden de Dropi se crea hoy aunque la venta sea
 * de hace semanas).
 *
 * Prioridad, en este orden:
 *  1. que NO esté cancelado;
 *  2. entre iguales, el de fecha más cercana a la venta.
 *
 * No muta nada: quien llama decide marcarlo como usado.
 */
export function elegirPedidoDropi(
  candidatos: readonly CandidatoDropi[],
  tel: string,
  ventaT: number,
  usados: ReadonlySet<number>,
): number {
  if (!tel) return -1;
  const desde = ventaT - 1 * 86400000;
  const hasta = ventaT + 45 * 86400000;

  let mejor = -1;
  let mejorVivo = false;
  let mejorDist = Infinity;

  for (let i = 0; i < candidatos.length; i++) {
    if (usados.has(i)) continue;
    const d = candidatos[i];
    if (d.tel !== tel || d.t < desde || d.t > hasta) continue;

    const vivo = !estaCancelado(d.estado);
    const dist = Math.abs(d.t - ventaT);
    const gana =
      mejor === -1 ||
      (vivo && !mejorVivo) ||
      (vivo === mejorVivo && dist < mejorDist);

    if (gana) { mejor = i; mejorVivo = vivo; mejorDist = dist; }
  }
  return mejor;
}
