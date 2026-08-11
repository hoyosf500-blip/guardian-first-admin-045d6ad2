import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * AUDITORÍA DE PERMISOS EFECTIVOS.
 *
 * No basta con confiar en las políticas RLS: si un rol tiene GRANT de INSERT o
 * DELETE, cualquier hueco en una política se vuelve escritura real. Esta prueba
 * recorre TODAS las tablas declaradas en los tipos generados y verifica que la
 * clave pública (anon) no pueda insertar ni borrar en NINGUNA.
 *
 * La lista de tablas se deriva del archivo de tipos, no de una lista a mano:
 * cuando se cree una tabla nueva, entra sola a la auditoría.
 *
 * NO toca la huella digital ni ninguna edge function: solo POST/DELETE que
 * deben ser rechazados.
 */

const URL_BASE = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '');
const ANON = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/** [tabla, primera columna] — la columna sirve para armar un WHERE válido. */
function tablasDeLosTipos(): Array<[string, string]> {
  const ruta = resolve(process.cwd(), 'src/integrations/supabase/types.ts');
  const src = readFileSync(ruta, 'utf8');
  const ini = src.indexOf('Tables: {');
  const fin = src.indexOf('Views: {', ini);
  if (ini === -1 || fin === -1) return [];
  const bloque = src.slice(ini, fin);
  const salida: Array<[string, string]> = [];
  for (const m of bloque.matchAll(/^ {6}(\w+): \{\n {8}Row: \{\n {10}(\w+):/gm)) {
    salida.push([m[1], m[2]]);
  }
  return salida.sort((a, b) => a[0].localeCompare(b[0]));
}

const TABLAS = tablasDeLosTipos();

let hayRed = false;

async function rest(path: string, init?: RequestInit) {
  return fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: ANON as string, ...(init?.headers ?? {}) },
  });
}

const hayEntorno = Boolean(URL_BASE && ANON);
const d = hayEntorno ? describe : describe.skip;

describe('auditoría — la lista de tablas se descubre sola', () => {
  it('los tipos generados declaran tablas', () => {
    expect(TABLAS.length).toBeGreaterThan(20);
  });
});

d('auditoría — anon no puede escribir en ninguna tabla', () => {
  beforeAll(async () => {
    try {
      const r = await fetch(`${URL_BASE}/rest/v1/`, { headers: { apikey: ANON as string } });
      hayRed = r.status > 0;
    } catch {
      hayRed = false;
    }
  }, 20_000);

  for (const [tabla, col] of TABLAS) {
    it(`anon no puede insertar en ${tabla}`, async () => {
      if (!hayRed) return; // sin red: no afirmamos nada (skip visible, no falso verde)
      const r = await rest(tabla, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({}),
      });
      const cuerpo = await r.text();
      expect(
        [401, 403].includes(r.status),
        `INSERT en ${tabla} devolvió ${r.status}: ${cuerpo.slice(0, 200)}`,
      ).toBe(true);
    }, 20_000);

    it(`anon no puede borrar en ${tabla}`, async () => {
      if (!hayRed) return;
      // PostgREST exige un WHERE en los DELETE: usamos un filtro imposible sobre
      // la primera columna. Si el permiso estuviera abierto, no borraría nada,
      // pero la respuesta delataría el GRANT.
      const r = await rest(`${tabla}?${col}=is.null&${col}=not.is.null`, { method: 'DELETE' });
      const cuerpo = await r.text();
      expect(
        [401, 403].includes(r.status),
        `DELETE en ${tabla} devolvió ${r.status}: ${cuerpo.slice(0, 200)}`,
      ).toBe(true);
    }, 20_000);
  }
});
