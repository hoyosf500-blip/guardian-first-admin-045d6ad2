import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { crearRefetchConPiso } from './refetchConPiso';
import { registrarRespuesta, _reiniciarParaPruebas } from './frenoBase';

describe('crearRefetchConPiso — el refetch de realtime con piso y con freno', () => {
  beforeEach(() => { vi.useFakeTimers(); _reiniciarParaPruebas(() => Date.now()); });
  afterEach(() => { vi.useRealTimers(); _reiniciarParaPruebas(); });

  it('la primera vez sale enseguida', () => {
    const fn = vi.fn();
    const r = crearRefetchConPiso(fn, 20_000);
    r.pedir();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('una ráfaga de 50 gestiones en 10 s es UNA sola recarga más, no 50', () => {
    const fn = vi.fn();
    const r = crearRefetchConPiso(fn, 20_000);
    r.pedir(); vi.advanceTimersByTime(1);           // la primera, inmediata
    for (let i = 0; i < 50; i++) { r.pedir(); vi.advanceTimersByTime(200); }
    expect(fn).toHaveBeenCalledTimes(1);            // todavía dentro del piso
    vi.advanceTimersByTime(20_000);
    expect(fn).toHaveBeenCalledTimes(2);            // una sola salida agrupada
  });

  it('respeta el piso desde la ÚLTIMA salida, no desde el último pedido (throttle, no debounce)', () => {
    const fn = vi.fn();
    const r = crearRefetchConPiso(fn, 10_000);
    r.pedir(); vi.advanceTimersByTime(1);           // sale en t≈0; el reloj queda en t=1
    vi.advanceTimersByTime(6_000);                  // t=6001
    r.pedir();                                      // piso desde la salida: vence en t=10000
    vi.advanceTimersByTime(3_998);                  // t=9999: todavía no
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);                      // t=10001: ya
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('con el freno abierto NO sale: se posterga un piso y sale cuando la base respira', () => {
    const fn = vi.fn();
    const r = crearRefetchConPiso(fn, 5_000);
    // Abrir el freno: 3 síntomas
    for (let i = 0; i < 3; i++) registrarRespuesta({ ms: 10, status: 503 });
    r.pedir();
    vi.advanceTimersByTime(5_100);
    expect(fn).toHaveBeenCalledTimes(0);            // abierto: esperó
    vi.advanceTimersByTime(45_000);                 // el freno se cierra a los 45 s
    vi.advanceTimersByTime(5_100);                  // y el siguiente intento sale
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancelar limpia lo pendiente (cleanup del efecto)', () => {
    const fn = vi.fn();
    const r = crearRefetchConPiso(fn, 5_000);
    r.pedir(); vi.advanceTimersByTime(1);
    r.pedir();
    r.cancelar();
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
