import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * PRUEBA GUARDIANA — quién trabaja la cola se decide en UN solo archivo.
 *
 * ── Lo que esto impide que vuelva a pasar (28-ago-2026) ─────────────────────
 * Guardian tenía tres definiciones distintas de "el que trabaja" repartidas por
 * el árbol, y las tres discrepaban entre sí:
 *
 *   · `!isAdmin && !isOwnerOfActive`  → el supervisor trabaja  (correcta)
 *   · `!isAdmin && !isManagerOfActive` → el supervisor NO trabaja
 *   · ninguna reja                     → hasta el dueño reclamaba pedidos
 *
 * `isManagerOfActive` es «dueño O supervisor». Usarlo como reja de trabajadores
 * manda al supervisor —que en esta operación es quien más trabaja la cola— al
 * lado de los jefes: se le contaba el trabajo pero no se le daba ninguna de las
 * herramientas del que trabaja (aviso por huecos, botón «Estoy en otra cosa»).
 *
 * Y la que no tenía reja costaba plata de verdad: el dueño abría un pedido en
 * Confirmar para ver cómo iba la operación y `claim_order` se lo escondía a
 * TODAS las asesoras por 15 minutos.
 *
 * Las dos reglas de abajo son baratas de cumplir y caras de descubrir a mano.
 */

const SRC = join(process.cwd(), 'src');

/** Quita comentarios de línea y de bloque. El `(?<!:)` evita comerse el `//`
 *  de un `https://` — sin él, media línea de código desaparecía y las
 *  comprobaciones negativas pasaban en verde CON el código presente. Es la
 *  misma trampa documentada en `googleApagado.test.ts`. */
function sinComentarios(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(?<!:)\/\/.*$/gm, '');
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { tsFiles(p, out); continue; }
    if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('la reja de "quién trabaja la cola" vive en rolesTrabajo.ts', () => {
  it('nadie vuelve a escribir a mano la reja que dejaba al supervisor afuera', () => {
    // `isManagerOfActive` sigue siendo legítimo para GATEAR PANTALLAS (Admin,
    // Logística son manager-only). Lo que se prohíbe es usarlo para decidir
    // quién es trabajador — ese es el bug, y tiene esta forma exacta.
    const culpables = tsFiles(SRC)
      .filter((f) => !f.endsWith(join('lib', 'rolesTrabajo.ts')))
      .filter((f) => /!\s*isAdmin\s*&&\s*!\s*isManagerOfActive/.test(sinComentarios(readFileSync(f, 'utf8'))));

    expect(
      culpables.map((f) => f.replace(SRC, 'src')),
      'Usá trabajaLaCola() / seLeBloqueaLaPantalla() de @/lib/rolesTrabajo en vez de rearmar la reja',
    ).toEqual([]);
  });

  it('los cinco sitios que deciden quién trabaja importan la definición compartida', () => {
    // Cada uno de estos decide algo que le cambia el día a una persona: si le
    // ficha jornada, si le reclama un pedido, si le avisa, si le traba la
    // pantalla. Ninguno puede tener su propia opinión.
    const obligados = [
      join('hooks', 'useOperatorHeartbeat.ts'),
      join('hooks', 'useSegAssignment.ts'),
      join('hooks', 'useInactivityGuard.ts'),
      join('components', 'InactivityGuard.tsx'),
      join('components', 'CallView.tsx'),
    ];
    const sinImportar = obligados.filter(
      (rel) => !/from ['"]@\/lib\/rolesTrabajo['"]/.test(readFileSync(join(SRC, rel), 'utf8')),
    );
    expect(sinImportar, 'estos deciden quién trabaja y no usan rolesTrabajo').toEqual([]);
  });

  it('abrir un pedido en Confirmar no reclama nada si el que mira solo observa', () => {
    // El candado de `CallView` es invisible: un pedido reclamado no se dibuja
    // distinto, simplemente DESAPARECE de la cola de las demás. Por eso la
    // reja se fija por prueba y no por revisión a ojo.
    const src = sinComentarios(
      readFileSync(join(SRC, 'components', 'CallView.tsx'), 'utf8'),
    );
    expect(src).toMatch(/soloObserva\(\s*\{\s*isAdmin\s*,\s*isOwnerOfActive\s*\}\s*\)/);
    expect(src).toMatch(/if\s*\(\s*observa\s*\)\s*return;/);
    // Y al cerrar la pestaña solo se suelta el candado PROPIO: `release_order`
    // corriendo como admin puede soltar el de otra persona.
    expect(src).toMatch(/claimedByMeRef\.current === o\.dbId\) void releaseOrder/);
  });
});
