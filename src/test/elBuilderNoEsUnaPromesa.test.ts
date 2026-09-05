import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * GUARDIÁN: a un builder de PostgREST no se le encadena `.catch()`.
 *
 * ── Lo que pasó (5-sep-2026, producción caída) ─────────────────────────────
 * Para lanzar un RPC en paralelo con otra consulta se escribió:
 *
 *     const p = (supabase.rpc as unknown as (...) => Promise<X>)('fn', {})
 *       .catch((e) => ({ data: null, error: { message: String(e) } }));
 *
 * `supabase.rpc()` **NO devuelve una Promise**. Devuelve un builder de
 * PostgREST que es *thenable*: implementa `.then()` —por eso el `await` de
 * siempre funciona— pero **no implementa `.catch()` ni `.finally()`**.
 *
 * Resultado: `TypeError: rpc(...).catch is not a function`, lanzado de forma
 * SINCRÓNICA dentro de `StoreContext.refresh()`. El `.catch` que protege a
 * `refresh` lo tomó como cualquier otro fallo y puso `storesError` → la app
 * entera en «No se pudieron cargar tus tiendas», en todas las rutas, para todo
 * el equipo.
 *
 * ⛔ Y el typecheck lo dejó pasar: el cast `as unknown as (...) => Promise<X>`
 * le AFIRMA al compilador que es una Promise. El cast apagó la única red que
 * había. Es la misma familia que `rpcBinding` (el `this` perdido al sacar
 * `supabase.rpc` de su objeto): tocar el builder fuera de su forma normal
 * rompe cosas que los tipos ya no pueden ver.
 *
 * La forma correcta cuando hace falta una Promise de verdad (para
 * `Promise.all`, para un `.catch`, para guardarla y cosecharla después):
 *
 *     const p = Promise.resolve(supabase.rpc('fn', {}));   // Promise nativa
 *
 * `Promise.resolve` adopta al thenable, dispara la consulta y devuelve algo que
 * sí tiene `.catch()` y `.finally()`.
 *
 * Si esta prueba se pone roja: envolvé en `Promise.resolve(...)`. No la relajes.
 */

const RAICES = [join(__dirname, '..'), join(__dirname, '..', '..', 'supabase', 'functions')];

function fuentes(dir: string, acc: string[] = []): string[] {
  let entradas: string[];
  try { entradas = readdirSync(dir); } catch { return acc; }
  for (const e of entradas) {
    const p = join(dir, e);
    let esDir = false;
    try { esDir = statSync(p).isDirectory(); } catch { continue; }
    if (esDir) {
      if (e === 'node_modules' || e === 'test') continue;
      fuentes(p, acc);
    } else if ((e.endsWith('.ts') || e.endsWith('.tsx')) && !e.includes('.test.')) {
      acc.push(p);
    }
  }
  return acc;
}

/** Tapa comentarios con espacios sin mover índices (misma razón que en
 *  `lasBarrasSeVen`: un ejemplo escrito EN PROSA no es código). */
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/**
 * Cuánto se mira hacia atrás desde un `.catch(` para decidir si lo que tiene
 * delante es un builder de PostgREST.
 *
 * ⛔ Se mira DESDE EL `.catch` hacia atrás, no desde el `.rpc` hacia adelante.
 * La primera versión de esta prueba buscaba `.rpc(` y daba VERDE sobre el
 * código que tumbó producción, porque en este repo el RPC casi nunca se llama
 * así: va casteado —`(supabase.rpc as unknown as (...))('fn', {})`, el rodeo de
 * `rpcBinding`— y ahí no hay ningún `(` pegado a `.rpc`. El detector buscaba
 * una forma que este proyecto no usa.
 */
const VENTANA_ATRAS = 320;

describe('un builder de PostgREST no es una Promise', () => {
  it('nadie le encadena .catch() ni .finally() a supabase.rpc(...)', () => {
    const malos: string[] = [];
    let llamadasVistas = 0;

    for (const raiz of RAICES) {
      for (const archivo of fuentes(raiz)) {
        const codigo = sinComentarios(readFileSync(archivo, 'utf8'));
        if (codigo.includes('.rpc')) llamadasVistas++;

        const re = /\.(catch|finally)\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(codigo)) !== null) {
          const atras = codigo.slice(Math.max(0, m.index - VENTANA_ATRAS), m.index);
          // ¿Hay un RPC ahí atrás, y NO está envuelto ni consumido?
          const hayRpc = /\.rpc\b/.test(atras);
          if (!hayRpc) continue;
          // `Promise.resolve(...)`, `Promise.all([...])` y `await` ya convierten
          // el thenable en algo que sí tiene `.catch`. Solo se marca lo crudo.
          const yaEnvuelto = /Promise\s*\.\s*(resolve|all|allSettled|race)\s*\(/.test(atras)
            || /\bawait\b/.test(atras);
          if (yaEnvuelto) continue;
          const linea = codigo.slice(0, m.index).split('\n').length;
          malos.push(`${archivo.split(/[\\/]/).slice(-2).join('/')}:${linea}`);
        }
      }
    }

    // Sin esto, un regex roto daría VERDE sin haber mirado nada.
    expect(llamadasVistas, 'ningún archivo menciona .rpc: la prueba no probó nada')
      .toBeGreaterThan(5);
    expect(
      malos,
      'supabase.rpc() devuelve un builder THENABLE, no una Promise: no tiene ' +
      '.catch() ni .finally(). Encadenarlos tira un TypeError sincrónico. ' +
      'Envolvé en Promise.resolve(...) si necesitás una Promise de verdad.',
    ).toEqual([]);
  });
});
