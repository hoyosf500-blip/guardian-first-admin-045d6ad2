import { describe, it, expect } from 'vitest';
import {
  aplicarCortacircuitos,
  resumenPausa,
  UMBRAL_PAUSA,
  SONDA_MS,
  VENTANA_PAUSA_MS,
  type IntentoPrevio,
} from './cortacircuitos';

const AHORA = Date.parse('2026-09-04T22:00:00Z');
const MIN = 60_000;
const HORA = 60 * MIN;

/** Los textos LITERALES que devolvió Dropi en producción el 4-sep-2026. */
const SIN_STOCK =
  'Fallback web [422]: El producto Dropi 147152 no tiene stock en bodega (sin ciudad de origen).';
const SHAMPOO =
  'Fallback web [502]: Dropi (panel web) rechazó el pedido [200]: El producto Shampoo Cubre Canas Dexe Argan es variable, por lo tanto debe indicar una variación';
const GALAPAGOS =
  'Fallback web [502]: Dropi (panel web) rechazó el pedido [200]: 3. La ciudad no tiene habilitado el médoto de envío: CON RECAUDO - SANTA CRUZ-GALAPAGOS-SERVIENTREGA-[]-';

interface Pedido { shopify_order_id: string; createdAtMs: number }

const ped = (id: string, edadHoras: number): Pedido => ({
  shopify_order_id: id,
  createdAtMs: AHORA - edadHoras * HORA,
});

/** N pedidos fallando por el mismo texto, todos intentados hace `haceMs`. */
function fallando(prefijo: string, n: number, texto: string, haceMs = 10 * MIN) {
  const cands: Pedido[] = [];
  const intentos = new Map<string, IntentoPrevio>();
  for (let i = 0; i < n; i++) {
    const id = `${prefijo}${i}`;
    // El más viejo primero: es el orden que entrega selectAutoPushCandidates.
    cands.push(ped(id, 48 - i));
    intentos.set(id, { status: 'error', errorMessage: texto, pushedAtMs: AHORA - haceMs });
  }
  return { cands, intentos };
}

