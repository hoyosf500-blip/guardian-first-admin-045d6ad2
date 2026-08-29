import { describe, it, expect } from 'vitest';
import { deriveStatus, estaColgada, GRACIA_RUNNING_MIN, type CorridaSync } from './useImporchatSyncHealth';

describe('deriveStatus — salud del sync de ImporChat', () => {
  it('sin corridas = never (gris, no verde)', () => {
    expect(deriveStatus(null)).toBe('never');
  });

  it('corrió hace poco y sin error = fresh', () => {
    expect(deriveStatus(1, 'success')).toBe('fresh');
    expect(deriveStatus(0.2, 'warn')).toBe('fresh'); // warn no es error
  });

  it('una corrida fallida manda sobre la frescura (aunque sea de hace 5 min)', () => {
    expect(deriveStatus(0.1, 'error')).toBe('failing');
  });

  it('3h a 12h sin correr = stale (amarillo)', () => {
    expect(deriveStatus(5, 'success')).toBe('stale');
  });

  it('más de 12h sin correr = critical (el inbound puede estar muerto)', () => {
    expect(deriveStatus(20, 'success')).toBe('critical');
  });
});

describe('⛔ corridas COLGADAS — el caso medido en producción el 28-ago-2026', () => {
  const corrida = (status: string, edadMin: number): CorridaSync => ({ status, edadMin });

  it('una corrida en «running» que no cerró NO es una corrida sana', () => {
    expect(estaColgada(corrida('running', GRACIA_RUNNING_MIN + 1))).toBe(true);
  });

  it('una que acaba de arrancar NO se acusa: está en vuelo', () => {
    expect(estaColgada(corrida('running', 1))).toBe(false);
    expect(estaColgada(corrida('success', 999))).toBe(false);
  });

  it('EL BUG: el último success tapaba cuatro cuelgues seguidos y el badge salía VERDE', () => {
    // Datos reales de Ecuador (sync_logs, 28-ago-2026 21:16 Bogotá): la corrida
    // de las 02:12 UTC terminó con 119 pedidos, y las cuatro anteriores —00:12,
    // 00:42, 01:12, 01:42— quedaron en «running» bajando el XLSX. Dos horas
    // seguidas sin dato nuevo del chat, y la pantalla en verde.
    const reales: CorridaSync[] = [
      corrida('success', 4),
      corrida('running', 34),
      corrida('running', 64),
      corrida('running', 94),
      corrida('running', 124),
      corrida('success', 184),
    ];
    // Lo que hacía antes, mirando solo la última fila:
    expect(deriveStatus(0.07, 'success')).toBe('fresh');
    // Lo que hace ahora:
    expect(deriveStatus(0.07, 'success', reales)).toBe('failing');
  });

  it('sin cuelgues, un sync sano sigue en verde (no se vuelve alarmista)', () => {
    const sanas: CorridaSync[] = [
      corrida('success', 4), corrida('success', 34), corrida('running', 2),
    ];
    expect(deriveStatus(0.07, 'success', sanas)).toBe('fresh');
  });

  it('sin la lista de corridas se comporta EXACTAMENTE como antes', () => {
    // El parámetro es opcional a propósito: ningún llamador viejo cambia.
    expect(deriveStatus(1, 'success')).toBe('fresh');
    expect(deriveStatus(0.1, 'error')).toBe('failing');
    expect(deriveStatus(null)).toBe('never');
  });

  it('un error explícito sigue mandando sobre todo lo demás', () => {
    expect(deriveStatus(0.1, 'error', [corrida('success', 1)])).toBe('failing');
  });
});
