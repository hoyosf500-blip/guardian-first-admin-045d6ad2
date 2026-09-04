import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * ⛔ GUARDIÁN — ningún comentario del código puede terminar impreso en pantalla.
 *
 * Visto EN PRODUCCIÓN el 4-sep-2026, en /confirmar, debajo del botón «Quitar
 * del CRM» y arriba del banner rojo de «no llegó a Dropi»:
 *
 *   /* Barra lateral de color + chip con halo: la fórmula de banner del DS.
 *      Antes el bloque se distinguía solo por el fondo rojo claro… *\/
 *
 * La causa es una regla de JSX que se olvida fácil: **un bloque `/​* … *​/` que
 * es hijo directo de un elemento o de un fragmento NO es un comentario, es
 * texto.** Para que sea comentario tiene que ir envuelto en llaves,
 * `{/​* … *​/}`. En `DropiSyncFailuresPanel.tsx` el bloque estaba justo después
 * de `{avisoLectura}` dentro de un `<>…</>`, así que React lo renderizó como un
 * párrafo más — y solo se veía cuando había fallos de sincronización, o sea
 * exactamente cuando la asesora estaba mirando ese panel.
 *
 * Ni el typecheck ni el lint ni las 238 pruebas lo detectaron: para el
 * compilador es una cadena de texto perfectamente válida. Por eso hace falta
 * este guardián.
 *
 * La memoria del rediseño ya tenía anotada la trampa hermana («un `{/​* *​/}`
 * justo después de `cond ? (` rompe el JSX»). Esta es la otra mitad.
 *
 * ── Cómo detecta ──────────────────────────────────────────────────────────
 * Un bloque `/​* … *​/` es sospechoso cuando está en posición de HIJO de JSX:
 * la línea anterior no vacía cierra una expresión o una etiqueta (`}` o `>`), y
 * lo que sigue al bloque abre otra etiqueta (`<algo`). Un comentario legítimo
 * antes de un `return`, dentro de una función o encima de una constante no
 * cumple esas dos condiciones a la vez.
 *
 * Si esta prueba se pone roja: el problema es el comentario, no la prueba.
 * Ponele llaves o movelo arriba del `return`.
 */

const SRC = join(process.cwd(), 'src');

function tsxDe(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsxDe(p));
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** La línea anterior no vacía. */
function anterior(lineas: string[], i: number): string {
  let j = i - 1;
  while (j >= 0 && lineas[j].trim() === '') j--;
  return j >= 0 ? lineas[j].trim() : '';
}

interface Sospecha {
  archivo: string;
  linea: number;
  texto: string;
}

function comentariosImpresos(ruta: string): Sospecha[] {
  const lineas = readFileSync(ruta, 'utf8').split(/\r?\n/);
  const out: Sospecha[] = [];
  for (let i = 0; i < lineas.length; i++) {
    const t = lineas[i].trim();
    if (!t.startsWith('/*')) continue;
    // Fin del bloque (puede abrir y cerrar en la misma línea).
    let fin = i;
    while (fin < lineas.length && !lineas[fin].includes('*/')) fin++;
    // Lo que sigue después del bloque.
    let j = fin + 1;
    while (j < lineas.length && lineas[j].trim() === '') j++;
    const siguiente = j < lineas.length ? lineas[j].trim() : '';

    const prev = anterior(lineas, i);
    const esHijoDeJsx = /[}>]$/.test(prev) || prev.endsWith('/>') || prev === '<>';
    const abreEtiqueta = siguiente.startsWith('<') && !siguiente.startsWith('</');
    if (esHijoDeJsx && abreEtiqueta) {
      out.push({ archivo: relative(process.cwd(), ruta), linea: i + 1, texto: t.slice(0, 80) });
    }
    i = fin;
  }
  return out;
}

describe('⛔ ningún comentario se imprime en pantalla', () => {
  it('no hay bloques /* */ sueltos como hijos de JSX en todo src/', () => {
    const sospechas = tsxDe(SRC).flatMap(comentariosImpresos);
    const detalle = sospechas
      .map((s) => `  ${s.archivo}:${s.linea}  →  ${s.texto}`)
      .join('\n');
    expect(
      sospechas,
      sospechas.length
        ? 'Estos comentarios se están DIBUJANDO como texto en la pantalla. '
          + 'Un /* … */ hijo de JSX no es un comentario: envolvelo en llaves '
          + `{/* … */} o movelo arriba del return.\n${detalle}`
        : '',
    ).toEqual([]);
  });

  it('el detector reconoce el caso real que se vio en producción', () => {
    // El mismo molde que tenía DropiSyncFailuresPanel: dentro de un fragmento,
    // después de una expresión y antes de una etiqueta.
    const lineas = [
      '  return (',
      '    <>',
      '    {avisoLectura}',
      '    /* Barra lateral de color + chip con halo. */',
      '    <div className="banner">',
      '    </div>',
      '    </>',
      '  );',
    ];
    // Se reutiliza la misma lógica sobre líneas en memoria.
    const prev = anterior(lineas, 3);
    expect(prev).toBe('{avisoLectura}');
    expect(/[}>]$/.test(prev)).toBe(true);
    expect(lineas[4].trim().startsWith('<')).toBe(true);
  });
});
