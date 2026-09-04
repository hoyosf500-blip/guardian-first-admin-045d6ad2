import { describe, it, expect } from 'vitest';
import {
  MARGEN_ATENDIDA_MS, motivoLegible, necesitaPersona, promesaSigueAbierta, unaPorPedido,
  type PromesaCruda,
} from './promesasPendientes';

const T = Date.parse('2026-09-03T19:57:00Z');
const promesa = (p: Partial<PromesaCruda> = {}): PromesaCruda => ({
  externalId: '6844273', phone: '981506421', at: T, motivo: 'la promesa no era sobre el envío', ...p,
});

describe('qué omisión del robot es trabajo para una persona', () => {
  it('los motivos reales de la noche del 3-sep: prometió y no pudo contestar', () => {
    expect(necesitaPersona('la promesa no era sobre el envío')).toBe(true);
    expect(necesitaPersona('el cliente preguntó hace más de 6 h')).toBe(true);
    expect(necesitaPersona('la promesa no responde a ningún mensaje del cliente')).toBe(true);
    expect(necesitaPersona('derivar a humano (desconocido)')).toBe(true);
    expect(necesitaPersona('pedido ambiguo')).toBe(true);
    expect(necesitaPersona('ventana 26 h sin mensaje del cliente')).toBe(true);
  });

  it('no entra el ruido: el chat que siguió solo, el fallo técnico ni el chat sin pedido', () => {
    expect(necesitaPersona('el chat siguió después del disparador (cliente a las …)')).toBe(false);
    expect(necesitaPersona('hilo vacío al releer')).toBe(false);
    expect(necesitaPersona('pedido sin_vivos')).toBe(false);
    expect(necesitaPersona('pedido sin_pedidos')).toBe(false);
    expect(necesitaPersona('')).toBe(false);
    expect(necesitaPersona(null)).toBe(false);
  });

  it('un motivo desconocido NO se cuela: la cola con ruido se deja de mirar', () => {
    expect(necesitaPersona('algo que el responder invente mañana')).toBe(false);
  });
});

describe('la promesa se cae de la lista cuando alguien la cumplió', () => {
  it('sigue abierta si nadie escribió después', () => {
    expect(promesaSigueAbierta(promesa(), { salienteAt: T, entranteAt: T - 60_000 })).toBe(true);
  });

  it('el eco del propio mensaje que promete NO la da por atendida', () => {
    expect(promesaSigueAbierta(promesa(), { salienteAt: T + 30_000, entranteAt: null })).toBe(true);
    expect(promesaSigueAbierta(promesa(), { salienteAt: T + MARGEN_ATENDIDA_MS + 1, entranteAt: null })).toBe(false);
  });

  it('si una persona escribió después, se cierra', () => {
    expect(promesaSigueAbierta(promesa(), { salienteAt: T + 3_600_000, entranteAt: null })).toBe(false);
  });

  it('si el cliente volvió a escribir, se cierra: ya está en «Nos escribieron» y no se trabaja dos veces', () => {
    expect(promesaSigueAbierta(promesa(), { salienteAt: T, entranteAt: T + 120_000 })).toBe(false);
  });

  it('sin dato de chat sigue abierta: no saber no es haber contestado', () => {
    expect(promesaSigueAbierta(promesa(), { salienteAt: null, entranteAt: null })).toBe(true);
  });

  it('un motivo que no es para una persona nunca entra, aunque nadie haya contestado', () => {
    expect(promesaSigueAbierta(promesa({ motivo: 'pedido sin_vivos' }), { salienteAt: null, entranteAt: null })).toBe(false);
  });
});

describe('una fila por cliente, el que lleva más esperando arriba', () => {
  it('del mismo pedido queda la promesa más nueva', () => {
    const out = unaPorPedido([
      promesa({ at: T }),
      promesa({ at: T + 600_000, motivo: 'pedido ambiguo' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].motivo).toBe('pedido ambiguo');
  });

  it('ordena del más viejo al más nuevo', () => {
    const out = unaPorPedido([
      promesa({ externalId: 'B', at: T + 60_000 }),
      promesa({ externalId: 'A', at: T }),
      promesa({ externalId: 'C', at: T + 120_000 }),
    ]);
    expect(out.map((p) => p.externalId)).toEqual(['A', 'B', 'C']);
  });

  it('una promesa sin número de pedido no se muestra: no habría ficha que abrir', () => {
    expect(unaPorPedido([promesa({ externalId: '' })])).toHaveLength(0);
  });
});

describe('el motivo se dice en el idioma de la asesora', () => {
  it('cada caso tiene su frase, y ninguna es jerga del robot', () => {
    expect(motivoLegible('la promesa no era sobre el envío')).toBe('El bot prometió que alguien le escribe');
    expect(motivoLegible('ventana 30 h')).toBe('Pasaron 24 h: solo entra una plantilla');
    expect(motivoLegible('pedido ambiguo')).toBe('Tiene más de un pedido vivo');
    expect(motivoLegible('lo que sea')).toBe('El bot prometió y nadie volvió');
    for (const m of ['la promesa no era sobre el envío', 'ventana 30 h', 'pedido ambiguo', 'derivar a humano (novedad)']) {
      expect(motivoLegible(m)).not.toMatch(/_|disparador|veto|null/);
    }
  });
});
