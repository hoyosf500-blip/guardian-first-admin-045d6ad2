import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * `supabase.rpc` guardado en una variable SIN `.bind(supabase)`.
 *
 * El cast `as unknown as (...)` es solo de tipos: no preserva el receptor. Al
 * desreferenciar el método, adentro `this` queda undefined y supabase-js
 * explota con **"Cannot read properties of undefined (reading 'rest')"**.
 *
 * Ya costó caro dos veces:
 *  - 2026-05-06: 8 pantallas del módulo CFO / Reportes diarios en cero silencioso.
 *  - 2026-08-13: el SetupWizard — un dueño NUEVO apretaba "Guardar y verificar",
 *    el botón giraba para siempre y no podía terminar de configurar su tienda.
 *    Justo el camino que recorren los amigos invitados a Guardian.
 *
 * La distinción importa y por eso el test no prohíbe el patrón entero:
 *   (supabase.rpc as unknown as X)('fn', args)   ✅ invocación DIRECTA, conserva `this`
 *   const r = supabase.rpc as unknown as X; r(…)  ❌ referencia guardada, lo pierde
 *
 * Solo se marca la forma peligrosa: asignar `supabase.rpc` a algo sin bindear.
 */

function archivos(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) archivos(p, out);
    else if ((e.endsWith('.ts') || e.endsWith('.tsx')) && !e.includes('.test.')) out.push(p);
  }
  return out;
}

/** `= supabase.rpc` (asignación) que NO venga seguido de `.bind(`. */
const ASIGNACION_SIN_BIND = /=\s*supabase\.rpc(?!\s*\.bind\b)/;

/** Quita comentarios de línea y de bloque. Sin esto, los comentarios que
 *  EXPLICAN el patrón peligroso (`// si solo hacés const rpc = supabase.rpc`)
 *  se cuentan como infracción: el guardián señalaba justo los archivos mejor
 *  documentados, que son los que ya lo hacen bien. */
function codigo(linea: string): string {
  // Sin `$`: el repo se checkoutea con CRLF y `\r` es un TERMINADOR DE LÍNEA
  // para las expresiones regulares de JS — `.` no lo cruza, así que `/\/\/.*$/`
  // NO matcheaba nada y el limpiador quedaba mudo (media hora de test verde
  // mintiendo al revés: marcaba archivos correctos).
  return linea.replace(/\/\/.*/, '').replace(/^\s*\*.*/, '');
}

describe('supabase.rpc: la referencia guardada SIEMPRE va bindeada', () => {
  const fuentes = archivos('src');

  it('encuentra archivos para revisar (si no, el test no prueba nada)', () => {
    expect(fuentes.length).toBeGreaterThan(100);
  });

  it('ningún archivo guarda supabase.rpc sin .bind(supabase)', () => {
    const rotos: string[] = [];
    for (const f of fuentes) {
      const src = readFileSync(f, 'utf8');
      // split tolerante a CRLF: sin esto cada línea arrastra un '\r' final.
      src.split(/\r?\n/).forEach((linea, i) => {
        if (ASIGNACION_SIN_BIND.test(codigo(linea))) rotos.push(`${f.replace(/\\/g, '/')}:${i + 1}`);
      });
    }
    expect(rotos).toEqual([]);
  });

  it('el regex distingue la forma segura de la peligrosa', () => {
    // Peligrosa: se guarda la referencia.
    expect(ASIGNACION_SIN_BIND.test('const rpc = supabase.rpc as unknown as Fn;')).toBe(true);
    // Segura: bindeada.
    expect(ASIGNACION_SIN_BIND.test('const rpc = supabase.rpc.bind(supabase) as unknown as Fn;')).toBe(false);
    // Segura: invocación directa (no hay asignación del método).
    expect(ASIGNACION_SIN_BIND.test("await (supabase.rpc as unknown as Fn)('foo', args);")).toBe(false);
    // Un COMENTARIO que menciona el patrón malo no es una infracción.
    expect(ASIGNACION_SIN_BIND.test(codigo('  // si solo hacés `const rpc = supabase.rpc` se pierde el this'))).toBe(false);
    // …y tampoco con final de línea Windows (el `\r` rompía el limpiador).
    expect(ASIGNACION_SIN_BIND.test(codigo('  // ojo: const rpc = supabase.rpc\r'))).toBe(false);
  });
});
