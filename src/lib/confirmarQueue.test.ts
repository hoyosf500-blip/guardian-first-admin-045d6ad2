import { describe, it, expect } from 'vitest';
import {
  compareConfirmar,
  splitCalientesVsViejos,
  cooldownHoursForAttempt,
  effectiveAgeDays,
  isFreshToday,
  hasDueReminder,
  isRetryReady,
  DIAS_POR_CANCELAR,
  type ConfirmarQueueOrder,
} from './confirmarQueue';

// "Ahora" fijo para determinismo. 2026-07-02 15:00Z.
const NOW = Date.parse('2026-07-02T15:00:00Z');

// Helpers para construir pedidos mínimos.
const hoursAgo = (h: number) => new Date(NOW - h * 3600000).toISOString();
const daysAgo = (d: number) => new Date(NOW - d * 86400000).toISOString();

function ord(partial: Partial<ConfirmarQueueOrder> & { id?: string }): ConfirmarQueueOrder & { id?: string } {
  return { ...partial };
}

/** Ordena una lista con el comparador y devuelve la lista de ids. */
function sortIds(list: (ConfirmarQueueOrder & { id?: string })[]): (string | undefined)[] {
  return [...list].sort((a, b) => compareConfirmar(a, b, NOW)).map(o => o.id);
}

describe('compareConfirmar', () => {
  it('1) fresco-de-hoy vence a zombie-D7', () => {
    const fresco = ord({ id: 'fresco', createdAt: hoursAgo(0.1), dias: 0 }); // hace 6 min
    const zombie = ord({ id: 'zombie', createdAt: daysAgo(7), dias: 7 });
    expect(sortIds([zombie, fresco])).toEqual(['fresco', 'zombie']);
  });

  it('2) reintento-listo va antes que un fresco de hoy sin reintento', () => {
    const retry = ord({ id: 'retry', createdAt: daysAgo(1), dias: 1, retryCount: 1 });
    const fresco = ord({ id: 'fresco', createdAt: hoursAgo(0.2), dias: 0 });
    expect(sortIds([fresco, retry])).toEqual(['retry', 'fresco']);
  });

  it('3) recordatorio vencido gana a TODO (incluso a un reintento listo)', () => {
    const remind = ord({ id: 'remind', createdAt: daysAgo(3), dias: 3, nextReminderAt: hoursAgo(1) });
    const retry = ord({ id: 'retry', createdAt: hoursAgo(2), dias: 0, retryCount: 1 });
    const fresco = ord({ id: 'fresco', createdAt: hoursAgo(0.1), dias: 0 });
    expect(sortIds([retry, fresco, remind])).toEqual(['remind', 'retry', 'fresco']);
  });

  it('4) dentro de "hoy": el más NUEVO primero', () => {
    const a = ord({ id: 'a', createdAt: hoursAgo(0.1), dias: 0 }); // hace 6 min
    const b = ord({ id: 'b', createdAt: hoursAgo(5), dias: 0 });   // hace 5 h
    const c = ord({ id: 'c', createdAt: hoursAgo(20), dias: 0 });  // hace 20 h
    expect(sortIds([c, a, b])).toEqual(['a', 'b', 'c']);
  });

  it('5) los D4+ ("por cancelar") van AL FINAL, debajo de viejos <D4', () => {
    const fresco = ord({ id: 'fresco', createdAt: hoursAgo(0.1), dias: 0 });
    const viejo3 = ord({ id: 'viejo3', createdAt: daysAgo(3), dias: 3 });
    const cancel5 = ord({ id: 'cancel5', createdAt: daysAgo(5), dias: 5 });
    const cancel9 = ord({ id: 'cancel9', createdAt: daysAgo(9), dias: 9 });
    // fresco < viejo3 < (por cancelar: el más nuevo primero dentro del bucket)
    expect(sortIds([cancel9, viejo3, cancel5, fresco]))
      .toEqual(['fresco', 'viejo3', 'cancel5', 'cancel9']);
  });

  it('6) sin createdAt → fallback a `dias` (más nuevo primero por menor dias)', () => {
    const d0 = ord({ id: 'd0', dias: 0 });
    const d2 = ord({ id: 'd2', dias: 2 });
    const d3 = ord({ id: 'd3', dias: 3 });
    expect(sortIds([d3, d0, d2])).toEqual(['d0', 'd2', 'd3']);
  });

  it('6b) createdAt malformado → cae a `dias` sin romper', () => {
    const bad = ord({ id: 'bad', createdAt: 'no-es-fecha', dias: 0 });
    const good = ord({ id: 'good', createdAt: hoursAgo(10), dias: 0 });
    // bad usa dias=0 → edad 0; good usa createdAt → 10h ≈ 0.42d. bad más nuevo.
    expect(sortIds([good, bad])).toEqual(['bad', 'good']);
  });

  it('7) empates estables: edad idéntica conserva el orden de entrada', () => {
    const iso = hoursAgo(2);
    const a = ord({ id: 'a', createdAt: iso, dias: 0 });
    const b = ord({ id: 'b', createdAt: iso, dias: 0 });
    const c = ord({ id: 'c', createdAt: iso, dias: 0 });
    expect(sortIds([a, b, c])).toEqual(['a', 'b', 'c']);
    expect(sortIds([c, b, a])).toEqual(['c', 'b', 'a']);
    // compareConfirmar devuelve 0 en empate exacto
    expect(compareConfirmar(a, b, NOW)).toBe(0);
  });

  it('8) lista vacía → no explota', () => {
    expect([].sort((a, b) => compareConfirmar(a, b, NOW))).toEqual([]);
  });

  it('9) todos viejos (D4+) → orden estable por frescura, ninguno se pierde', () => {
    const c4 = ord({ id: 'c4', dias: 4 });
    const c6 = ord({ id: 'c6', dias: 6 });
    const c10 = ord({ id: 'c10', dias: 10 });
    expect(sortIds([c10, c4, c6])).toEqual(['c4', 'c6', 'c10']);
  });

  it('10) escenario mixto completo respeta la jerarquía de buckets', () => {
    const list = [
      ord({ id: 'cancel8', dias: 8 }),
      ord({ id: 'fresco', createdAt: hoursAgo(0.5), dias: 0 }),
      ord({ id: 'remind', createdAt: daysAgo(2), dias: 2, nextReminderAt: hoursAgo(0.5) }),
      ord({ id: 'viejo2', createdAt: daysAgo(2), dias: 2 }),
      ord({ id: 'retry', createdAt: daysAgo(1), dias: 1, retryCount: 2 }),
    ];
    expect(sortIds(list)).toEqual(['remind', 'retry', 'fresco', 'viejo2', 'cancel8']);
  });
});

