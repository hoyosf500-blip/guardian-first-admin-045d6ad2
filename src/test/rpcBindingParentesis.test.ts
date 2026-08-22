import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, sep } from 'path';

/**
 * Segunda mitad del guardián de `supabase.rpc` — la que entiende PARÉNTESIS.
 *
 * `rpcBinding.test.ts` compara línea por línea con un regex `= supabase.rpc`.
 * El 22-ago-2026 se escapó esto, escrito en varias líneas:
 *
 *     const rpc = (supabase.rpc as unknown as (
 *       fn: string, args: Record<string, unknown>,
 *     ) => Promise<{ data: X; error: unknown }>);
 *
 * El paréntesis se mete entre el `=` y `supabase.rpc`, así que el regex no
 * matchea, y el cast abarca varias líneas, así que mirar una sola no alcanza.
 * El guardián quedó en verde y la pestaña de Cancelaciones se quedó en "Falló
 * la consulta": adentro `this` era undefined y supabase-js tira "Cannot read
 * properties of undefined (reading 'rest')".
 *
 * Lo que separa lo seguro de lo peligroso NO es el cast: es si el resultado se
 * INVOCA ahí mismo.
 *
 *   (supabase.rpc as X)('fn', args)   ✅ se invoca → conserva el receptor
 *   const r = (supabase.rpc as X);    ❌ se guarda  → lo pierde
 */

const NEEDLE = 'supabase.rpc';

/** Reemplaza comentarios por espacios, conservando los saltos de línea (para
 *  que los números de línea del reporte sigan siendo los reales). */
function sinComentarios(src: string): string {
  const enBlanco = (m: string) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, enBlanco)
    .replace(/\/\/[^\n]*/g, enBlanco);
}

export function guardadoSinInvocar(src: string, archivo: string): string[] {
  const limpio = sinComentarios(src);
  const rotos: string[] = [];
  for (let i = limpio.indexOf(NEEDLE); i !== -1; i = limpio.indexOf(NEEDLE, i + 1)) {
    if (limpio.slice(i + NEEDLE.length).trimStart().startsWith('.bind')) continue;

    // ¿Viene envuelto en un paréntesis? Si no, no es esta forma.
    let j = i - 1;
    while (j >= 0 && /\s/.test(limpio[j])) j--;
    if (j < 0 || limpio[j] !== '(') continue;

    // El `)` que cierra ESE paréntesis.
    let prof = 0;
    let k = j;
    for (; k < limpio.length; k++) {
      if (limpio[k] === '(') prof++;
      else if (limpio[k] === ')') { prof--; if (prof === 0) break; }
    }
    if (k >= limpio.length) continue; // sin cerrar: no se afirma nada

    // Si lo que sigue es `(`, se está invocando → seguro.
    if (limpio.slice(k + 1).trimStart().startsWith('(')) continue;

    const linea = limpio.slice(0, i).split('\n').length;
    rotos.push(`${archivo.split(sep).join('/')}:${linea}`);
  }
  return rotos;
}

function archivos(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) archivos(p, out);
    else if ((e.endsWith('.ts') || e.endsWith('.tsx')) && !e.includes('.test.')) out.push(p);
  }
  return out;
}

describe('supabase.rpc entre paréntesis: o se invoca, o va bindeado', () => {
  const fuentes = archivos('src');

  it('encuentra archivos para revisar', () => {
    expect(fuentes.length).toBeGreaterThan(100);
  });

  it('ningún archivo guarda el cast sin invocarlo', () => {
    const rotos: string[] = [];
    for (const f of fuentes) rotos.push(...guardadoSinInvocar(readFileSync(f, 'utf8'), f));
    expect(rotos).toEqual([]);
  });

  it('distingue guardar de invocar', () => {
    const g = (s: string) => guardadoSinInvocar(s, 'x').length;

    // PELIGROSO: se guarda la referencia.
    expect(g('const rpc = (supabase.rpc as unknown as Fn);')).toBe(1);

    // …y también partido en líneas, que es como se escribe de verdad. Este es
    // exactamente el texto que se escapó del guardián viejo.
    expect(g([
      'const rpc = (supabase.rpc as unknown as (',
      '  fn: string, args: Record<string, unknown>,',
      ') => Promise<{ data: X | null; error: unknown }>);',
    ].join('\n'))).toBe(1);

    // SEGURO: se invoca ahí mismo.
    expect(g("await (supabase.rpc as unknown as Fn)('foo', args);")).toBe(0);
    expect(g([
      'const { data } = await (supabase.rpc as unknown as (',
      '  fn: string, args: Record<string, unknown>,',
      ') => Promise<X>)(',
      "  'foo', args,",
      ');',
    ].join('\n'))).toBe(0);

    // SEGURO: bindeado, se guarde como se guarde.
    expect(g('const rpc = (supabase.rpc.bind(supabase) as unknown as Fn);')).toBe(0);
    expect(g('const rpc = supabase.rpc.bind(supabase) as unknown as Fn;')).toBe(0);

    // SEGURO: la llamada directa de siempre.
    expect(g("await supabase.rpc('foo', args);")).toBe(0);

    // Un comentario que MENCIONA el patrón malo no es una infracción.
    expect(g('// ojo: const rpc = (supabase.rpc as Fn); pierde el this')).toBe(0);
  });
});
