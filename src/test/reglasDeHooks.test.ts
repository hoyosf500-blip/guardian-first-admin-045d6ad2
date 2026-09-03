import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * ⛔ GUARDIÁN — ningún hook debajo de un early-return, en TODO `src/`.
 *
 * Un hook después de un `return` temprano tira React #300/#310 y **cae la
 * pantalla entera**: cada ruta va envuelta en su ErrorBoundary, así que la
 * asesora ve «Algo salió mal», no una versión degradada. El 25-ago-2026 le pasó
 * a una operadora de Colombia cuando su cola de trabajo llegó a cero.
 *
 * ── Por qué existe esto si YA había un chequeo ──────────────────────────────
 * `scripts/check-hooks.mjs` hace exactamente esta verificación y está declarado
 * como BLOQUEANTE en el CI. Y aun así, el 3-sep-2026 entró a `main` el commit
 * 622b70a con DOS hooks debajo del early-return de `CallView` — la misma
 * regresión de agosto, en el mismo archivo.
 *
 * La lección no es «hacía falta otro chequeo»: es que el chequeo estaba en un
 * lugar por el que se puede pasar de largo. `npm test` SÍ se corre antes de
 * cada entrega. Poner la verificación DONDE YA SE MIRA vale más que agregar un
 * candado nuevo en la misma puerta que nadie abre.
 *
 * ⛔ Se ejecuta el script REAL en vez de reimplementar el chequeo con la API de
 * ESLint: dos copias de la misma regla se desincronizan, y además la API de
 * ESLint no arranca dentro de vitest (`signal?.throwIfAborted is not a
 * function`). El script sigue siendo la única definición.
 */
describe('⛔ reglas de hooks en todo src/', () => {
  it('ningún hook queda debajo de un early-return', () => {
    const r = spawnSync(
      process.execPath,
      [join(process.cwd(), 'scripts', 'check-hooks.mjs')],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 180_000 },
    );
    const salida = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    expect(
      r.status,
      `Un hook después de un early-return tumba la pantalla entera (React #300/#310).\n${salida}`,
    ).toBe(0);
  }, 190_000);
});
