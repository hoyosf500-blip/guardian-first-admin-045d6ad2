import { describe, it, expect } from 'vitest';
import {
  msEnPantalla,
  esSalto,
  saltoSinMirar,
  duracionLegible,
  SALTO_SIN_MIRAR_MS,
  NOMBRE_EVENTO,
} from './eventosPedido';

describe('cuánto estuvo el pedido a la vista', () => {
  it('mide la diferencia en milisegundos', () => {
    expect(msEnPantalla(1_000, 4_500)).toBe(3_500);
  });

  /**
   * ⛔ LA REGLA MÁS IMPORTANTE DE TODO ESTE MÓDULO.
   *
   * Este número se va a leer para decidir sobre una persona: "estuvo cero
   * segundos en el pedido" es una acusación. Si no se pudo medir —porque se
   * cerró la pestaña de golpe y nunca hubo marca de apertura— tiene que decir
   * "no se midió", no "cero". Es el mismo error que en esta operación ya hizo
   * que una pantalla afirmara "no hubo cancelaciones" sobre un mes con 345.
   */
  it('sin marca de apertura devuelve null, NUNCA cero', () => {
    expect(msEnPantalla(null, Date.now())).toBeNull();
    expect(msEnPantalla(undefined, Date.now())).toBeNull();
    expect(msEnPantalla(NaN, Date.now())).toBeNull();
  });

  it('un reloj que va para atrás no inventa una duración', () => {
    // Cambio de hora, reloj del sistema corregido: no se afirma nada.
    expect(msEnPantalla(9_000, 1_000)).toBeNull();
  });

  it('cero medido de verdad SÍ es cero', () => {
    expect(msEnPantalla(5_000, 5_000)).toBe(0);
  });
});

describe('¿fue un salto o fue trabajo?', () => {
  it('sin ninguna gestión mientras estuvo abierto, es un salto', () => {
    expect(esSalto(0)).toBe(true);
  });

  it('con una sola gestión ya no es un salto', () => {
    expect(esSalto(1)).toBe(false);
    expect(esSalto(5)).toBe(false);
  });
});

describe('el salto que ni se miró', () => {
  it('debajo del umbral se marca; encima no se afirma nada', () => {
    expect(saltoSinMirar(SALTO_SIN_MIRAR_MS - 1)).toBe(true);
    expect(saltoSinMirar(SALTO_SIN_MIRAR_MS)).toBe(false);
    expect(saltoSinMirar(30_000)).toBe(false);
  });

  /** No haber podido medir no puede leerse como "pasó de largo". */
  it('sin medición NO se acusa', () => {
    expect(saltoSinMirar(null)).toBe(false);
  });

  it('el umbral es bajo a propósito: 2 s no alcanzan para leer una novedad', () => {
    expect(SALTO_SIN_MIRAR_MS).toBeLessThanOrEqual(3_000);
  });
});

describe('la duración se lee sin traducir', () => {
  it('segundos, minutos y minutos con segundos', () => {
    expect(duracionLegible(8_400)).toBe('8 s');
    expect(duracionLegible(120_000)).toBe('2 min');
    expect(duracionLegible(134_000)).toBe('2 min 14 s');
  });

  it('sin medición dice "—", no "0 s"', () => {
    expect(duracionLegible(null)).toBe('—');
  });
});

describe('el vocabulario está completo', () => {
  /** Un evento sin nombre saldría en pantalla como su clave cruda (`salto`), y
   *  eso lo lee alguien que no programó esto. */
  it('todo evento tiene texto para la pantalla', () => {
    for (const [clave, texto] of Object.entries(NOMBRE_EVENTO)) {
      expect(texto.length, `«${clave}» sin texto legible`).toBeGreaterThan(3);
      expect(texto).not.toBe(clave);
    }
  });
});
