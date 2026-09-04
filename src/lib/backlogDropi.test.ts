import { describe, it, expect } from 'vitest';
import { armarBacklogDropi, GRACIA_MS, TECHO_MS } from './backlogDropi';
import type { ShopifyPendingItem } from '@/hooks/useShopifyPending';
import type { PushAttempt } from '@/hooks/useShopifyPushAttempts';

const AHORA = Date.parse('2026-09-04T20:00:00Z');
const hace = (ms: number) => new Date(AHORA - ms).toISOString();

const venta = (id: string, o: Partial<ShopifyPendingItem> = {}): ShopifyPendingItem => ({
  id, name: `#${id}`, customer: 'Cliente', phone: '998817794', total: 29.99,
  created_at: hace(GRACIA_MS + 60_000), city: 'QUITO', admin_url: '', ...o,
});

const intento = (id: string, status: string, error: string | null, edadMs = 60_000): PushAttempt => ({
  shopify_order_id: id, status, error_message: error, dropi_order_id: null, pushed_at: hace(edadMs),
});

const mapa = (...xs: PushAttempt[]) => new Map(xs.map((x) => [x.shopify_order_id, x]));

const STOCK = 'Fallback web [422]: El producto Dropi 147152 no tiene stock en bodega (sin ciudad de origen).';
const COBERTURA = 'Fallback web [422]: Dropi no lista "RIO VERDE (ESMERALDAS)" en su catálogo de envíos — sin cobertura COD para cotizar/editar este destino.';

describe('armarBacklogDropi — la honestidad primero', () => {
  it('sin lectura buena NO devuelve ningún conteo', () => {
    const r = armarBacklogDropi([venta('1')], mapa(intento('1', 'error', STOCK)), { ahoraMs: AHORA, pudoLeer: false });
    expect(r.pudoLeer).toBe(false);
    expect(r.fallaron, '"no pude leer" no puede parecerse a "no hay ninguna"').toHaveLength(0);
    expect(r.plataTrabada).toBe(0);
  });

  it('con lectura buena y sin fallas, dice cero de verdad', () => {
    const r = armarBacklogDropi([], new Map(), { ahoraMs: AHORA, pudoLeer: true });
    expect(r.pudoLeer).toBe(true);
    expect(r.fallaron).toHaveLength(0);
  });
});

describe('armarBacklogDropi — qué cuenta como venta trabada', () => {
  it('agrupa por motivo y ordena por plata', () => {
    const r = armarBacklogDropi(
      [venta('1', { total: 10 }), venta('2', { total: 100 }), venta('3', { total: 20 })],
      mapa(intento('1', 'error', STOCK), intento('2', 'error', COBERTURA), intento('3', 'error', STOCK)),
      { ahoraMs: AHORA, pudoLeer: true },
    );
    expect(r.fallaron).toHaveLength(3);
    expect(r.grupos).toHaveLength(2);
    expect(r.grupos[0].causa.familia, 'el grupo con más plata va primero').toBe('sin_cobertura');
    expect(r.grupos[1].ventas).toHaveLength(2);
    expect(r.plataTrabada).toBe(130);
  });

  it('el candado anti-duplicado NO es una venta trabada', () => {
    const r = armarBacklogDropi(
      [venta('1')],
      mapa(intento('1', 'error', 'Ya hay un pedido en Dropi con este teléfono: #6854946 (PENDIENTE).')),
      { ahoraMs: AHORA, pudoLeer: true },
    );
    expect(r.fallaron, 'el candado hizo su trabajo: contarlo como trabada sería mentir').toHaveLength(0);
  });

  it('lo indeterminado va aparte: NO se reintenta solo', () => {
    const r = armarBacklogDropi(
      [venta('1')],
      mapa(intento('1', 'error', 'needs_verify: no sé si la orden quedó creada')),
      { ahoraMs: AHORA, pudoLeer: true },
    );
    expect(r.fallaron).toHaveLength(0);
    expect(r.sinVerificar).toHaveLength(1);
  });

  it('un created que sigue pendiente es un problema de cruce, no una venta trabada', () => {
    const r = armarBacklogDropi([venta('1')], mapa(intento('1', 'created', null)), { ahoraMs: AHORA, pudoLeer: true });
    expect(r.fallaron).toHaveLength(0);
    expect(r.esperandoTurno).toHaveLength(0);
  });
});

describe('armarBacklogDropi — las que todavía no son problema', () => {
  it('sin intento y dentro de la gracia: el robot las va a subir', () => {
    const r = armarBacklogDropi([venta('1', { created_at: hace(60_000) })], new Map(), { ahoraMs: AHORA, pudoLeer: true });
    expect(r.esperandoTurno).toHaveLength(1);
    expect(r.fallaron).toHaveLength(0);
  });

  it('un claim pending FRESCO se está subiendo ahora, no falló', () => {
    const r = armarBacklogDropi([venta('1')], mapa(intento('1', 'pending', null, 30_000)), { ahoraMs: AHORA, pudoLeer: true });
    expect(r.esperandoTurno).toHaveLength(1);
  });

  it('pasado el techo el robot ya la soltó: queda para la mano humana', () => {
    const r = armarBacklogDropi([venta('1', { created_at: hace(TECHO_MS + 3600_000) })], new Map(), { ahoraMs: AHORA, pudoLeer: true });
    expect(r.nadieLasVaAIntentar).toHaveLength(1);
    expect(r.esperandoTurno).toHaveLength(0);
  });

  it('sin teléfono el robot nunca la va a intentar', () => {
    const r = armarBacklogDropi([venta('1', { sin_telefono: true })], new Map(), { ahoraMs: AHORA, pudoLeer: true });
    expect(r.nadieLasVaAIntentar).toHaveLength(1);
  });
});
