import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * GUARDIÁN: cancelar un pedido en Dropi NO lo resucita como venta «sin subir».
 *
 * ── Lo que pasó (5-sep-2026, Ecuador, Felipe Flores · 967818548) ────────────
 *  04-sep 22:25Z  Dropify crea #6863541 ($38) a partir de la venta de Shopify
 *                 7543790862561.
 *  05-sep ~11:35Z El pedido queda CANCELADO en Dropi.
 *  05-sep 16:48Z  El robot `shopify-auto-push` corre («1 de 1 subidos») y crea
 *                 #6873393 ($40,30) de la MISMA venta de Shopify. `sync_logs` y
 *                 `shopify_pushed_orders` lo prueban fila por fila.
 *  05-sep 17:10Z  La operadora lo cancela como «Duplicado» y reporta que el
 *                 pedido «vuelve a salir otra vez en la cola».
 *
 * La causa está en cómo el robot arma `contraparteDropiMs` (teléfono → fecha de
 * la orden Dropi más reciente): saltaba a propósito las órdenes CANCELADAS con
 * el argumento de que «no despacharon nada, así que no son contraparte de nada».
 * Es al revés: una orden nacida DESPUÉS de la venta ES la orden de esa venta, y
 * cancelarla fue una decisión sobre esa venta. Una recompra legítima tiene la
 * venta de Shopify MÁS NUEVA que la orden cancelada, así que sigue pasando.
 *
 * `shopify-reconcile` (el panel de pendientes) ya lo tenía bien: su
 * `ESTADOS_MUERTOS` son solo ARCHIVADO GHOST y REEMPLAZADA, y dice con todas
 * las letras «CANCELADO NO va acá: una cancelación real cubre la venta». El
 * robot y el panel tienen que contestar lo mismo sobre la misma venta.
 */

const RAIZ = join(__dirname, '..', '..');
const leer = (rel: string) => readFileSync(join(RAIZ, rel), 'utf8');
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

const robot = sinComentarios(leer('supabase/functions/shopify-auto-push/index.ts'));

describe('el robot de Shopify cuenta la orden cancelada como contraparte de su venta', () => {
  it('al armar contraparteDropiMs no se saltan las CANCELADAS ni las ANULADAS', () => {
    const i = robot.indexOf('const contraparteDropiMs');
    const j = robot.indexOf('contraparteDropiMs.set(');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    const bloque = robot.slice(i, j);
    expect(bloque, 'volvió el salto de las canceladas: cancelar resucita la venta').not.toMatch(/CANCEL/);
    expect(bloque, 'ANULADO es una cancelación con otro nombre').not.toMatch(/ANULAD/);
  });

  it('sigue saltando solo lo que también salta el panel: REEMPLAZADA y ARCHIVADO GHOST', () => {
    const i = robot.indexOf('const contraparteDropiMs');
    const j = robot.indexOf('contraparteDropiMs.set(');
    const bloque = robot.slice(i, j);
    expect(bloque).toMatch(/REEMPLAZ/);
    expect(bloque).toMatch(/ARCHIVADO/);
    // Y el panel, del que se copia la regla, no cambió de idea.
    const reconcile = sinComentarios(leer('supabase/functions/shopify-reconcile/index.ts'));
    expect(reconcile).toMatch(/ESTADOS_MUERTOS = new Set\(\["ARCHIVADO GHOST", "REEMPLAZADA"\]\)/);
  });

  it('la marca de versión subió con el arreglo', () => {
    expect(robot).toMatch(/const VERSION = "shopify-auto-push 2026-09-05\.\d+ /);
  });
});
