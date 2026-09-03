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
      // Marca "en atención" (3-sep-2026): reclama el pedido con la MISMA
      // `claim_order` de Confirmar, así que hereda el mismo riesgo — si el dueño
      // reclamara al mirar, le escondería el cliente al equipo 15 minutos.
      join('hooks', 'useAtencionPedido.ts'),
      // La bitacora (3-sep-2026): sin la reja, el dueno mirando pedidos quedaba
      // registrado como alguien que los ABRE Y PASA DE LARGO sin gestionar — y
      // ese numero se compara despues contra el trabajo real del equipo.
      join('hooks', 'useBitacoraPedido.ts'),
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

/**
 * ⛔ NADIE RECLAMA UN PEDIDO SIN PASAR POR LA REJA.
 *
 * `claim_order` esconde el pedido de la cola de llamadas de TODO el equipo por
 * 15 minutos. Ya pasó una vez: el dueño abría una ficha en Confirmar para ver
 * cómo iba la operación y le quitaba el cliente a sus asesoras. Desde el
 * 3-sep-2026 hay una segunda puerta —la marca de "en atención" de Seguimiento,
 * Novedades y la bandeja— y tiene que cumplir la misma regla.
 *
 * Por eso la lista de quién puede tomar el candado es CERRADA: agregar un
 * tercer lugar obliga a pasar por acá y a mirar la reja.
 */
describe('el candado de "en atención" solo lo pone quien trabaja', () => {
  it('solo dos archivos usan useOrderLock, y los dos tienen la reja', () => {
    const usan = tsFiles(SRC)
      // El archivo que DEFINE el hook no cuenta como usuario.
      .filter((f) => !f.endsWith(join('hooks', 'useOrderLock.ts')))
      .filter((f) => /useOrderLock\s*\(/.test(sinComentarios(readFileSync(f, 'utf8'))));

    expect(usan.map((f) => f.replace(SRC, 'src')).sort()).toEqual([
      join('src', 'components', 'CallView.tsx'),
      join('src', 'hooks', 'useAtencionPedido.ts'),
    ].sort());

    for (const abs of usan) {
      const src = sinComentarios(readFileSync(abs, 'utf8'));
      expect(
        /soloObserva\s*\(/.test(src),
        `${abs.replace(SRC, 'src')} reclama pedidos sin preguntar si el que mira solo observa`,
      ).toBe(true);
    }
  });

  it('la marca se SUELTA cuando la pantalla se cierra', () => {
    // Sin el release, un pedido queda escondido de la cola de llamadas hasta que
    // vence el TTL de 15 min. Con la asesora saltando de chat en chat, eso deja
    // la cola de Confirmar vaciándose sola.
    const src = sinComentarios(readFileSync(join(SRC, 'hooks', 'useAtencionPedido.ts'), 'utf8'));
    expect(/releaseOrder\(/.test(src)).toBe(true);
    // Y solo el candado PROPIO: `release_order` como admin puede soltar el ajeno.
    expect(/mioRef\.current === dbId/.test(src)).toBe(true);
  });
});
