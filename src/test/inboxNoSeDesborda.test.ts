import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * ⛔ LA BANDEJA NO PUEDE EMPUJAR EL ANCHO DE LA APP.
 *
 * Visto en producción el 3-sep-2026, la primera vez que `/inbox` se armó como
 * panel de dos columnas: la pantalla se desbordó a lo ancho. La barra lateral
 * quedaba cortada, el encabezado también, las burbujas del chat se estiraban
 * más de 1.700 px y había que scrollear DE LADO para volver al menú.
 *
 * La causa es una sola línea de CSS, y es la trampa clásica de CSS Grid: una
 * columna vale por defecto `min-width: auto`, o sea **"no me achico por debajo
 * de mi contenido"**. La conversación de un cliente no tiene ancho máximo
 * natural —una dirección larga, un enlace, una burbuja— así que la columna
 * crece, empuja al grid, y el grid empuja al documento. `truncate` y
 * `overflow-hidden` de los hijos NO alcanzan: el que decide es el track.
 *
 * Las dos defensas, que es lo que vigila este archivo:
 *  1. cada pista del grid va envuelta en `minmax(0, …)`;
 *  2. el contenedor de la página lleva `overflow-x-hidden`, para que si alguna
 *     vez se cuela otro hijo que no se deja achicar, esta pantalla RECORTE en
 *     vez de romper el ancho de toda la app.
 *
 * Es una prueba guardiana: si se pone roja, el problema es el cambio, no la
 * prueba.
 */
const RUTA = 'src/pages/InboxPage.tsx';
const fuente = readFileSync(resolve(process.cwd(), RUTA), 'utf8');

/** Las pistas de un `grid-cols-[a_b_c]`, separadas por `_` de nivel superior
 *  (los `_` que van dentro de un paréntesis pertenecen a la pista). */
function pistas(cuerpo: string): string[] {
  const out: string[] = [];
  let nivel = 0;
  let actual = '';
  for (const ch of cuerpo) {
    if (ch === '(') nivel++;
    if (ch === ')') nivel--;
    if (ch === '_' && nivel === 0) { out.push(actual); actual = ''; continue; }
    actual += ch;
  }
  if (actual) out.push(actual);
  return out;
}

describe('la bandeja no puede desbordar el ancho de la app', () => {
  it('cada columna del grid se puede achicar (`minmax(0, …)`)', () => {
    const grids = [...fuente.matchAll(/grid-cols-\[([^\]]+)\]/g)].map((m) => m[1]);
    expect(grids.length, 'la bandeja ancha se arma con un grid explícito').toBeGreaterThan(0);
    for (const g of grids) {
      for (const pista of pistas(g)) {
        expect(
          pista.startsWith('minmax(0,'),
          `la pista «${pista}» de «grid-cols-[${g}]» no arranca en minmax(0,…): ` +
          'con el ancho automático, una conversación larga empuja la columna y la ' +
          'columna empuja la página entera',
        ).toBe(true);
      }
    }
  });

  it('la página recorta a lo ancho en vez de empujar', () => {
    expect(
      /overflow-x-hidden/.test(fuente),
      'el contenedor de /inbox necesita `overflow-x-hidden` como red de seguridad',
    ).toBe(true);
  });
});
