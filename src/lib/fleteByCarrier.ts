// Flete promedio por transportadora, agregado CLIENT-SIDE desde orders.flete.
//
// Ningún RPC lo trae: logistics_by_carrier ni siquiera selecciona o.flete y
// logistics_cost_basis es global (una fila por tienda). El dueño pidió "ver el
// costo de envío promedio de cada transportadora" (23-ago-2026) y el camino
// client-side es el bendecido por la casa ("más resiliente que migrations
// pendientes", CLAUDE.md) — funciona con cualquier versión de las RPCs.
//
// ⚠️ orders.flete es el shipping_amount de Dropi (lo que paga el dropshipper),
// y es el flete VIGENTE del pedido: el cron lo pisa si cambia. Sirve para
// "cuánto me cuesta enviar con X hoy", no como histórico de tarifas.

export interface FleteOrderRow {
  transportadora: string | null;
  flete: number | null;
  estado: string | null;
}

export interface FleteCarrierAgg {
  /** Promedio de flete de los pedidos ENTREGADOS con flete > 0. null = sin muestra. */
  fleteProm: number | null;
  /** Cuántos entregados con flete respaldan el promedio (para no vender un n=1 como dato). */
  muestra: number;
  /** Flete QUEMADO en pedidos que volvieron (estados DEVOLUC*): plata pagada
   *  por envíos que no vendieron nada. Suma, no promedio — es la pérdida. */
  fleteDevol: number;
  /** Cuántas devoluciones con flete respaldan fleteDevol. */
  nDevol: number;
}

/** Normaliza estado para comparar: mayúsculas + guiones bajos a espacio. */
function normEstado(e: string | null | undefined): string {
  return (e ?? '').toUpperCase().replace(/_/g, ' ').trim();
}

// Soft-deletes que NO son operación real — mismos tres de DashboardTab y
// useDataLoader; meterlos al promedio contamina el flete con pedidos fantasma.
const FANTASMAS = new Set(['REEMPLAZADA', 'ARCHIVADO GHOST']);

// Entregado en CO ('ENTREGADO') y EC ('ENTREGADO A DESTINO'). El promedio va
// SOLO sobre entregados: un pendiente sin guía trae flete 0 y hunde el
// promedio — mismo criterio que logistics_cost_basis.
const ENTREGADOS = new Set(['ENTREGADO', 'ENTREGADO A DESTINO']);

/** Devolución en cualquiera de sus variantes CO/EC (DEVOLUCION, DEVOLUCION EN
 *  TRANSITO, DEVOLUCION A ORIGEN, EN PROCESO DE DEVOLUCION…) — mismo prefijo
 *  que usa el fallback de estadoBuckets ('DEVOLUC'). */
function esDevolucion(estado: string): boolean {
  return estado.includes('DEVOLUC');
}

/**
 * Agrega flete por transportadora. Pura y testeable.
 * - fleteProm/muestra: promedio SOLO sobre entregados (un pendiente con flete 0
 *   hundiría el promedio — mismo criterio que logistics_cost_basis).
 * - fleteDevol/nDevol: flete quemado en devoluciones (pedida del dueño: "la
 *   devolución también, en plata" — la fila ya se bajaba y se descartaba).
 * Excluye fantasmas, filas sin transportadora y fletes sin dato (null/0):
 * un flete 0 es "no cargado", no un envío gratis.
 */
export function agregarFletePorCarrier(rows: FleteOrderRow[]): Map<string, FleteCarrierAgg> {
  const acc = new Map<string, { suma: number; n: number; devol: number; nDevol: number }>();
  for (const r of rows) {
    const carrier = (r.transportadora ?? '').trim();
    if (!carrier) continue;
    const estado = normEstado(r.estado);
    if (FANTASMAS.has(estado)) continue;
    const flete = Number(r.flete);
    if (!isFinite(flete) || flete <= 0) continue;
    const entregado = ENTREGADOS.has(estado);
    const devuelto = !entregado && esDevolucion(estado);
    if (!entregado && !devuelto) continue;
    const cur = acc.get(carrier) ?? { suma: 0, n: 0, devol: 0, nDevol: 0 };
    if (entregado) {
      cur.suma += flete;
      cur.n += 1;
    } else {
      cur.devol += flete;
      cur.nDevol += 1;
    }
    acc.set(carrier, cur);
  }
  const out = new Map<string, FleteCarrierAgg>();
  for (const [carrier, { suma, n, devol, nDevol }] of acc) {
    out.set(carrier, {
      fleteProm: n > 0 ? suma / n : null,
      muestra: n,
      fleteDevol: devol,
      nDevol,
    });
  }
  return out;
}