describe('splitCalientesVsViejos', () => {
  it('separa calientes (recordatorio/retry/hoy) de los D4+ por cancelar', () => {
    const list = [
      ord({ id: 'cancel5', dias: 5 }),
      ord({ id: 'fresco', createdAt: hoursAgo(0.1), dias: 0 }),
      ord({ id: 'retry', createdAt: daysAgo(1), dias: 1, retryCount: 1 }),
      ord({ id: 'viejo2', dias: 2 }),
    ];
    const { calientes, porCancelar } = splitCalientesVsViejos(list, NOW);
    // calientes ordenados: retry (bucket 1) > fresco (2) > viejo2 (3, no D4)
    expect(calientes.map(o => o.id)).toEqual(['retry', 'fresco', 'viejo2']);
    expect(porCancelar.map(o => o.id)).toEqual(['cancel5']);
  });

  it('no muta la lista de entrada', () => {
    const list = [ord({ id: 'a', dias: 5 }), ord({ id: 'b', dias: 0 })];
    const snapshot = list.map(o => o.id);
    splitCalientesVsViejos(list, NOW);
    expect(list.map(o => o.id)).toEqual(snapshot);
  });

  it('lista vacía → dos arrays vacíos', () => {
    const { calientes, porCancelar } = splitCalientesVsViejos([], NOW);
    expect(calientes).toEqual([]);
    expect(porCancelar).toEqual([]);
  });
});

describe('cooldownHoursForAttempt (2h plano — regla del dueño)', () => {
  it('todos los intentos → 2h (llamó 10 → vuelve 12 → 14)', () => {
    expect(cooldownHoursForAttempt(1)).toBe(2);
    expect(cooldownHoursForAttempt(2)).toBe(2);
    expect(cooldownHoursForAttempt(3)).toBe(2);
    expect(cooldownHoursForAttempt(4)).toBe(2);
  });
  it('robusto ante valores raros o ausentes (sigue 2h)', () => {
    expect(cooldownHoursForAttempt(0)).toBe(2);
    expect(cooldownHoursForAttempt(-3)).toBe(2);
    expect(cooldownHoursForAttempt(NaN)).toBe(2);
    expect(cooldownHoursForAttempt(undefined)).toBe(2);
  });
});

describe('helpers puros', () => {
  it('effectiveAgeDays: usa createdAt con hora, clamp a 0 para futuro', () => {
    expect(effectiveAgeDays(ord({ createdAt: hoursAgo(24), dias: 99 }), NOW)).toBeCloseTo(1, 5);
    expect(effectiveAgeDays(ord({ createdAt: hoursAgo(-5), dias: 0 }), NOW)).toBe(0); // futuro → 0
    expect(effectiveAgeDays(ord({ dias: 3 }), NOW)).toBe(3);
  });

  it('isFreshToday: <1 día efectivo', () => {
    expect(isFreshToday(ord({ createdAt: hoursAgo(23), dias: 0 }), NOW)).toBe(true);
    expect(isFreshToday(ord({ createdAt: hoursAgo(25), dias: 1 }), NOW)).toBe(false);
    expect(isFreshToday(ord({ dias: 0 }), NOW)).toBe(true);
    expect(isFreshToday(ord({ dias: 1 }), NOW)).toBe(false);
  });

  it('hasDueReminder: vencido true, futuro false, malformado/ausente false', () => {
    expect(hasDueReminder(ord({ nextReminderAt: hoursAgo(1) }), NOW)).toBe(true);
    expect(hasDueReminder(ord({ nextReminderAt: hoursAgo(-2) }), NOW)).toBe(false);
    expect(hasDueReminder(ord({ nextReminderAt: 'basura' }), NOW)).toBe(false);
    expect(hasDueReminder(ord({}), NOW)).toBe(false);
    // lookahead: un recordatorio que vence en 30 min entra con lookahead de 1h
    expect(hasDueReminder(ord({ nextReminderAt: hoursAgo(-0.5) }), NOW, 3600000)).toBe(true);
  });

  it('isRetryReady: retryCount>0 y sin result', () => {
    expect(isRetryReady(ord({ retryCount: 1 }))).toBe(true);
    expect(isRetryReady(ord({ retryCount: 1, result: 'conf' }))).toBe(false);
    expect(isRetryReady(ord({ retryCount: 0 }))).toBe(false);
    expect(isRetryReady(ord({}))).toBe(false);
  });

  it('DIAS_POR_CANCELAR = 4', () => {
    expect(DIAS_POR_CANCELAR).toBe(4);
  });
});
