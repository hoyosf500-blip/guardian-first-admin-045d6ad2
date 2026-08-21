import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { classifySegEstado } from '@/lib/segStatus';

/**
 * GUARDIÁN — un pedido sin estado no puede desaparecer de Seguimiento.
 *
 * ── La trampa ───────────────────────────────────────────────────────────────
 * La query de Seguimiento descarta los estados terminales con
 * `.not('estado','eq','ENTREGADO')` y compañía. En SQL, `NOT (NULL = 'X')` NO
 * es TRUE: es NULL, y PostgREST tira la fila. O sea que cada uno de esos
 * filtros descarta también los pedidos con `estado IS NULL` — no aparecían en
 * Seguimiento **nunca**, sin toast, sin aviso y sin forma de notarlo.
 *
 * No es una teoría de escritorio: `dropi-nightly-reconcile` documenta esta
 * misma trampa dos veces y por eso filtra del lado del cliente. El frontend no
 * había aplicado la lección.
 *
 * ── Por qué es una prueba y no un arreglo ───────────────────────────────────
 * Medido el 21-ago-2026 en las dos tiendas: **cero** filas con `estado IS NULL`
 * hoy. Así que esto es una defensa, no una reparación — y por eso vale la pena
 * fijarla: el día que Dropi devuelva un estado vacío, el pedido tiene que estar
 * a la vista. Un pedido invisible es exactamente como se pierde un cliente.
 */

const leer = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('GUARDIÁN: pedidos sin estado', () => {
  it('la carga de Seguimiento va a buscarlos explícitamente', () => {
    const src = leer('src/hooks/useDataLoader.ts');
    // Sin esta query, los `.not('estado','eq',...)` de arriba los tiran a todos.
    expect(src).toMatch(/\.is\(\s*['"]estado['"]\s*,\s*null\s*\)/);
  });

  it('un estado vacío cae en una columna VISIBLE del tablero, no en el limbo', () => {
    expect(classifySegEstado('')).toBe('otros');
  });

  it('los filtros de exclusión siguen siendo `.not(...eq...)` — el motivo del hueco', () => {
    // Si alguien migra estos filtros a una forma que sí contemple NULL, esta
    // prueba se pone roja y hay que revisar si la query de arriba sigue
    // haciendo falta. Es un recordatorio, no una prohibición.
    const src = leer('src/hooks/useDataLoader.ts');
    expect(src).toContain(".not('estado', 'eq', 'ENTREGADO')");
  });
});
