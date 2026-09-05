import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GUARDIÁN de la cuarta capa anti-duplicados (4-sep-2026).
 *
 * ── Lo que se midió ────────────────────────────────────────────────────────
 * Ecuador, 7 días: **20 duplicados reales** (~3 por día), contados con
 * `pedido_creado_at` —la fecha de Dropi— después de descartar los pares
 * REEMPLAZADA→reemplazo, que Dropi crea con la MISMA fecha y no son duplicados.
 *
 *     Guardian creó el primero, otro el segundo ....  9
 *     Otro creó el primero, GUARDIAN el segundo ..... 10   ← este hueco
 *     Guardian creó los dos ......................... 0
 *     Ninguno de los dos fue Guardian ............... 1
 *
 * Guardian **nunca se duplica contra sí mismo**. El hueco es lo que Guardian no
 * sabe que existe: las tres capas que ya había leen NUESTRA base — el espejo
 * `orders` (hasta 15 min de atraso) y `shopify_pushed_orders` (solo lo que subió
 * este robot). Un pedido cargado a mano en el panel de Dropi, o creado por
 * Dropify, no está en ninguna de las dos hasta que sincroniza.
 *
 * La cuarta capa le pregunta a Dropi directamente.
 */

const raiz = resolve(__dirname, '../..');
const leer = (p: string) => readFileSync(resolve(raiz, p), 'utf8');

const PUSH = 'supabase/functions/shopify-push-dropi/index.ts';
const LIVENESS = 'supabase/functions/_shared/dropiOrderLiveness.ts';

describe('el push le pregunta a Dropi, no solo al espejo', () => {
  it('usa la búsqueda de hermanas vivas antes de crear', () => {
    const s = leer(PUSH);
    expect(s).toContain('buscarHermanasVivas');
    const iPregunta = s.indexOf('await buscarHermanasVivas(');
    // ⛔ Contra la creación REAL del handler, no contra la definición del
    // helper que está arriba en el archivo: comparar con esa daba un falso rojo.
    const iCrea = s.indexOf('await fetch(`${dropiCfg.base}/integrations/orders/myorders`');
    expect(iPregunta).toBeGreaterThan(-1);
    expect(iCrea).toBeGreaterThan(-1);
    expect(iPregunta, 'preguntar DESPUÉS de crear no sirve de nada').toBeLessThan(iCrea);
  });

  it('⛔ una sola definición de «el cliente ya tiene un pedido en curso»', () => {
    // La misma función que ya usan dropi-change-carrier y dropiConfirmOrder.
    // Dos definiciones = dos respuestas distintas sobre el mismo cliente.
    const liveness = leer(LIVENESS);
    expect(liveness).toContain('export async function buscarHermanasVivas');
    expect(
      /export async function listActiveOrdersByPhone[\s\S]{0,300}?buscarHermanasVivas\(/.test(liveness),
      'listActiveOrdersByPhone tiene que delegar, no tener su propia copia',
    ).toBe(true);
  });

  it('respeta «No es duplicado»: la capa vive dentro del guard de allowDuplicate', () => {
    const s = leer(PUSH);
    const iGuard = s.indexOf('if (!allowDuplicate && phoneNorm.length >= 7)');
    const iPregunta = s.indexOf('await buscarHermanasVivas(');
    expect(iGuard).toBeGreaterThan(-1);
    expect(iPregunta).toBeGreaterThan(iGuard);
  });
});

describe('«no encontré» y «no pude buscar» NO son lo mismo', () => {
  it('⛔ la búsqueda reporta si la consulta CORRIÓ, no solo su resultado', () => {
    const s = leer(LIVENESS);
    expect(s).toMatch(/consultado:\s*boolean/);
    // Sin token de sesión no se puede preguntar: eso es `consultado: false`,
    // NUNCA una lista vacía que se lea como "no tiene pedidos".
    expect(s).toMatch(/if \(!cfg\.sessionToken\)[\s\S]{0,200}consultado: false/);
  });

  it('⛔ solo se bloquea si de verdad se preguntó Y se encontró algo', () => {
    const s = leer(PUSH);
    expect(
      /if \(hermanas\.consultado && hermanas\.hermanas\.length > 0\)/.test(s),
      'bloquear sin haber podido preguntar es inventar un duplicado',
    ).toBe(true);
  });

  it('⛔ no poder preguntar NO frena el push, pero queda DICHO', () => {
    const s = leer(PUSH);
    // Colombia no tiene login automático (2FA) → nunca hay token de sesión.
    // Bloquear ahí dejaría al país entero sin poder subir.
    expect(/if \(!hermanas\.consultado\)/.test(s)).toBe(true);
    expect(/avisoAntiDup =/.test(s)).toBe(true);
    // Y el aviso VIAJA en la respuesta: un push sin todas las defensas no puede
    // verse igual que uno con todas.
    // ⛔ Se cuentan las OCURRENCIAS, no se recorta con [^)]*: el segundo camino
    // devuelve `String(dropiOrderId)` y ese paréntesis cortaba el match.
    const conAviso = (s.match(/ok: true, mode: "confirm"[\s\S]{0,220}?aviso: avisoAntiDup/g) || []).length;
    expect(
      conAviso,
      'los dos caminos de creación (integraciones y web) tienen que llevar el aviso',
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('la marca de versión permite comprobar el deploy', () => {
  it('subió con este arreglo', () => {
    const m = /const VERSION = "shopify-push-dropi ([^"]+)";/.exec(leer(PUSH));
    expect(m).toBeTruthy();
    expect(m![1]).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+ /);
  });
});
