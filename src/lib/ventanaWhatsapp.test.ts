import { describe, it, expect } from 'vitest';
import { ventanaWhatsapp, MOTIVO_VENTANA, VENTANA_WA_MS } from './ventanaWhatsapp';
import { plantillasPara } from './plantillasChat';

/**
 * La regla que decide si un mensaje escrito a mano LLEGA o se pierde.
 *
 * Meta solo entrega texto libre dentro de las 24 h del último mensaje DEL
 * CLIENTE. Fuera de esa ventana el mensaje no llega y no hay error visible en
 * ningún lado: la asesora tacha el pedido de su lista convencida de que avisó.
 * Por eso la misma función la usan el botón y el servidor — si discreparan, el
 * botón prometería envíos que después se rechazan.
 */
describe('ventanaWhatsapp', () => {
  const ahora = 1_000 * 3_600_000;

  it('el cliente escribió hace 2 h → se puede escribir', () => {
    const v = ventanaWhatsapp(ahora - 2 * 3_600_000, true, ahora);
    expect(v.estado).toBe('abierta');
    expect(Math.round((v.restanteMs ?? 0) / 3_600_000)).toBe(22);
  });

  it('justo antes del corte sigue abierta; justo después, vencida', () => {
    expect(ventanaWhatsapp(ahora - (VENTANA_WA_MS - 1000), true, ahora).estado).toBe('abierta');
    expect(ventanaWhatsapp(ahora - (VENTANA_WA_MS + 1000), true, ahora).estado).toBe('vencida');
  });

  it('el cliente nunca escribió → nunca hubo ventana (no es lo mismo que vencida)', () => {
    expect(ventanaWhatsapp(null, true, ahora).estado).toBe('nunca_escribio');
  });

  // ⛔ La regla de la casa: sin medición no se afirma. Un chat sin leer NO se
  // trata como "se puede escribir" — se dice que no se sabe.
  it('conversación sin leer → sin_dato, jamás "abierta"', () => {
    expect(ventanaWhatsapp(null, false, ahora).estado).toBe('sin_dato');
    expect(ventanaWhatsapp(ahora - 1000, false, ahora).estado).toBe('sin_dato');
  });

  it('todo estado que no sea abierta explica QUÉ hacer', () => {
    for (const e of ['vencida', 'nunca_escribio', 'sin_dato'] as const) {
      expect(MOTIVO_VENTANA[e].length).toBeGreaterThan(20);
    }
    expect(MOTIVO_VENTANA.abierta).toBe('');
  });
});

describe('plantillasPara — arranques de mensaje por fase', () => {
  it('en oficina habla de la agencia y del riesgo de devolución', () => {
    const p = plantillasPara('PARA RETIRO EN AGENCIA SERVIENTREGA', 'luis');
    expect(p.length).toBeGreaterThan(0);
    expect(p.some((x) => /agencia/i.test(x.texto))).toBe(true);
    expect(p.some((x) => /devuelve/i.test(x.texto))).toBe(true);
  });

  it('usa el PRIMER nombre y lo capitaliza (no grita el nombre completo)', () => {
    expect(plantillasPara('EN REPARTO', 'MARIA ELENA MARTÍNEZ GORDON')[0].texto).toContain('Hola Maria');
  });

  it('sin nombre no escribe "Hola undefined"', () => {
    for (const p of plantillasPara('EN REPARTO', null)) {
      expect(p.texto.startsWith('Hola,')).toBe(true);
      expect(p.texto).not.toMatch(/undefined|null/);
    }
  });

  it('una devolución ofrece rescatar la venta, no despedirse', () => {
    expect(plantillasPara('DEVOLUCION', 'ana').some((x) => /reenv|de nuevo/i.test(x.texto))).toBe(true);
  });

  it('siempre devuelve al menos una opción, aunque el estado sea desconocido', () => {
    expect(plantillasPara('ESTADO_RARO_NUEVO', 'juan').length).toBeGreaterThan(0);
  });
});
