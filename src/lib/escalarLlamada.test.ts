import { describe, it, expect } from 'vitest';
import {
  tocaLlamar, minutosParaLlamar, contarTocaLlamar, esTerminal, faseExigeRespuesta,
  HORAS_PARA_LLAMAR, MS_PARA_LLAMAR,
} from './escalarLlamada';
import type { ActividadChatOrden } from './actividadChat';

const AHORA = Date.parse('2026-08-28T18:00:00.000Z');
const haceH = (h: number) => AHORA - h * 3_600_000;

const act = (o: Partial<ActividadChatOrden>): ActividadChatOrden => ({
  salienteAt: null, salienteTipo: null, entranteAt: null, leidoAt: AHORA, ...o,
});

describe('tocaLlamar', () => {
  it('le escribimos hace 7 h y nunca contestó → toca llamar', () => {
    expect(tocaLlamar(act({ salienteAt: haceH(7) }), 'EN OFICINA', AHORA)).toBe(true);
  });

  it('le escribimos hace 5 h → todavía no (la espera son 6 h)', () => {
    expect(tocaLlamar(act({ salienteAt: haceH(5) }), 'EN OFICINA', AHORA)).toBe(false);
  });

  it('justo a las 6 h ya cuenta — el límite es inclusivo', () => {
    expect(tocaLlamar(act({ salienteAt: AHORA - MS_PARA_LLAMAR }), 'EN OFICINA', AHORA)).toBe(true);
  });

  it('contestó ANTES y desde nuestro último mensaje no dijo nada → toca llamar', () => {
    // Es el caso que más se pasa por alto: hubo conversación, así que "sin
    // respuesta" a secas no lo atrapa. Pero la pelota quedó del lado del cliente.
    expect(tocaLlamar(act({ salienteAt: haceH(8), entranteAt: haceH(20) }), 'EN OFICINA', AHORA)).toBe(true);
  });

  it('el cliente habló DESPUÉS → NO es llamada: está esperando respuesta nuestra', () => {
    // Ese pedido va a la lista de "te escribieron y nadie contestó", que es más
    // urgente. Contarlo en las dos partiría el mismo trabajo en dos números.
    expect(tocaLlamar(act({ salienteAt: haceH(8), entranteAt: haceH(1) }), 'EN OFICINA', AHORA)).toBe(false);
  });

  it('nunca se le escribió → NO es llamada, le falta el primer aviso', () => {
    expect(tocaLlamar(act({ entranteAt: haceH(30) }), 'EN OFICINA', AHORA)).toBe(false);
  });

  it('⛔ sin actividad leída NO se afirma que no contestó', () => {
    // No saber ≠ saber que no. Mandaría a llamar a alguien que quizá ya
    // respondió, con su mensaje sin leer.
    expect(tocaLlamar(null, 'EN OFICINA', AHORA)).toBe(false);
    expect(tocaLlamar(undefined, 'EN OFICINA', AHORA)).toBe(false);
  });

  it('un pedido ya terminado no se llama', () => {
    const a = act({ salienteAt: haceH(30) });
    expect(tocaLlamar(a, 'ENTREGADO', AHORA)).toBe(false);
    expect(tocaLlamar(a, 'CANCELADO', AHORA)).toBe(false);
    expect(tocaLlamar(a, 'ARCHIVADO GHOST', AHORA)).toBe(false);
    expect(tocaLlamar(a, 'archivado_ghost', AHORA)).toBe(false);
  });

  it('la espera es la que eligió el dueño', () => {
    expect(HORAS_PARA_LLAMAR).toBe(6);
  });

  it('⛔ solo donde el silencio DUELE: al que va en camino no se lo llama', () => {
    // Medido en pantalla el 28-ago-2026: sin este filtro la cola daba **353**
    // pedidos, o sea el tablero entero de Ecuador. A quien le avisamos "su
    // pedido ya tiene guía" no le pedimos nada — su silencio es lo normal, y
    // una cola de 353 se ignora entera, con los 30 que sí importaban adentro.
    const a = act({ salienteAt: haceH(9) });
    for (const estado of ['GUIA GENERADA', 'EN TRANSITO', 'EN PROCESAMIENTO', 'EN BODEGA TRANSPORTADORA']) {
      expect(tocaLlamar(a, estado, AHORA), `${estado} no debería pedir llamada`).toBe(false);
    }
    // Las que sí: el pedido NO avanza hasta que el cliente conteste.
    for (const estado of ['EN OFICINA', 'NOVEDAD', 'EN REPARTO', 'DEVOLUCION', 'RECHAZADO']) {
      expect(tocaLlamar(a, estado, AHORA), `${estado} sí debería pedir llamada`).toBe(true);
    }
  });
});

