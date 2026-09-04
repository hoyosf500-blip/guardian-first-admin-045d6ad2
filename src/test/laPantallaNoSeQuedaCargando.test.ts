import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ⛔ GUARDIÁN — "Cargando..." SIEMPRE tiene salida.
 *
 * 4-sep-2026, reportado por el dueño con el equipo parado: *"el panel se cayó,
 * se queda cargando y las operadoras no pueden trabajar"*.
 *
 * `ProtectedLayout` muestra esa pantalla mientras `loading || store.loading`, y
 * había DOS caminos por los que esas banderas se quedaban en `true` para siempre:
 *
 *   1. `AuthContext`: `supabase.auth.getSession().then(...)` **sin `.catch`**.
 *      Si la promesa RECHAZA (blip de red, o el servicio de auth lento — se midió
 *      en 2,9 s ese día contra 266 ms de la base), el `.then` no corre nunca. Y si
 *      `onAuthStateChange` tampoco dispara porque el refresco del token falló,
 *      nadie apaga `loading`.
 *   2. `StoreContext`: `void refresh()` se traga cualquier excepción. Los errores
 *      DEVUELTOS estaban bien tratados; los LANZADOS dejaban `store.loading` en
 *      `true` porque el `setLoading(false)` del final nunca se alcanzaba.
 *
 * Y un tercer caso que ningún `.catch` cubre: una promesa que no rechaza NI
 * resuelve (una petición que nunca vuelve). Para eso está el perro guardián.
 *
 * La regla: la operadora nunca puede quedarse mirando un spinner sin salida.
 * Mandarla a /auth es peor que entrar, pero es una pantalla donde SE PUEDE HACER
 * algo. Un spinner infinito no lo es.
 */
const SRC = join(process.cwd(), 'src');
const auth = readFileSync(join(SRC, 'contexts', 'AuthContext.tsx'), 'utf8');
const store = readFileSync(join(SRC, 'contexts', 'StoreContext.tsx'), 'utf8');

describe('⛔ la pantalla no se queda cargando para siempre', () => {
  it('AuthContext: getSession tiene .catch que suelta el loading', () => {
    const i = auth.indexOf('supabase.auth.getSession()');
    expect(i, 'no encontré getSession').toBeGreaterThan(-1);
    const bloque = auth.slice(i, i + 1800);
    expect(bloque, 'volvió el getSession sin .catch: una promesa rechazada deja "Cargando..." eterno')
      .toMatch(/\.catch\(/);
    // Y el catch tiene que APAGAR el loading, no solo loguear.
    const iCatch = bloque.indexOf('.catch(');
    expect(bloque.slice(iCatch, iCatch + 400), 'el catch no suelta la pantalla')
      .toMatch(/setLoading\(false\)/);
  });

  it('AuthContext: hay un perro guardián para la promesa que nunca vuelve', () => {
    // Ningún .catch cubre una promesa colgada (ni resuelve ni rechaza). Sin
    // esto, una petición que nunca vuelve deja la app en el spinner sin límite.
    expect(auth, 'se fue el perro guardián del arranque').toMatch(/perroGuardian/);
    const i = auth.indexOf('perroGuardian');
    expect(auth.slice(i, i + 500)).toMatch(/setTimeout/);
    expect(auth.slice(i, i + 500)).toMatch(/setLoading/);
    // Y se limpia al desmontar, o queda un timer suelto por cada montaje.
    expect(auth).toMatch(/clearTimeout\(perroGuardian\)/);
  });

  it('StoreContext: el refresh del arranque atrapa las excepciones', () => {
    expect(store, 'volvió `void refresh()`: una excepción deja store.loading en true para siempre')
      .not.toMatch(/useEffect\(\(\) => \{ void refresh\(\); \}, \[refresh\]\);/);
    const i = store.indexOf('refresh().catch(');
    expect(i, 'el refresh del arranque no atrapa excepciones').toBeGreaterThan(-1);
    expect(store.slice(i, i + 400), 'el catch no suelta la pantalla').toMatch(/setLoading\(false\)/);
    // Y avisa, en vez de dejar una pantalla que parece vacía a propósito.
    expect(store.slice(i, i + 400)).toMatch(/setStoresError\(true\)/);
  });
});
