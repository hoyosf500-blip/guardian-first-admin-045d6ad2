import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollWhenVisible } from './pollWhenVisible';
import { _reiniciarParaPruebas } from './frenoBase';

/**
 * `runOnVisible` dispara `fn` en CADA vuelta a la pestaña. Con el piso
 * (`pisoVisibleMs`) solo dispara si la última corrida es más vieja que el piso:
 * una asesora que alterna con WhatsApp cada 20 s no recarga todo Seguimiento
 * veinte veces por hora (5-sep-2026).
 */

function ponerVisibilidad(estado: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: estado, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('pollWhenVisible — piso al volver a la pestaña', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _reiniciarParaPruebas();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sin piso, cada vuelta a la pestaña corre fn (comportamiento de siempre)', () => {
    const fn = vi.fn();
    const parar = pollWhenVisible(fn, 15 * 60_000, { runOnVisible: true });
    ponerVisibilidad('hidden');
    ponerVisibilidad('visible');
    ponerVisibilidad('hidden');
    ponerVisibilidad('visible');
    expect(fn).toHaveBeenCalledTimes(2);
    parar();
  });

  it('con piso, volver antes del piso NO corre fn; volver después sí, y UNA vez', () => {
    const fn = vi.fn();
    const parar = pollWhenVisible(fn, 15 * 60_000, { runOnVisible: true, pisoVisibleMs: 5 * 60_000 });
    // Diez idas y vueltas en un minuto: cero recargas.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(6_000);
      ponerVisibilidad('hidden');
      ponerVisibilidad('visible');
    }
    expect(fn).toHaveBeenCalledTimes(0);
    // Pasan cinco minutos más: la próxima vuelta sí recarga.
    vi.advanceTimersByTime(5 * 60_000);
    ponerVisibilidad('hidden');
    ponerVisibilidad('visible');
    expect(fn).toHaveBeenCalledTimes(1);
    // Y la que sigue enseguida, no.
    ponerVisibilidad('hidden');
    ponerVisibilidad('visible');
    expect(fn).toHaveBeenCalledTimes(1);
    parar();
  });

  it('el piso no toca el intervalo: el tick periódico sigue saliendo', () => {
    const fn = vi.fn();
    const parar = pollWhenVisible(fn, 60_000, { runOnVisible: true, pisoVisibleMs: 10 * 60_000 });
    vi.advanceTimersByTime(3 * 60_000 + 1);
    expect(fn).toHaveBeenCalledTimes(3);
    parar();
  });

  it('el tick periódico también cuenta como corrida para el piso', () => {
    const fn = vi.fn();
    const parar = pollWhenVisible(fn, 60_000, { runOnVisible: true, pisoVisibleMs: 2 * 60_000 });
    vi.advanceTimersByTime(60_000 + 1); // tick a los 60 s
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);     // 30 s después del tick: volver no recarga
    ponerVisibilidad('hidden');
    ponerVisibilidad('visible');
    expect(fn).toHaveBeenCalledTimes(1);
    parar();
  });
});