describe('faseExigeRespuesta', () => {
  it('son exactamente las fases que terminan en devolución si el cliente no responde', () => {
    expect(faseExigeRespuesta('EN OFICINA')).toBe(true);
    expect(faseExigeRespuesta('NOVEDAD SOLUCIONADA')).toBe(true);
    expect(faseExigeRespuesta('DEVOLUCION EN TRANSITO')).toBe(true);
    expect(faseExigeRespuesta('EN TRANSITO')).toBe(false);
    expect(faseExigeRespuesta('ENTREGADO')).toBe(false);
    expect(faseExigeRespuesta(null)).toBe(false);
  });
});

describe('esTerminal', () => {
  it('normaliza espacios, mayúsculas y las dos escrituras del fantasma', () => {
    expect(esTerminal(' entregado ')).toBe(true);
    expect(esTerminal('ARCHIVADO_GHOST')).toBe(true);
    expect(esTerminal('ARCHIVADO GHOST')).toBe(true);
    expect(esTerminal('EN OFICINA')).toBe(false);
    expect(esTerminal(null)).toBe(false);
  });
});

describe('minutosParaLlamar', () => {
  it('dice cuánto falta, para que el pedido no desaparezca sin decir cuándo vuelve', () => {
    expect(minutosParaLlamar(act({ salienteAt: haceH(5) }), 'EN OFICINA', AHORA)).toBe(60);
  });

  it('ya vencido → 0, nunca negativo', () => {
    expect(minutosParaLlamar(act({ salienteAt: haceH(30) }), 'EN OFICINA', AHORA)).toBe(0);
  });

  it('null cuando no aplica (sin mensaje, o el cliente ya respondió)', () => {
    expect(minutosParaLlamar(act({}), 'EN OFICINA', AHORA)).toBeNull();
    expect(minutosParaLlamar(act({ salienteAt: haceH(8), entranteAt: haceH(1) }), 'EN OFICINA', AHORA)).toBeNull();
    expect(minutosParaLlamar(null, 'EN OFICINA', AHORA)).toBeNull();
  });
});

describe('contarTocaLlamar', () => {
  it('cuenta con la MISMA regla que decide el botón de la tarjeta', () => {
    const pedidos = [
      { a: act({ salienteAt: haceH(9) }), e: 'EN OFICINA' },   // sí
      { a: act({ salienteAt: haceH(2) }), e: 'EN OFICINA' },   // muy pronto
      { a: null,                          e: 'EN OFICINA' },   // sin dato
      { a: act({ salienteAt: haceH(9) }), e: 'ENTREGADO' },    // terminado
      { a: act({ salienteAt: haceH(9), entranteAt: haceH(1) }), e: 'NOVEDAD' }, // esperando respuesta nuestra
    ];
    expect(contarTocaLlamar(pedidos, (p) => p.a, (p) => p.e, AHORA)).toBe(1);
  });

  it('lista vacía → 0 (no explota)', () => {
    expect(contarTocaLlamar([], () => null, () => null, AHORA)).toBe(0);
  });
});
