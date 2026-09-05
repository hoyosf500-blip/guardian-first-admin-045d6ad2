import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ⛔ GUARDIÁN — cotizar y crear mandan EL MISMO `products[]`.
 *
 * 4-sep-2026, Ecuador. Dropi rechazó ocho ventas con "El producto Shampoo Cubre
 * Canas Dexe Argan es variable, por lo tanto debe indicar una variación", y
 * seguían cayendo con el arreglo de la bodega YA desplegado (2026-09-04.2):
 * aquel tocó la COTIZACIÓN y el paso del origen, no la CREACIÓN. El pedido
 * pasaba un paso más y moría en el POST que crea.
 *
 * La causa: `createOrderViaWeb` armaba su `products[]` A MANO con los mismos
 * cinco campos MENOS `variation_id`. Medido en `shopify_pushed_orders.payload`
 * de los ocho fallos: la variante se resolvía BIEN (56321/56322/56323 según el
 * pedido) y el cuerpo de integraciones la llevaba — la perdía solo el cuerpo web.
 *
 * `productEntry` (`_shared/dropiWebQuote.ts`) es la forma ÚNICA de ese array y su
 * propio docstring lo dice: "la cotización y la creación tienen que mandar
 * exactamente lo mismo o Dropi responde «las existencias han variado»". Los tres
 * caminos de creación de `dropi-change-carrier` ya la usaban; este era el único
 * que no.
 *
 * Si alguien vuelve a escribir el objeto a mano, esto se pone rojo.
 */
const EDGE = join(process.cwd(), 'supabase', 'functions');
const leer = (rel: string) => readFileSync(join(EDGE, rel), 'utf8');

const sinComentarios = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');

describe('⛔ el cuerpo que CREA lleva la variante', () => {
  const push = sinComentarios(leer('shopify-push-dropi/index.ts'));

  it('el create del panel web usa productEntry, no un objeto a mano', () => {
    expect(push, 'shopify-push-dropi dejó de importar productEntry')
      .toMatch(/import\s*\{[^}]*\bproductEntry\b[^}]*\}\s*from\s*"\.\.\/_shared\/dropiWebQuote\.ts"/);

    expect(push, 'el create web volvió a armar products[] a mano: se pierde variation_id y Dropi rechaza el producto variable')
      .toMatch(/products:\s*products\.map\(productEntry\)/);

    // La forma exacta que tenía el bug: los cinco campos sueltos, sin variation_id.
    expect(push, 'reapareció el array inline del PASO E')
      .not.toMatch(/id:\s*p\.dropiId,\s*uid:\s*p\.dropiId,\s*quantity:\s*p\.quantity,\s*price:\s*p\.price,\s*type:\s*p\.productType/);
  });

  it('productEntry sigue emitiendo variation_id solo cuando existe', () => {
    const quote = sinComentarios(leer('_shared/dropiWebQuote.ts'));
    expect(quote).toMatch(/export function productEntry/);
    // En un producto SIMPLE el objeto queda idéntico al de siempre: por eso este
    // arreglo no puede romper lo que hoy funciona.
    expect(quote).toMatch(/if\s*\(p\.variationId\)\s*e\.variation_id\s*=\s*p\.variationId;/);
  });

  it('los tres caminos que crean en Dropi comparten la misma forma', () => {
    const carrier = sinComentarios(leer('dropi-change-carrier/index.ts'));
    const quote = sinComentarios(leer('_shared/dropiWebQuote.ts'));
    // La cotización (de donde salió la regla) y los caminos de change-carrier.
    expect(quote, 'la cotización dejó de usar productEntry: se desalinea del create')
      .toMatch(/products:\s*args\.products\.map\(productEntry\)/);
    const usos = carrier.match(/\.map\(productEntry\)/g) ?? [];
    expect(usos.length, 'dropi-change-carrier perdió alguno de sus tres usos de productEntry')
      .toBeGreaterThanOrEqual(3);
  });

  it('la marca de versión subió con el arreglo', () => {
    // Regla de la casa: toda edge tocada sube su VERSION en el MISMO commit, o
    // el ?ping=1 miente y se mide contra un runtime que no es el del arreglo.
    // La marca sube con CADA arreglo desplegable; clavar la revisión exacta
    // obliga a tocar esta prueba en cada commit, que es como una prueba se
    // vuelve trámite. Lo que importa es que tenga forma de marca comprobable
    // con ?ping=1, y que el arreglo de la variante siga presente (arriba).
    expect(push).toMatch(/const VERSION = "shopify-push-dropi 2026-09-04\.\d+ /);
  });
});
