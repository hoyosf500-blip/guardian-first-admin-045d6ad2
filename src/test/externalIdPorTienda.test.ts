import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Guardián: el número de pedido de Dropi identifica a UN pedido DE UNA TIENDA,
 * nunca a un pedido a secas.
 *
 * Qué pasó (20-ago-2026): `orders.external_id` era UNIQUE GLOBAL. Los números
 * los asigna Dropi y cada país tiene su propia secuencia, así que el 4231045 de
 * Guatemala y el 4231045 de Colombia son pedidos de clientes DISTINTOS. Con el
 * unique global no chocaban: se pisaban. El upsert hacía
 * `ON CONFLICT (external_id) DO UPDATE` incluyendo `store_id`, o sea que el
 * segundo en llegar SE LLEVABA la fila del primero — con su cliente, su
 * dirección y su plata — a otra empresa. El pedido original no quedaba
 * duplicado: desaparecía del CRM de su dueño.
 *
 * Los rangos ya se solapaban cuando se detectó (Guatemala 1.145.315-1.219.530
 * dentro de Quickly Box 899.315-1.239.618): no colisionó por baja densidad, no
 * por diseño.
 *
 * Que los datos de un dueño le aparezcan a otro es la línea que esta operación
 * no puede cruzar. Por eso hay una prueba y no solo un comentario.
 */

const RAIZ = 'supabase/functions';
const MIGRACION = 'supabase/migrations/20260820140000_external_id_unico_por_tienda.sql';

function archivosTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== 'vendor') archivosTs(p, out);
    } else if (e.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('external_id es único POR TIENDA, no global', () => {
  it('la migración existe y hace los tres pasos en el orden seguro', () => {
    expect(existsSync(MIGRACION), `falta ${MIGRACION}`).toBe(true);
    const sql = readFileSync(MIGRACION, 'utf8');

    const posIndice = sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS orders_store_external_uk');
    const posFuncion = sql.indexOf('ON CONFLICT (store_id, external_id)');
    const posDrop = sql.indexOf('DROP CONSTRAINT IF EXISTS orders_external_id_key');

    expect(posIndice, 'no crea el índice compuesto').toBeGreaterThan(-1);
    expect(posFuncion, 'la función no apunta al conflicto compuesto').toBeGreaterThan(-1);
    expect(posDrop, 'no quita el unique global').toBeGreaterThan(-1);

    // El orden IMPORTA: quitar el candado viejo antes de tener el nuevo dejaría
    // la tabla sin ninguna protección; y con la función apuntando al conflicto
    // viejo, el upsert falla entero y deja de entrar TODO pedido nuevo.
    expect(posIndice).toBeLessThan(posFuncion);
    expect(posFuncion).toBeLessThan(posDrop);

    // Guard fail-closed: un store_id NULL no lo restringe un índice compuesto.
    expect(sql).toContain('store_id IS NULL');
    expect(sql).toContain('RAISE EXCEPTION');
  });

  it('ninguna edge function upsertea pedidos por external_id a secas', () => {
    const archivos = archivosTs(RAIZ);
    // Anti-pase-vacío: si el descubrimiento se rompiera, el test no puede pasar
    // por no haber leído nada.
    expect(archivos.length).toBeGreaterThan(30);

    const culpables: string[] = [];
    let vioAlgunUpsert = false;
    for (const f of archivos) {
      const src = readFileSync(f, 'utf8');
      if (src.includes('onConflict')) vioAlgunUpsert = true;
      // Solo el compuesto es válido para `orders`. `onConflict: "external_id"`
      // a secas vuelve a tratar el número como si fuera de una sola tienda.
      if (/onConflict:\s*["']external_id["']/.test(src)) {
        culpables.push(f.replace(/\\/g, '/'));
      }
    }
    expect(vioAlgunUpsert, 'no se leyó ningún upsert: el escaneo no sirvió').toBe(true);
    expect(
      culpables,
      'usar onConflict "store_id,external_id" — el número de pedido solo identifica dentro de su tienda',
    ).toEqual([]);
  });

  it('el webhook usa la llave compuesta', () => {
    const src = readFileSync(join(RAIZ, 'dropi-webhook/index.ts'), 'utf8');
    expect(src).toContain('onConflict: "store_id,external_id"');
  });
});
