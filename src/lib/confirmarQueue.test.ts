import { describe, it, expect } from 'vitest';
import {
  compareConfirmar,
  splitCalientesVsViejos,
  cooldownHoursForAttempt,
  effectiveAgeDays,
  realAgeDays,
  isFreshToday,
  hasDueReminder,
  estaAplazado,
  REMIND_LOOKAHEAD_MS,
  isRetryReady,
  resumenSinRespuestaHoy,
  mismoResumen,
  MAX_DAILY_ATTEMPTS,
  COOLDOWN_MINUTES,
  COOLDOWN_LABEL,
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

  it('11) REGRESIÓN: zombie backfilleado (dias alto, createdAt reciente) NO flota sobre un fresco real', () => {
    // El zombie de hace 30 días fue re-insertado hoy → created_at ≈ hace 5 min,
    // pero su edad REAL en Dropi es 30 días. NO debe colarse al bucket "fresco".
    const zombie = ord({ id: 'zombie', createdAt: hoursAgo(0.08), dias: 30 });
    // Comprador genuinamente nuevo: entró hace 2 h (createdAt MÁS viejo que el zombie).
    const nuevo = ord({ id: 'nuevo', createdAt: hoursAgo(2), dias: 0 });
    // Con el bug (bucket por createdAt) el zombie iba PRIMERO; ahora manda la edad real.
    expect(sortIds([zombie, nuevo])).toEqual(['nuevo', 'zombie']);
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

describe('cooldownHoursForAttempt (plano — regla del dueño)', () => {
  const ESPERADO = COOLDOWN_MINUTES / 60;

  it('el intervalo es el MISMO en todos los intentos (no hay escalera)', () => {
    expect(cooldownHoursForAttempt(1)).toBe(ESPERADO);
    expect(cooldownHoursForAttempt(2)).toBe(ESPERADO);
    expect(cooldownHoursForAttempt(3)).toBe(ESPERADO);
    expect(cooldownHoursForAttempt(4)).toBe(ESPERADO);
  });

  it('robusto ante valores raros o ausentes', () => {
    expect(cooldownHoursForAttempt(0)).toBe(ESPERADO);
    expect(cooldownHoursForAttempt(-3)).toBe(ESPERADO);
    expect(cooldownHoursForAttempt(NaN)).toBe(ESPERADO);
    expect(cooldownHoursForAttempt(undefined)).toBe(ESPERADO);
  });

  // La regla de negocio, no el número: los 3 intentos tienen que caber en la
  // jornada de 8 a 5. Si alguien sube el intervalo sin pensar en el horario,
  // este test lo frena — con 90 min el último pedido que alcanza los 3 entra a
  // las 14:00, y con 120 min a las 13:00.
  it('con la jornada 8-17, los 3 intentos caben para quien entra hasta las 15:00', () => {
    const ultimaEntradaQueAlcanza = 17 - 2 * (COOLDOWN_MINUTES / 60);
    expect(ultimaEntradaQueAlcanza).toBeGreaterThanOrEqual(15);
  });

  it('el rótulo de pantalla concuerda con la regla', () => {
    expect(COOLDOWN_LABEL).toBe('1 hora');
  });
});

describe('helpers puros', () => {
  it('effectiveAgeDays: usa createdAt con hora, clamp a 0 para futuro', () => {
    expect(effectiveAgeDays(ord({ createdAt: hoursAgo(24), dias: 99 }), NOW)).toBeCloseTo(1, 5);
    expect(effectiveAgeDays(ord({ createdAt: hoursAgo(-5), dias: 0 }), NOW)).toBe(0); // futuro → 0
    expect(effectiveAgeDays(ord({ dias: 3 }), NOW)).toBe(3);
  });

  it('realAgeDays: manda `dias` (edad Dropi) por sobre createdAt reciente', () => {
    // Zombie backfilleado: createdAt=hace 1h pero dias=30 → edad real 30, no 0.04.
    expect(realAgeDays(ord({ createdAt: hoursAgo(1), dias: 30 }), NOW)).toBe(30);
    // Sin `dias`: cae a createdAt (día completo).
    expect(realAgeDays(ord({ createdAt: hoursAgo(48) }), NOW)).toBeCloseTo(2, 5);
    // Sin nada → 0.
    expect(realAgeDays(ord({}), NOW)).toBe(0);
    // `dias` en 0 es válido (no cae al fallback de createdAt).
    expect(realAgeDays(ord({ createdAt: daysAgo(9), dias: 0 }), NOW)).toBe(0);
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

describe('resumenSinRespuestaHoy — los que "no aparecen" después de no contestar', () => {
  const HOY = '2026-07-31';
  const AHORA = Date.parse('2026-07-31T21:00:00Z'); // 16:00 Bogotá
  const hace = (horas: number) => new Date(AHORA - horas * 3600000).toISOString();
  const f = (phone: string, horasAtras: number, result = 'noresp', order_id = `o-${phone}`) =>
    ({ order_id, phone, result, result_date: HOY, created_at: hace(horasAtras) });

  it('sin filas devuelve todo en cero', () => {
    expect(resumenSinRespuestaHoy([], HOY, AHORA).total).toBe(0);
    expect(resumenSinRespuestaHoy(null, HOY, AHORA).total).toBe(0);
  });

  it('separa listos de los que siguen enfriando', () => {
    const r = resumenSinRespuestaHoy([
      f('111', 3),   // hace 3h → ya cumplió el enfriamiento
      f('222', 0.5), // hace 30 min → todavía enfriando
    ], HOY, AHORA);
    expect(r).toMatchObject({ total: 2, listos: 1, enfriando: 1, agotados: 0 });
  });

  it('dice en cuántos minutos vuelve el PRÓXIMO', () => {
    // El que llamaron hace 1.5h vuelve en 30 min; el de hace 0.5h en 90.
    const r = resumenSinRespuestaHoy([f('111', 1.5), f('222', 0.5)], HOY, AHORA);
    expect(r.proximoEnMinutos).toBe(30);
  });

  it('con 3 intentos queda AGOTADO y no promete llamadas', () => {
    const r = resumenSinRespuestaHoy([f('111', 6), f('111', 4), f('111', 2)], HOY, AHORA);
    expect(r).toMatchObject({ total: 1, agotados: 1, listos: 0, enfriando: 0, llamadasDisponibles: 0 });
  });

  it('cuenta las llamadas que quedan sin usar (1 intento → 2 disponibles)', () => {
    const r = resumenSinRespuestaHoy([f('111', 3), f('222', 3), f('222', 1)], HOY, AHORA);
    expect(r.llamadasDisponibles).toBe(3); // 111 le quedan 2, 222 le queda 1
  });

  it('agrupa por TELÉFONO igual que el tope del sistema, no por pedido', () => {
    // Mismo cliente con dos pedidos: son llamadas a la MISMA persona. Contarlas
    // por pedido diría "le quedan 2 a cada uno" y el sistema no las va a dar.
    const r = resumenSinRespuestaHoy([
      { order_id: 'A', phone: '111', result: 'noresp', result_date: HOY, created_at: hace(3) },
      { order_id: 'B', phone: '111', result: 'noresp', result_date: HOY, created_at: hace(2) },
    ], HOY, AHORA);
    expect(r.total).toBe(1);
    expect(r.llamadasDisponibles).toBe(1);
  });

  it('un pedido que DESPUÉS se confirmó ya no cuenta como sin respuesta', () => {
    const r = resumenSinRespuestaHoy([
      f('111', 3), { order_id: 'o-111', phone: '111', result: 'conf', result_date: HOY, created_at: hace(1) },
    ], HOY, AHORA);
    expect(r.total).toBe(0);
  });

  it('ignora los de días anteriores', () => {
    expect(resumenSinRespuestaHoy([
      { order_id: 'x', phone: '111', result: 'noresp', result_date: '2026-07-30', created_at: hace(30) },
    ], HOY, AHORA).total).toBe(0);
  });

  it('una fecha corrupta no rompe el resumen', () => {
    const r = resumenSinRespuestaHoy([
      { order_id: 'x', phone: '111', result: 'noresp', result_date: HOY, created_at: 'no-es-fecha' },
    ], HOY, AHORA);
    expect(r.total).toBe(0);
  });

  // Caso REAL de Ecuador el 31-jul-2026: el panel decía "35 para llamar ya" y
  // la cola entregaba 31. Los 4 de diferencia estaban CANCELADOS en Dropi —
  // cancelación que no pasa por el CRM y por eso no deja fila en order_results.
  // Sin la lista de pedidos vivos el resumen no tiene forma de enterarse.
  it('no cuenta al que no contestó si su pedido ya está cancelado en Dropi', () => {
    const filas = [f('111', 3), f('222', 3)];
    // Sin saber cuáles viven, los cuenta a los dos (no inventa muertes).
    expect(resumenSinRespuestaHoy(filas, HOY, AHORA).listos).toBe(2);
    // Sabiendo que el pedido de '222' ya no está pendiente, solo queda uno.
    const vivos = new Set(['o-111']);
    const r = resumenSinRespuestaHoy(filas, HOY, AHORA, vivos);
    expect(r.total).toBe(1);
    expect(r.listos).toBe(1);
    expect(r.llamadasDisponibles).toBe(MAX_DAILY_ATTEMPTS - 1);
  });

  it('una lista de vivos vacía deja el panel en cero, no lo ignora', () => {
    const r = resumenSinRespuestaHoy([f('111', 3)], HOY, AHORA, new Set<string>());
    expect(r.total).toBe(0);
  });

  // Por qué existe el ticker de 60s en OrderContext: este resumen cambia SOLO
  // porque pasa el tiempo, sin que nadie toque nada. Calculado una única vez al
  // cargar, el cartel "el próximo en 12 min" seguía diciendo 12 media hora
  // después y "para llamar ya" no crecía nunca.
  it('con el paso del tiempo un "enfriando" se vuelve "listo" sin filas nuevas', () => {
    const filas = [f('111', 0.5)]; // llamado hace 30 min
    const ahora = resumenSinRespuestaHoy(filas, HOY, AHORA);
    expect(ahora.enfriando).toBe(1);
    expect(ahora.listos).toBe(0);
    expect(ahora.proximoEnMinutos).toBe(30);

    // Media hora más tarde, LAS MISMAS filas ya dicen otra cosa.
    const luego = resumenSinRespuestaHoy(filas, HOY, AHORA + 31 * 60_000);
    expect(luego.enfriando).toBe(0);
    expect(luego.listos).toBe(1);
    expect(luego.proximoEnMinutos).toBeNull();
  });
});

describe('mismoResumen — no re-renderizar la cola 1.440 veces al día', () => {
  const base = {
    total: 5, listos: 2, enfriando: 3, agotados: 0,
    proximoEnMinutos: 12, llamadasDisponibles: 9,
  };

  it('dos resúmenes idénticos son iguales aunque sean objetos distintos', () => {
    expect(mismoResumen(base, { ...base })).toBe(true);
  });

  it('detecta el cambio de la cuenta regresiva', () => {
    expect(mismoResumen(base, { ...base, proximoEnMinutos: 11 })).toBe(false);
  });

  it('detecta que alguien cruzó el enfriamiento', () => {
    expect(mismoResumen(base, { ...base, listos: 3, enfriando: 2 })).toBe(false);
  });

  it('null contra un resumen real NO es igual — es el primer dato', () => {
    expect(mismoResumen(null, base)).toBe(false);
    expect(mismoResumen(base, null)).toBe(false);
    expect(mismoResumen(null, null)).toBe(true);
  });
});

describe('estaAplazado — el pedido reagendado sale de la cola de hoy', () => {
  const AHORA = Date.parse('2026-08-15T15:00:00-05:00');
  const enHoras = (h: number) => new Date(AHORA + h * 3600_000).toISOString();

  it('un recordatorio a días vista aplaza el pedido', () => {
    expect(estaAplazado({ nextReminderAt: enHoras(48) }, AHORA)).toBe(true);
  });

  it('sin recordatorio NO está aplazado', () => {
    expect(estaAplazado({}, AHORA)).toBe(false);
    expect(estaAplazado({ nextReminderAt: null }, AHORA)).toBe(false);
  });

  it('un recordatorio ya vencido NO aplaza: hay que llamarlo YA', () => {
    expect(estaAplazado({ nextReminderAt: enHoras(-3) }, AHORA)).toBe(false);
  });

  it('dentro de la ventana de 1 h tampoco aplaza — se trabaja hoy', () => {
    // Esta es la frontera que evita el agujero: si "aplazado" y "recordatorio
    // próximo" no compartieran el mismo número, un pedido podría quedar fuera
    // de Pendientes Y fuera del chip de recordatorios al mismo tiempo.
    expect(estaAplazado({ nextReminderAt: enHoras(0.5) }, AHORA)).toBe(false);
    expect(hasDueReminder({ nextReminderAt: enHoras(0.5) }, AHORA, REMIND_LOOKAHEAD_MS)).toBe(true);
  });

  it('justo en el borde de la ventana no aplaza (comparación estricta)', () => {
    const borde = new Date(AHORA + REMIND_LOOKAHEAD_MS).toISOString();
    expect(estaAplazado({ nextReminderAt: borde }, AHORA)).toBe(false);
  });

  it('un pedido YA resuelto nunca está aplazado: ya terminó', () => {
    expect(estaAplazado({ nextReminderAt: enHoras(48), result: 'conf' }, AHORA)).toBe(false);
    expect(estaAplazado({ nextReminderAt: enHoras(48), result: 'canc' }, AHORA)).toBe(false);
  });

  it('una fecha corrupta no esconde el pedido', () => {
    // Ante la duda, MOSTRAR: perder un pedido de la cola es peor que verlo de más.
    expect(estaAplazado({ nextReminderAt: 'no-es-fecha' }, AHORA)).toBe(false);
  });
});

describe('la cola ordena por lo que hizo el cliente, no por la antigüedad', () => {
  // La antigüedad, medida contra el reloj real, no distingue nada dentro del
  // primer día (agosto-2026 EC, 765 pedidos resueltos): <2 h 19,3%, 2-6 h
  // 18,4%, 6-24 h 20,1%. El botón parte esa misma población en 10,4% y 57,7%.
  const AHORA = Date.parse('2026-08-21T15:00:00Z');
  const hoy = (h: number) => new Date(AHORA - h * 3600_000).toISOString();

  it('dentro del día, el que no apretó el botón sube por encima del que ya confirmó', () => {
    // Este es el caso que importa: la jornada de la asesora transcurre casi
    // entera dentro de los pedidos de hoy, y ahí la hora de entrada no dice
    // nada (19,3% vs 20,1%) mientras el botón dice todo (10,4% vs 57,7%).
    const entroTempranoSinBoton = { dias: 0, createdAt: hoy(9), riesgoChat: 'frio' as const };
    const entroReciénYaConfirmó = { dias: 0, createdAt: hoy(1), riesgoChat: 'confirmado' as const };
    expect(compareConfirmar(entroTempranoSinBoton, entroReciénYaConfirmó, AHORA)).toBeLessThan(0);
  });

  it('el riesgo ordena DENTRO del bucket, no lo atraviesa', () => {
    // Límite conocido y deliberado: los buckets de `bucketOf` (recordatorio,
    // reintento, frescura, D4+ al fondo) siguen mandando. El dato los respalda
    // en lo grueso —dentro del día 20%, pasadas 24 h 36%— y cambiarlos sería
    // una decisión de negocio distinta, no un ajuste de orden. Si algún día se
    // quiere que un 'frío' viejo le gane a un 'confirmado' de hoy, hay que
    // tocar `bucketOf` a propósito y esta prueba lo va a avisar.
    const viejoFrio = { dias: 2, createdAt: hoy(40), riesgoChat: 'frio' as const };
    const nuevoConfirmado = { dias: 0, createdAt: hoy(1), riesgoChat: 'confirmado' as const };
    expect(compareConfirmar(viejoFrio, nuevoConfirmado, AHORA)).toBeGreaterThan(0);
  });

  it('el orden completo es mudo → frío → tibio → sin leer → ya confirmó', () => {
    const mk = (r: string) => ({ dias: 0, createdAt: hoy(2), riesgoChat: r as never });
    const orden = ['confirmado', 'sin_dato', 'tibio', 'frio', 'mudo']
      .map(mk)
      .sort((a, b) => compareConfirmar(a, b, AHORA))
      .map((o) => o.riesgoChat);
    expect(orden).toEqual(['mudo', 'frio', 'tibio', 'sin_dato', 'confirmado']);
  });

  it('sin señal la cola se comporta EXACTAMENTE como antes', () => {
    // Es la garantía de que prender esto no mueve el piso hasta que haya datos.
    const a = { dias: 0, createdAt: hoy(1) };
    const b = { dias: 0, createdAt: hoy(5) };
    expect(Math.sign(compareConfirmar(a, b, AHORA))).toBe(
      Math.sign(compareConfirmar({ ...a, riesgoChat: null }, { ...b, riesgoChat: null }, AHORA)),
    );
    expect(compareConfirmar(a, b, AHORA)).toBeLessThan(0); // el más nuevo primero
  });

  it('un pedido sin señal no se hunde debajo de uno ya confirmado', () => {
    // `null` es neutro, no "lo peor". Si se hundiera, prender la sincronización
    // a medias mandaría al fondo justo a los que todavía nadie miró.
    const sinSenal = { dias: 0, createdAt: hoy(3) };
    const confirmado = { dias: 0, createdAt: hoy(3), riesgoChat: 'confirmado' as const };
    expect(compareConfirmar(sinSenal, confirmado, AHORA)).toBeLessThan(0);
  });

  it('el riesgo NO le gana a un recordatorio vencido', () => {
    // Reagendar es una promesa al cliente: "te llamo el viernes". Esa promesa
    // manda sobre cualquier score.
    const conRecordatorio = { dias: 0, createdAt: hoy(2), nextReminderAt: new Date(AHORA - 60_000).toISOString(), riesgoChat: 'confirmado' as const };
    const frio = { dias: 0, createdAt: hoy(2), riesgoChat: 'frio' as const };
    expect(compareConfirmar(conRecordatorio, frio, AHORA)).toBeLessThan(0);
  });
});
