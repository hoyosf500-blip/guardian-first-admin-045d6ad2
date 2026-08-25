import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * La tabla `profiles` se consulta por `user_id` y su nombre es `display_name`.
 *
 * ── Por qué existe esta prueba ─────────────────────────────────────────────
 * Medido en producción el 25-ago-2026: `importchat-send` pedía
 * `.select("full_name").eq("id", user.id)` y las DOS cosas estaban mal.
 * `full_name` no existe en esa tabla (Postgres contesta 42703) y la clave es
 * `user_id`, no `id`.
 *
 * Lo grave no fue el error: fue que **nadie se enteró**. El `?.` opcional se
 * tragó la fila nula y el código cayó al fallback silencioso —el CORREO
 * personal de quien escribía— así que cada WhatsApp mandado desde Guardian
 * habría quedado firmado en el panel de ImporChat como "estefano@gmail.com"
 * en vez de "Estefano Moreno". Justo lo contrario de para lo que existe ese
 * campo, y con el correo de la asesora guardado en el sistema de un tercero.
 *
 * Las edge functions son Deno: no las mira `tsc`, ni ESLint, ni los tipos
 * generados de Supabase. Un nombre de columna equivocado ahí adentro no
 * revienta el build — revienta callado, en producción, meses después.
 *
 * `resumen-diario` ya lo hacía bien (`select("user_id, display_name")`), así
 * que la forma correcta estaba a la vista en el mismo repo.
 */

const RAIZ = 'supabase/functions';

function archivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) out.push(...archivosTs(ruta));
    else if (nombre.endsWith('.ts')) out.push(ruta);
  }
  return out;
}

/** Quita comentarios para no acusar a un texto que EXPLICA el error. */
const sinComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');

describe('profiles: la columna del nombre es display_name, no full_name', () => {
  const archivos = archivosTs(RAIZ);

  it('encuentra las edge functions (si no, la prueba no está probando nada)', () => {
    expect(archivos.length).toBeGreaterThan(20);
  });

  it('ninguna edge function pide `full_name`', () => {
    const culpables = archivos.filter((f) => /full_name/.test(sinComentarios(readFileSync(f, 'utf-8'))));
    expect(culpables, `usan una columna que no existe: ${culpables.join(', ')}`).toEqual([]);
  });

  it('quien consulta `profiles` lo hace por user_id, no por id', () => {
    const culpables: string[] = [];
    for (const f of archivos) {
      const src = sinComentarios(readFileSync(f, 'utf-8'));
      if (!/from\(["']profiles["']\)/.test(src)) continue;
      // El fragmento desde `from("profiles")` hasta el final de la cadena.
      for (const m of src.matchAll(/from\(["']profiles["']\)[\s\S]{0,220}/g)) {
        const trozo = m[0];
        if (/\.eq\(\s*["']id["']/.test(trozo)) culpables.push(f);
      }
    }
    expect(culpables, `filtran profiles por "id": ${culpables.join(', ')}`).toEqual([]);
  });
});
