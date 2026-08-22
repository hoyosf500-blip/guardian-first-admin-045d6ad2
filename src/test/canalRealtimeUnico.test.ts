import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// PRUEBA GUARDIANA — nombres de canal de realtime.
//
// El 22-ago-2026 `/seguimiento` se cayó ENTERA en producción con
// «cannot add `postgres_changes` callbacks for realtime:seg-closed-<id> after
// `subscribe()`». Causa: `useSegTouchIndex` pasó a montarse en DOS componentes
// a la vez (SeguimientoTab y SiguienteAccionBar, que vive en el layout) y el
// nombre del canal era fijo — el segundo intentaba engancharle un callback a un
// canal que el primero ya había suscrito.
//
// La pantalla no degradó: cayó en su ErrorBoundary y la asesora vio "Algo salió
// mal". Por eso esto se vigila con una prueba y no con una convención.
//
// La regla: un hook cuyo canal se pueda montar más de una vez lleva un id POR
// INSTANCIA (`useId()`) en el nombre. Se mide por los call-sites reales, no por
// intención: si mañana alguien agrega el segundo consumidor, la prueba avisa
// ANTES de que aparezca la pantalla en blanco.

const HOOKS_DIR = path.join(process.cwd(), 'src/hooks');
const SRC_DIR = path.join(process.cwd(), 'src');

function archivos(dir: string, ext: string[], acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) archivos(p, ext, acc);
    else if (ext.some((x) => e.name.endsWith(x))) acc.push(p);
  }
  return acc;
}

/** Hooks que abren un canal de realtime, con el/los nombre(s) que usan. */
function hooksConCanal(): { nombre: string; ruta: string; canales: string[] }[] {
  return fs.readdirSync(HOOKS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => {
      const ruta = path.join(HOOKS_DIR, f);
      const src = fs.readFileSync(ruta, 'utf8');
      const canales = Array.from(src.matchAll(/\.channel\(([^)]*)\)/g)).map((m) => m[1]);
      return { nombre: f.replace(/\.ts$/, ''), ruta, canales };
    })
    .filter((h) => h.canales.length > 0);
}

/** Cuántos archivos (fuera del hook y de las pruebas) lo importan y lo LLAMAN. */
function callSites(nombre: string): string[] {
  const todos = archivos(SRC_DIR, ['.ts', '.tsx']);
  return todos.filter((p) => {
    if (p.includes(`hooks${path.sep}${nombre}.ts`)) return false;
    if (/\.test\.tsx?$/.test(p)) return false;
    const src = fs.readFileSync(p, 'utf8');
    // Importado Y llamado: `import type { X }` no monta nada.
    return src.includes(`hooks/${nombre}'`) && src.includes(`${nombre}(`);
  });
}

describe('un canal de realtime que se puede montar dos veces necesita id propio', () => {
  const hooks = hooksConCanal();

  it('hay hooks con canal para revisar (la prueba no se vació sola)', () => {
    expect(hooks.length).toBeGreaterThan(3);
  });

  for (const h of hooks) {
    it(`${h.nombre}`, () => {
      const sitios = callSites(h.nombre);
      if (sitios.length < 2) return; // un solo consumidor: nombre fijo está bien
      const src = fs.readFileSync(h.ruta, 'utf8');
      expect(src, `${h.nombre} lo montan ${sitios.length} componentes y no usa useId()`)
        .toMatch(/useId\(\)/);
      for (const canal of h.canales) {
        expect(canal, `${h.nombre}: el nombre del canal no lleva el id de instancia`)
          .toMatch(/instanciaId|instanceId/);
      }
    });
  }
});
