import { describe, it, expect } from 'vitest';
import { ritmoSeguimiento, RITMO_SEG_META, RITMO_SEG_ALERTA } from './ritmoSeguimiento';
import { RITMO_VIVO_META, RITMO_VIVO_ALERTA } from './ritmoEnVivo';
import { RITMO_META_POR_HORA, RITMO_ALERTA_POR_HORA } from './ritmoTurno';

const AHORA = Date.parse('2026-08-28T18:00:00.000Z');
const haceMin = (m: number) => AHORA - m * 60_000;

describe('ritmoSeguimiento', () => {
  it('la vara es la que eligió el dueño: óptimo 40, rojo bajo 25', () => {
    expect(RITMO_SEG_META).toBe(40);
    expect(RITMO_SEG_ALERTA).toBe(25);
  });

  it('⛔ es MÁS exigente que las dos de Confirmar, a propósito', () => {
    // Si alguien "unifica" las varas, esto se cae y obliga a leer el porqué.
    expect(RITMO_SEG_META).toBeGreaterThan(RITMO_VIVO_META);
    expect(RITMO_SEG_META).toBeGreaterThan(RITMO_META_POR_HORA);
    expect(RITMO_SEG_ALERTA).toBeGreaterThan(RITMO_VIVO_ALERTA);
    expect(RITMO_SEG_ALERTA).toBeGreaterThan(RITMO_ALERTA_POR_HORA);
  });

  it('45 gestiones en 1 h = 45/hora → verde, va al ritmo', () => {
    const r = ritmoSeguimiento({ gestionados: 45, desdeMs: haceMin(60), nowMs: AHORA });
    expect(r.porHora).toBe(45);
    expect(r.vaLento).toBe(false);
    expect(r.bajoOptimo).toBe(false);
  });

  it('30 en 1 h → ámbar: puede ir más rápido, pero no es rojo', () => {
    const r = ritmoSeguimiento({ gestionados: 30, desdeMs: haceMin(60), nowMs: AHORA });
    expect(r.bajoOptimo).toBe(true);
    expect(r.vaLento).toBe(false);
  });

  it('20 en 1 h → rojo', () => {
    const r = ritmoSeguimiento({ gestionados: 20, desdeMs: haceMin(60), nowMs: AHORA });
    expect(r.vaLento).toBe(true);
  });

  it('el caso de ROBERTO: 51 gestiones en 2h 10m ya no es "lento"', () => {
    // Con la vara de llamadas (25/15) su tarjeta decía "3,7 · lento" porque
    // medía sus 51 gestiones contra TODO el día. Con su carril y su reloj:
    const r = ritmoSeguimiento({ gestionados: 51, desdeMs: haceMin(130), nowMs: AHORA });
    expect(r.porHora).toBeCloseTo(23.5, 1);
    expect(r.vaLento).toBe(true); // sigue exigiendo: 23,5 está bajo 25
  });

  it('sin primera marca no se inventa un ritmo', () => {
    const r = ritmoSeguimiento({ gestionados: 51, desdeMs: null, nowMs: AHORA });
    expect(r.porHora).toBeNull();
    expect(r.vaLento).toBe(false);
  });

  it('con pocos minutos trabajados tampoco: 3 en 4 min NO son "45/hora"', () => {
    const r = ritmoSeguimiento({ gestionados: 3, desdeMs: haceMin(4), nowMs: AHORA });
    expect(r.porHora).toBeNull();
  });
});
