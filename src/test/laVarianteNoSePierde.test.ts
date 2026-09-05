import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * GUARDIÁN: la variante (talla/color) no se pierde entre COTIZAR y APLICAR, y un
 * producto variable sin variante no se reporta como "sin stock".
 *
 * ── Lo que pasó (5-sep-2026) ───────────────────────────────────────────────
 * Las operadoras: «no está dejando cambiar de transportadora». En pantalla, al
 * tocar «Actualizar Orden» sobre el shampoo Dexe 147152 (variante OSCURO):
 * *"El producto Dropi 147152 no tiene stock en bodega (sin ciudad de origen)"*.
 *
 * Leído en el código: la COTIZACIÓN (`mode: "quote"`) lee las líneas del pedido
 * con el GET de integraciones, que trae `variation_id`; los tres modos que
 * APLICAN (`resolveClientAndLines`) leen el detalle V2 primero y solo caen a la
 * integración si el V2 no trae productos. Si el V2 no nombra la variante como
 * esperamos, la línea llega sin `variationId`; y la bodega de un producto
 * VARIABLE pedida con el id del PRODUCTO devuelve `data: []` (probado el 4-sep
 * con este shampoo), que el código leía como "sin stock" — con el stock puesto.
 *
 * Lo que este guardián exige:
 *  1. Las lecturas se COMPLETAN entre sí (`completarVariantes`) antes de cotizar
 *     o aplicar, y cada parser conserva la etiqueta de la variante.
 *  2. Con la etiqueta, la cotización resuelve la variante contra el catálogo.
 *  3. Un producto variable sin variante NO se reporta como "sin stock".
 *  4. Las dos edges que cotizan subieron su marca de versión.
 */

const RAIZ = join(__dirname, '..', '..');
const leer = (rel: string) => readFileSync(join(RAIZ, rel), 'utf8');
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}
/** Del `desde` hasta el `)` que cierra el primer `(` que aparece, con anidamiento. */
function llamadaBalanceada(texto: string, desde: number): string {
  const abre = texto.indexOf('(', desde);
  let nivel = 0;
  for (let i = abre; i < texto.length; i++) {
    const c = texto[i];
    if (c === '(' || c === '[' || c === '{') nivel++;
    else if (c === ')' || c === ']' || c === '}') {
      nivel--;
      if (nivel === 0) return texto.slice(desde, i + 1);
    }
  }
  return texto.slice(desde);
}

const carrier = sinComentarios(leer('supabase/functions/dropi-change-carrier/index.ts'));
const quote = sinComentarios(leer('supabase/functions/_shared/dropiWebQuote.ts'));

describe('las dos lecturas del pedido se completan entre sí', () => {
  it('resolveClientAndLines completa las líneas del V2 con la integración cuando falta la variante', () => {
    const i = carrier.indexOf('async function resolveClientAndLines(');
    expect(i).toBeGreaterThan(-1);
    const fn = carrier.slice(i, carrier.indexOf('\n}\n', i));
    expect(fn).toMatch(/faltaAlgunaVariante\(lines\)/);
    expect(fn).toMatch(/completarVariantes\(lines,\s*parseOrderLines\(/);
  });

  it('la cotización también completa la lectura de integración con el V2', () => {
    const i = carrier.indexOf('if (mode === "quote") {');
    expect(i).toBeGreaterThan(-1);
    const bloque = carrier.slice(i, i + 3500);
    expect(bloque).toMatch(/completarVariantes\(realLines,\s*parseV2Lines\(/);
  });

  it('los dos parsers conservan la etiqueta de la variante', () => {
    for (const nombre of ['parseOrderLines', 'parseV2Lines']) {
      const i = carrier.indexOf(`function ${nombre}(`);
      expect(i, nombre).toBeGreaterThan(-1);
      const fn = carrier.slice(i, carrier.indexOf('\n}\n', i));
      expect(fn, `${nombre} no guarda la etiqueta`).toMatch(/variante\s*=\s*etiquetaVariante\(/);
      expect(fn, `${nombre} no la pone en la línea`).toMatch(/\{\s*variante\s*\}/);
    }
    // El V2 nombra la variante `variacion` (número), leído en vivo el 5-sep-2026
    // sobre el pedido 6866089: `{ type_variacion: "BM176", variacion: 56322 }`.
    // Sin esta clave, los pedidos de bot (invisibles en la integración) pierden
    // la variante y la bodega se pide con el id del producto.
    const v2 = carrier.slice(carrier.indexOf('function parseV2Lines('), carrier.indexOf('\n}\n', carrier.indexOf('function parseV2Lines(')));
    expect(v2).toMatch(/p\.variacion/);
    expect(v2).toMatch(/p\.product_variation_id/);
    expect(v2).toMatch(/p\.attribute_value/);
  });
});

describe('la cotización resuelve la variante por etiqueta y no miente sobre el stock', () => {
  it('quoteCarriers le pasa la etiqueta a fetchWebProductInfo', () => {
    const i = quote.indexOf('export async function quoteCarriers(');
    const fn = quote.slice(i);
    const llamada = llamadaBalanceada(fn, fn.indexOf('fetchWebProductInfo('));
    expect(llamada).toMatch(/l\.variante/);
  });

  it('fetchWebProductInfo resuelve por etiqueta y, si hay una sola variante, la toma', () => {
    const i = quote.indexOf('export async function fetchWebProductInfo(');
    const fn = quote.slice(i, quote.indexOf('\n}\n', i));
    expect(fn).toMatch(/variacionPorEtiqueta\(/);
    expect(fn).toMatch(/unicaVariacion\(/);
  });

  it('getOriginCity: un variable sin variante NO se reporta como "sin stock"', () => {
    const i = quote.indexOf('export async function getOriginCity(');
    const fn = quote.slice(i, quote.indexOf('\n}\n', i));
    // El mensaje de stock ahora dice con qué variante se preguntó…
    expect(fn).toMatch(/no tiene stock en bodega/);
    expect(fn).toMatch(/variante \$\{/);
    // …y el caso "variable sin variante" tiene su propio mensaje, que la
    // clasificación de causas (`causaFalla`) reconoce como variable_sin_variacion.
    expect(fn).toMatch(/es variable, por lo tanto debe indicar una variaci/);
  });
});

describe('las marcas de versión subieron', () => {
  it('dropi-change-carrier y shopify-push-dropi', () => {
    expect(carrier).toMatch(/const VERSION = "dropi-change-carrier 2026-09-05\.\d+ /);
    const push = sinComentarios(leer('supabase/functions/shopify-push-dropi/index.ts'));
    expect(push).toMatch(/const VERSION = "shopify-push-dropi 2026-09-05\.\d+ /);
  });
});
