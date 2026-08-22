/**
 * Partir un rango de fechas en tramos.
 *
 * Nació de un fallo medido en producción (22-ago-2026): la RPC
 * `cancelaciones_analisis` calcula subconsultas POR PEDIDO cancelado y su costo
 * crece más rápido que el rango — 1 día 0,7 s · 3 días 2,0 s · 7 días 4,5 s ·
 * 22 días **timeout** (57014). El mes actual es el rango por defecto de la
 * pantalla, así que la pestaña entera decía "Falló la consulta".
 *
 * Bajar el `LIMIT` no ayuda: el trabajo caro pasa ANTES de recortar.
 *
 * Se arregla del lado del cliente y no reescribiendo la función (⛔ REGLA #1),
 * que además funciona con cualquier versión desplegada. Es el mismo criterio que
 * el troceo en ≤89 días de `dropi-sync`.
 */

const DIA_MS = 86400000;

/** `YYYY-MM-DD` → Date en UTC (sin que la zona del navegador corra el día). */
function aFecha(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

function aIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Tramos CONTIGUOS y DISJUNTOS que cubren `[desde, hasta]` completo, con los dos
 * extremos incluidos.
 *
 * Disjuntos importa: los totales del período vienen por tramo y se suman. Si dos
 * tramos compartieran un día, ese día se contaría dos veces y la tasa de
 * cancelación saldría inflada — un error silencioso y creíble, de los peores.
 */
export function partirRango(desde: string, hasta: string, diasPorTramo: number): [string, string][] {
  if (!desde || !hasta) return [];
  const ini = aFecha(desde);
  const fin = aFecha(hasta);
  if (isNaN(ini.getTime()) || isNaN(fin.getTime()) || fin < ini) return [];
  const paso = Math.max(1, Math.floor(diasPorTramo));

  const tramos: [string, string][] = [];
  let cursor = ini;
  while (cursor <= fin) {
    // −1 día porque los dos extremos son inclusivos: un tramo de 7 días va del
    // día 0 al día 6, y el siguiente arranca en el 7.
    const tope = new Date(cursor.getTime() + (paso - 1) * DIA_MS);
    const cierre = tope > fin ? fin : tope;
    tramos.push([aIso(cursor), aIso(cierre)]);
    cursor = new Date(cierre.getTime() + DIA_MS);
  }
  return tramos;
}

/** Parte un tramo por la mitad. `null` si ya es de un solo día (no se puede más). */
export function partirALaMitad(desde: string, hasta: string): [[string, string], [string, string]] | null {
  const ini = aFecha(desde);
  const fin = aFecha(hasta);
  if (isNaN(ini.getTime()) || isNaN(fin.getTime()) || fin <= ini) return null;
  const dias = Math.round((fin.getTime() - ini.getTime()) / DIA_MS) + 1;
  const mitad = Math.floor(dias / 2);
  const corte = new Date(ini.getTime() + (mitad - 1) * DIA_MS);
  return [
    [aIso(ini), aIso(corte)],
    [aIso(new Date(corte.getTime() + DIA_MS)), aIso(fin)],
  ];
}
