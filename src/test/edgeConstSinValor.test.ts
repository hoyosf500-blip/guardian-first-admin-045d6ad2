import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ⛔ GUARDIÁN — `const x: T;` sin valor NO ES JAVASCRIPT.
 *
 * Un `const` declarado sin inicializador es un error de sintaxis: el módulo no
 * compila y la edge function **ni siquiera arranca**. Desde afuera se ve como
 * un 500 o un boot fallido, no como un error de código.
 *
 * ── Por qué existe este archivo ────────────────────────────────────────────
 * Pasó de verdad. El commit `2e9d879` (30-ago-2026) cambió, en
 * `_shared/imporchatSocket.ts`:
 *
 *     -  let t: ReturnType<typeof setTimeout>;
 *     +  const t: ReturnType<typeof setTimeout>;
 *
 * Eso lo pide `prefer-const`, que cree que `t` nunca se reasigna porque la
 * asignación vive DENTRO de un closure. Y como el CI corre
 * `eslint supabase/functions` de forma **bloqueante**, la regla empuja
 * exactamente al cambio que rompe producción: para que el CI pase en verde hay
 * que escribir código que no bootea.
 *
 * `importchat-chat` e `importchat-send` quedaron sin poder arrancar **tres
 * días** y nadie se enteró:
 *   · `tsc --noEmit` NO mira `supabase/functions/` (solo `src/`),
 *   · `npm test` tampoco corre nada de esa carpeta,
 *   · y el lint pasaba en verde justamente porque el cambio lo pedía él.
 * Se descubrió el 2-sep-2026 al redesplegarlas por primera vez desde entonces:
 * el runtime de Deno rechazó el boot.
 *
 * Es el mismo hueco que ya documentó `edge_no_undef_lint_nunca_corria`, pero
 * un piso más abajo: ahí la regla no se ejecutaba; acá se ejecuta y empuja al
 * error. La única red que queda es esta.
 */

const RAIZ = join(process.cwd(), 'supabase', 'functions');

function archivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...archivosTs(p));
    else if (e.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Quita comentarios sin confundir el `//` de `https://`. */
const sinComentarios = (t: string) =>
  t.replace(/(?<!:)\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * `const nombre: Tipo;` — declaración con tipo y SIN `=`.
 *
 * No se persigue `const x;` a secas porque eso ni siquiera pasa el parser de
 * TypeScript; el caso real y peligroso es el que lleva anotación de tipo, que
 * al ojo parece legítimo y encima es lo que produce `eslint --fix`.
 */
const CONST_SIN_VALOR = /(?:^|[;{}\s])const\s+[A-Za-z_$][\w$]*\s*:\s*[^=;{}()]+;/;

describe('⛔ ninguna edge function declara un `const` sin valor', () => {
  const archivos = archivosTs(RAIZ);

  it('hay archivos que revisar (si no, el guardián estaría mirando el vacío)', () => {
    expect(archivos.length).toBeGreaterThan(20);
  });

  it('ningún `const x: T;` sin inicializador en supabase/functions', () => {
    const culpables: string[] = [];
    for (const f of archivos) {
      const src = sinComentarios(readFileSync(f, 'utf8'));
      for (const [i, linea] of src.split('\n').entries()) {
        // `declare const` en un bloque de tipos SÍ es válido y no bootea nada.
        if (/\bdeclare\s+const\b/.test(linea)) continue;
        if (CONST_SIN_VALOR.test(linea)) {
          culpables.push(`${f.slice(RAIZ.length + 1)}:${i + 1} → ${linea.trim()}`);
        }
      }
    }
    expect(
      culpables,
      'Un `const` sin inicializador NO compila: esa función no va a arrancar. '
      + 'Casi siempre lo produce `eslint --fix` con `prefer-const` sobre una '
      + 'variable que se asigna dentro de un closure. La salida es dejar `let` '
      + 'con `// eslint-disable-next-line prefer-const` y el motivo escrito.',
    ).toEqual([]);
  });

  it('la excepción de `imporchatSocket` sigue documentada y silenciada', () => {
    // Si alguien saca el `eslint-disable`, el CI (que es bloqueante) vuelve a
    // exigir el `const` que rompe el boot. La defensa es que la línea siga ahí.
    const src = readFileSync(join(RAIZ, '_shared', 'imporchatSocket.ts'), 'utf8');
    expect(/let t: ReturnType<typeof setTimeout>;/.test(src)).toBe(true);
    expect(
      /eslint-disable-next-line prefer-const/.test(src),
      'sin el disable, el lint bloqueante empuja de nuevo al cambio que no bootea',
    ).toBe(true);
  });
});