describe('cortacircuitos — una causa rota deja de comerse la cabeza de la cola', () => {
  it('con menos pedidos que el umbral NO pausa nada: dos fallos pueden ser casualidad', () => {
    const { cands, intentos } = fallando('a', UMBRAL_PAUSA - 1, SIN_STOCK);
    const r = aplicarCortacircuitos(cands, intentos, { nowMs: AHORA });
    expect(r.aSubir).toHaveLength(UMBRAL_PAUSA - 1);
    expect(r.enPausa).toHaveLength(0);
    expect(r.causas).toHaveLength(0);
  });

  it('al llegar al umbral pausa la causa y deja pasar UNA sonda', () => {
    // Último intento hace más de una hora → toca sonda.
    const { cands, intentos } = fallando('b', 10, SIN_STOCK, SONDA_MS + MIN);
    const r = aplicarCortacircuitos(cands, intentos, { nowMs: AHORA });
    expect(r.sondas).toHaveLength(1);
    expect(r.aSubir).toHaveLength(1);
    expect(r.enPausa).toHaveLength(9);
    expect(r.causas[0].clave).toBe('sin_stock:147152');
    expect(r.causas[0].pedidos).toBe(10);
  });

  it('la sonda es el MÁS VIEJO, que es el que más urge', () => {
    const { cands, intentos } = fallando('c', 5, SIN_STOCK, SONDA_MS + MIN);
    const r = aplicarCortacircuitos(cands, intentos, { nowMs: AHORA });
    // `fallando` genera el índice 0 como el más viejo (48 h) — y ese orden es el
    // que entrega selectAutoPushCandidates.
    expect(r.sondas[0].shopify_order_id).toBe('c0');
  });

  it('si la sonda de esa causa ya pasó hace poco, NADIE pasa en esta corrida', () => {
    const { cands, intentos } = fallando('d', 10, SIN_STOCK, 5 * MIN);
    const r = aplicarCortacircuitos(cands, intentos, { nowMs: AHORA });
    expect(r.sondas).toHaveLength(0);
    expect(r.aSubir).toHaveLength(0);
    expect(r.enPausa).toHaveLength(10);
  });

  it('⛔ un pedido que NUNCA falló no se frena jamás, aunque haya causas en pausa', () => {
    const { cands, intentos } = fallando('e', 10, SIN_STOCK, 5 * MIN);
    // Una venta nueva, sin ningún intento previo.
    const nueva = ped('venta-nueva', 4);
    const r = aplicarCortacircuitos([...cands, nueva], intentos, { nowMs: AHORA });
    expect(r.aSubir.map((x) => x.shopify_order_id)).toContain('venta-nueva');
    expect(r.sondas).toHaveLength(0); // y no se gasta como sonda: no es de esa causa
  });

  it('un pedido cuyo intento previo NO fue error (claim pending) tampoco se frena', () => {
    const { cands, intentos } = fallando('f', 10, SIN_STOCK, 5 * MIN);
    const otro = ped('g0', 4);
    intentos.set('g0', { status: 'pending', errorMessage: null, pushedAtMs: AHORA - MIN });
    const r = aplicarCortacircuitos([...cands, otro], intentos, { nowMs: AHORA });
    expect(r.aSubir.map((x) => x.shopify_order_id)).toContain('g0');
  });

  it('pausar una causa NO pausa otra: cada una lleva su propia cuenta y su propia sonda', () => {
    const a = fallando('h', 10, SIN_STOCK, SONDA_MS + MIN);
    const b = fallando('i', 5, SHAMPOO, SONDA_MS + MIN);
    const c = fallando('j', 4, GALAPAGOS, 5 * MIN); // pausada, sin sonda todavía
    const intentos = new Map([...a.intentos, ...b.intentos, ...c.intentos]);
    const r = aplicarCortacircuitos([...a.cands, ...b.cands, ...c.cands], intentos, { nowMs: AHORA });
    expect(r.causas.map((x) => x.clave).sort()).toEqual([
      'sin_metodo:SANTA CRUZ',
      'sin_stock:147152',
      'variable:SHAMPOO CUBRE CANAS DEXE ARGAN',
    ]);
    // Dos sondas (las dos causas que ya cumplieron la hora), no tres.
    expect(r.sondas).toHaveLength(2);
    expect(r.aSubir).toHaveLength(2);
    expect(r.enPausa).toHaveLength(17);
  });

  it('⛔ la pausa CADUCA sola: fallos viejos no la sostienen', () => {
    const { cands, intentos } = fallando('k', 10, SIN_STOCK, VENTANA_PAUSA_MS + HORA);
    const r = aplicarCortacircuitos(cands, intentos, { nowMs: AHORA });
    // Nadie en pausa → barrido completo. Si vuelve a fallar, se vuelve a pausar.
    expect(r.causas).toHaveLength(0);
    expect(r.enPausa).toHaveLength(0);
    expect(r.aSubir).toHaveLength(10);
  });

  it('un error SIN texto no agrupa con nada: sin causa conocida se sigue reintentando', () => {
    const cands: Pedido[] = [];
    const intentos = new Map<string, IntentoPrevio>();
    for (let i = 0; i < 10; i++) {
      const id = `l${i}`;
      cands.push(ped(id, 48 - i));
      intentos.set(id, { status: 'error', errorMessage: null, pushedAtMs: AHORA - 5 * MIN });
    }
    const r = aplicarCortacircuitos(cands, intentos, { nowMs: AHORA });
    expect(r.causas).toHaveLength(0);
    expect(r.enPausa).toHaveLength(0);
  });

  it('cuenta la pausa sobre TODOS los que fallan, no solo sobre los candidatos de hoy', () => {
    // 10 fallando por la misma causa, pero solo UNO es candidato en esta corrida
    // (a los otros no se les venció el enfriamiento). Igual tiene que pausar.
    const { intentos } = fallando('m', 10, SIN_STOCK, 5 * MIN);
    const r = aplicarCortacircuitos([ped('m0', 48)], intentos, { nowMs: AHORA });
    expect(r.causas[0].pedidos).toBe(10);
    expect(r.enPausa).toHaveLength(1);
    expect(r.aSubir).toHaveLength(0);
  });
});

describe('cortacircuitos — la pausa NO se puede esconder', () => {
  it('⛔ el resumen lleva la forma «en pausa: N» que lee useAutoPushHealth', () => {
    const { cands, intentos } = fallando('n', 10, SIN_STOCK, 5 * MIN);
    const r = aplicarCortacircuitos(cands, intentos, { nowMs: AHORA });
    const txt = resumenPausa(r);
    expect(txt).toMatch(/en pausa:\s*10/);
    // Y el motivo va en el idioma de la asesora, sin códigos HTTP ni "Fallback".
    expect(txt).toContain('147152');
    expect(txt).not.toMatch(/Fallback|\[\d{3}\]/);
  });

  it('nombra las causas con su conteo, para que el log diga QUÉ está parado', () => {
    const a = fallando('o', 10, SIN_STOCK, 5 * MIN);
    const b = fallando('p', 5, SHAMPOO, 5 * MIN);
    const intentos = new Map([...a.intentos, ...b.intentos]);
    const r = aplicarCortacircuitos([...a.cands, ...b.cands], intentos, { nowMs: AHORA });
    const txt = resumenPausa(r);
    expect(txt).toMatch(/\(10\)/);
    expect(txt).toMatch(/\(5\)/);
  });

  it('sin nada en pausa el resumen es vacío: el mensaje no crece porque sí', () => {
    const r = aplicarCortacircuitos([ped('q', 4)], new Map(), { nowMs: AHORA });
    expect(resumenPausa(r)).toBe('');
  });

  it('la sonda se declara: una corrida con sonda no se ve igual que una muda', () => {
    const { cands, intentos } = fallando('r', 10, SIN_STOCK, SONDA_MS + MIN);
    const r = aplicarCortacircuitos(cands, intentos, { nowMs: AHORA });
    expect(resumenPausa(r)).toMatch(/Sondas:\s*1/);
  });
});
