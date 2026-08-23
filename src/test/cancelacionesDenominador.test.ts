import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * GUARDIÁN — la tasa de cancelación no puede depender de que el troceo salga bien.
 *
 * `cancelaciones_analisis` se consulta POR TRAMOS de 5 días porque la función se
 * cae por timeout en el rango por defecto. Ese troceo trajo dos formas de
 * imprimir un porcentaje equivocado, las dos medidas el 23-ago-2026:
 *
 *   1. Un tramo SIN cancelaciones no devuelve filas, y `generados_periodo` viaja
 *      DENTRO de las filas. Sumando tramos, el denominador quedaba corto.
 *   2. Un tramo que se cae se anotaba en "días sin leer" pero NO marcaba el
 *      denominador: la tasa se seguía imprimiendo con los dos lados cortos y sin
 *      nada que dijera que no era la del rango pedido.
 *
 * La defensa es `cancelaciones_universo`: dos COUNT agregados por el rango
 * COMPLETO, sin subconsultas por pedido, que no necesita trocearse. El detalle
 * puede venir incompleto — y se avisa — pero el porcentaje de arriba es el del
 * rango que la persona pidió.
 *
 * Estas comprobaciones leen el archivo a propósito: el bug vive en el orden de
 * unas asignaciones dentro de un hook con red, que es justo lo que una prueba
 * de unidad no ejercita.
 */

const RAIZ = join(__dirname, '..', '..');
const HOOK = join(RAIZ, 'src', 'hooks', 'useCancelacionesAnalisis.ts');
const src = readFileSync(HOOK, 'utf-8');

/** Quita comentarios de línea sin confundir el `//` de una URL. */
function sinComentarios(texto: string): string {
  return texto
    .split('\n')
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

const codigo = sinComentarios(src);

describe('guardián: el denominador de la tasa de cancelación', () => {
  it('pide el universo del período en UNA consulta aparte', () => {
    expect(codigo).toContain('cancelaciones_universo');
  });

  it('un tramo que no se pudo leer marca el denominador como incompleto', () => {
    // Sin esto la tasa sale de un numerador y un denominador a los que les falta
    // el mismo tramo, y se imprime como si fuera la del rango completo.
    const i = codigo.indexOf('sinLeer.push');
    expect(i).toBeGreaterThan(-1);
    const despues = codigo.slice(i, i + 400);
    expect(despues).toContain('denominadorParcial = true');
  });

  it('el universo manda sobre la suma por tramos cuando está disponible', () => {
    expect(codigo).toMatch(/universo\s*\?\s*universo\.generados/);
    expect(codigo).toMatch(/universo\s*\?\s*universo\.cancelados/);
  });

  it('si el universo no está (migración sin aplicar) se cae a la suma por tramos', () => {
    // La RPC es ADITIVA: sin ella el reporte tiene que seguir funcionando.
    expect(codigo).toMatch(/denominadorParcial\s*\|\|\s*!crudas\.length/);
  });

  it('el aviso de truncado se mide POR TRAMO, no sobre el total sumado', () => {
    // `mapped.length >= ROW_CAP` comparaba la suma de TODOS los tramos contra el
    // tope de UNA consulta: ocho tramos de 700 filas, ninguno truncado, gritaban
    // "faltan datos" sin faltar ninguno.
    expect(codigo).not.toMatch(/setPartial\(\s*mapped\.length\s*>=\s*ROW_CAP/);
    expect(codigo).toContain('setPartial(truncadoAlgunTramo)');
    expect(codigo).toMatch(/filas\.length\s*>=\s*ROW_CAP/);
  });
});
