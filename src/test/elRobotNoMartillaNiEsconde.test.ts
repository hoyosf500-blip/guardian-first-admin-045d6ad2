import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GUARDIÁN del cortacircuitos del robot Shopify→Dropi (4-sep-2026).
 *
 * Lo que se midió y por qué existe esta prueba: en 48 h el robot corrió 191
 * veces y 103 de esas corridas terminaron en «0 de N subidos» — 778 intentos
 * contra el panel web de Dropi que no podían salir bien, casi todos por cuatro
 * causas (el producto 147152 sin stock, el shampoo variable y dos ciudades de
 * Galápagos). En el mismo lapso el robot SÍ creó 150 pedidos: no está roto,
 * está martillando.
 *
 * Hay DOS formas de arruinar este arreglo, y las dos son silenciosas:
 *
 *  1. Aplicar el corte DESPUÉS del tope por corrida. Los candidatos vienen
 *     ordenados del más viejo al más nuevo y los atascados son los más viejos,
 *     así que se comerían igual los 20 cupos y no se arreglaría nada — pero el
 *     código «tendría» cortacircuitos y nadie volvería a mirar.
 *  2. Pausar sin contarlo. Una corrida donde todo quedó en pausa se ve idéntica
 *     a una corrida sin trabajo: el panel se pinta VERDE con las ventas
 *     paradas. Es `wallet_cron_fallaba_en_verde` otra vez.
 */

const raiz = resolve(__dirname, '../..');
const leer = (p: string) => readFileSync(resolve(raiz, p), 'utf8');

const ROBOT = 'supabase/functions/shopify-auto-push/index.ts';
const CORTE = 'supabase/functions/_shared/cortacircuitos.ts';
const BANNER = 'src/hooks/useAutoPushHealth.ts';

describe('el corte decide ANTES de repartir el cupo', () => {
  it('el robot pide la lista SIN tope (cap: 0) y recorta después del corte', () => {
    const s = leer(ROBOT);
    expect(s).toMatch(/errorCooldownMs:\s*ERROR_COOLDOWN_MS,\s*cap:\s*0,/);
    expect(s).toContain('corte.aSubir.slice(0, PER_STORE_CAP)');
  });

  it('⛔ el orden importa: aplicarCortacircuitos va ANTES del slice del tope', () => {
    const s = leer(ROBOT);
    const iCorte = s.indexOf('aplicarCortacircuitos(');
    const iTope = s.indexOf('corte.aSubir.slice(0, PER_STORE_CAP)');
    expect(iCorte).toBeGreaterThan(-1);
    expect(iTope).toBeGreaterThan(-1);
    expect(iCorte).toBeLessThan(iTope);
  });

  it('la consulta de intentos previos trae error_message: sin texto no hay causa', () => {
    const s = leer(ROBOT);
    expect(s).toMatch(/from\("shopify_pushed_orders"\)\.select\([^)]*error_message/);
  });
});

describe('la pausa no se puede esconder', () => {
  it('⛔ una corrida con pedidos en pausa OBLIGA a escribir en sync_logs', () => {
    const s = leer(ROBOT);
    // Sin `hayPausa` en la condición, una corrida con 52 ventas paradas y cero
    // candidatos sale 'success' con el mensaje vacío.
    expect(s).toMatch(/const hayPausa\s*=\s*corte\.enPausa\.length\s*>\s*0/);
    const cond = /if \(errors > 0 \|\| zeroWithCandidates \|\| sinTiempo > 0 \|\| hayPausa\) \{/;
    expect(s).toMatch(cond);
  });

  it('el mensaje del log incluye el resumen de la pausa', () => {
    const s = leer(ROBOT);
    const i = s.indexOf('logError = `');
    expect(i).toBeGreaterThan(-1);
    expect(s.slice(i, i + 400)).toContain('resumenPausa(corte)');
  });

  it('⛔ el banner CUENTA los pausados como ventas sin subir', () => {
    const s = leer(BANNER);
    expect(s).toMatch(/RE_EN_PAUSA\s*=\s*\/en pausa/i);
    // Y sumados, no solo leídos: un número que se lee y se tira es peor que
    // ninguno, porque parece que está contemplado.
    expect(s).toMatch(/const cuantos\s*=\s*[^;]*\benPausa\b/);
  });

  it('⛔ las dos puntas escriben y leen la MISMA forma «en pausa: N»', () => {
    const emisor = leer(CORTE);
    const lector = leer(BANNER);
    expect(emisor).toContain('en pausa: ${corte.enPausa.length}');
    const re = /RE_EN_PAUSA\s*=\s*\/([^/]+)\//.exec(lector);
    expect(re).toBeTruthy();
    // La regex del lector tiene que matchear lo que el emisor escribe de verdad.
    expect(new RegExp(re![1], 'i').test('en pausa: 52 (algo)')).toBe(true);
  });

  it('el dry run muestra la pausa: si no, quien lo corre cree que no hay trabajo', () => {
    const s = leer(ROBOT);
    const i = s.indexOf('dry_run: true');
    expect(i).toBeGreaterThan(-1);
    expect(s.slice(i, i + 500)).toContain('en_pausa');
  });
});

describe('las reglas que hacen que la pausa no sea una trampa', () => {
  it('⛔ un pedido sin fallo previo NUNCA se frena: es el detector de recuperación', () => {
    const s = leer(CORTE);
    expect(s).toMatch(/if \(!prev \|\| prev\.status !== "error"\) \{[^}]*aSubir\.push\(c\)/);
  });

  it('la pausa caduca sola: los fallos viejos no la sostienen', () => {
    const s = leer(CORTE);
    expect(s).toContain('VENTANA_PAUSA_MS');
    expect(s).toMatch(/if \(opts\.nowMs - it\.pushedAtMs > ventanaMs\) continue;/);
  });

  it('un error sin texto no agrupa: no se pausa lo que no se entiende', () => {
    const s = leer(CORTE);
    expect(s).toMatch(/if \(c\.familia === "sin_verificar"\) continue;/);
  });

  it('la VERSION quedó marcada para poder comprobar el deploy con ?ping=1', () => {
    const s = leer(ROBOT);
    const m = /const VERSION = "shopify-auto-push ([^"]+)";/.exec(s);
    expect(m).toBeTruthy();
    expect(m![1]).toMatch(/^\d{4}-\d{2}-\d{2}\./);
  });
});
