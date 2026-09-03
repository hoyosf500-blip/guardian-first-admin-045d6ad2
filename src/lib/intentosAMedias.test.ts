import { describe, it, expect } from 'vitest';
import { resumirIntentos, textoIntentosAMedias } from './intentosAMedias';
import type { GestionDelPedido } from './gestionPorPedido';

const g = (intentos: number, ultimoResult: string): GestionDelPedido => ({
  intentos,
  ultimoAt: '2026-09-03T14:00:00.000Z',
  ultimoPor: 'user-1',
  ultimoResult,
  ultimoMotivo: null,
});

const MAX = 3;

describe('pedidos que quedaron a medio intentar', () => {
  it('un intento, no contestó y le quedan llamadas → a medias', () => {
    const r = resumirIntentos({ a: g(1, 'noresp') }, MAX);
    expect(r.aMedias).toBe(1);
    expect(r.agotados).toBe(0);
  });

  it('dos intentos sin respuesta todavía es a medias', () => {
    expect(resumirIntentos({ a: g(2, 'noresp') }, MAX).aMedias).toBe(1);
  });

  /**
   * ⛔ EL QUE HIZO SUS TRES LLAMADAS NO ESTÁ A MEDIAS. Hizo el trabajo completo
   * y el pedido vuelve mañana. Contarlo acá castigaría a quien cumplió.
   */
  it('con las tres llamadas gastadas cuenta como agotado, no como a medias', () => {
    const r = resumirIntentos({ a: g(3, 'noresp') }, MAX);
    expect(r.aMedias).toBe(0);
    expect(r.agotados).toBe(1);
  });

  /**
   * ⛔ CONFIRMAR EN LA PRIMERA NO ES QUEDARSE CORTO, ES HACERLO BIEN. Este
   * número lo va a leer alguien para hablar con una persona: contar acá al que
   * resolvió de una sería exactamente el regaño injusto que hay que evitar.
   */
  it('resuelto en el primer intento NO está a medias', () => {
    const r = resumirIntentos({ a: g(1, 'conf'), b: g(1, 'canc') }, MAX);
    expect(r.aMedias).toBe(0);
    expect(r.resueltos).toBe(2);
  });

  it('un pedido sin ningún intento no cuenta en ninguna columna', () => {
    const r = resumirIntentos({ a: g(0, 'noresp') }, MAX);
    expect(r).toEqual({ aMedias: 0, agotados: 0, resueltos: 0 });
  });

  it('una fila que no es intento de llamada se ignora', () => {
    const r = resumirIntentos({ a: g(1, 'edicion_orden') }, MAX);
    expect(r).toEqual({ aMedias: 0, agotados: 0, resueltos: 0 });
  });

  it('sin datos no inventa nada', () => {
    expect(resumirIntentos(null, MAX)).toEqual({ aMedias: 0, agotados: 0, resueltos: 0 });
    expect(resumirIntentos(undefined, MAX)).toEqual({ aMedias: 0, agotados: 0, resueltos: 0 });
    expect(resumirIntentos({}, MAX)).toEqual({ aMedias: 0, agotados: 0, resueltos: 0 });
  });

  /** `OrderContext.gestionPorPedido` es un Map, no un objeto plano. */
  it('funciona igual con un Map que con un objeto', () => {
    const mapa = new Map([['a', g(1, 'noresp')], ['b', g(3, 'noresp')]]);
    expect(resumirIntentos(mapa.values(), MAX)).toEqual({ aMedias: 1, agotados: 1, resueltos: 0 });
    expect(resumirIntentos({ a: g(1, 'noresp'), b: g(3, 'noresp') }, MAX))
      .toEqual({ aMedias: 1, agotados: 1, resueltos: 0 });
  });

  it('cuenta una cola mezclada', () => {
    const r = resumirIntentos({
      a: g(1, 'noresp'), b: g(1, 'noresp'), c: g(3, 'noresp'),
      d: g(2, 'conf'), e: g(1, 'canc'), f: g(0, 'noresp'),
    }, MAX);
    expect(r).toEqual({ aMedias: 2, agotados: 1, resueltos: 2 });
  });
});

describe('el texto de la pantalla', () => {
  it('en cero no se dice nada', () => {
    expect(textoIntentosAMedias({ aMedias: 0, agotados: 5, resueltos: 9 })).toBeNull();
  });

  it('singular y plural', () => {
    expect(textoIntentosAMedias({ aMedias: 1, agotados: 0, resueltos: 0 }))
      .toBe('1 pedido quedó con un solo intento');
    expect(textoIntentosAMedias({ aMedias: 8, agotados: 0, resueltos: 0 }))
      .toBe('8 pedidos quedaron con un solo intento');
  });
});
