import { describe, it, expect } from 'vitest';
import {
  buildGestionPorPedido,
  buildGestionSegPorTelefono,
  mismaGestion,
  horaDeIntento,
  haceCuanto,
  etiquetaResultado,
  type FilaIntento,
} from './gestionPorPedido';

const HOY = '2026-07-31';
const AYER = '2026-07-30';

const fila = (p: Partial<FilaIntento>): FilaIntento => ({
  order_id: 'ped-1',
  result: 'noresp',
  result_date: HOY,
  created_at: '2026-07-31T14:00:00Z',
  operator_id: 'ana',
  ...p,
});

describe('buildGestionPorPedido', () => {
  it('sin filas devuelve mapa vacío', () => {
    expect(buildGestionPorPedido([], HOY).size).toBe(0);
    expect(buildGestionPorPedido(null, HOY).size).toBe(0);
    expect(buildGestionPorPedido(undefined, HOY).size).toBe(0);
  });

  it('cuenta los intentos del EQUIPO, no de una sola persona', () => {
    // El caso que motivó todo: Ana llamó, no contestaron; después llamó Sofía.
    // Para el dueño son 2 intentos sobre el MISMO pedido.
    const m = buildGestionPorPedido([
      fila({ operator_id: 'ana', created_at: '2026-07-31T14:00:00Z' }),
      fila({ operator_id: 'sofia', created_at: '2026-07-31T16:30:00Z' }),
    ], HOY);
    expect(m.get('ped-1')!.intentos).toBe(2);
    expect(m.get('ped-1')!.ultimoPor).toBe('sofia');
  });

  it('el "último" es el más reciente aunque las filas lleguen desordenadas', () => {
    const m = buildGestionPorPedido([
      fila({ operator_id: 'sofia', created_at: '2026-07-31T16:30:00Z', result: 'conf' }),
      fila({ operator_id: 'ana', created_at: '2026-07-31T14:00:00Z' }),
    ], HOY);
    expect(m.get('ped-1')!.ultimoPor).toBe('sofia');
    expect(m.get('ped-1')!.ultimoResult).toBe('conf');
  });

  it('ignora los intentos de OTROS días', () => {
    // Si contara ayer, un pedido que nadie tocó hoy se vería "ya llamado" y la
    // asesora lo saltaría — venta perdida en silencio.
    const m = buildGestionPorPedido([fila({ result_date: AYER })], HOY);
    expect(m.size).toBe(0);
  });

  it('ignora filas de auditoría: editar un pedido NO es haberlo llamado', () => {
    const m = buildGestionPorPedido([
      fila({ result: 'edicion_orden' }),
      fila({ result: 'cambio_transportadora' }),
    ], HOY);
    expect(m.size).toBe(0);
  });

  it('ignora filas sin order_id (no se pueden atribuir a un pedido)', () => {
    expect(buildGestionPorPedido([fila({ order_id: null })], HOY).size).toBe(0);
  });

  it('separa pedidos distintos', () => {
    const m = buildGestionPorPedido([
      fila({ order_id: 'a' }),
      fila({ order_id: 'b' }),
      fila({ order_id: 'b' }),
    ], HOY);
    expect(m.get('a')!.intentos).toBe(1);
    expect(m.get('b')!.intentos).toBe(2);
  });

  it('una fecha corrupta no gana como "el último" ni rompe el conteo', () => {
    const m = buildGestionPorPedido([
      fila({ operator_id: 'ana', created_at: '2026-07-31T14:00:00Z' }),
      fila({ operator_id: 'basura', created_at: 'no-es-fecha' }),
    ], HOY);
    expect(m.get('ped-1')!.intentos).toBe(2);
    expect(m.get('ped-1')!.ultimoPor).toBe('ana');
  });
});

describe('mismaGestion — evita re-renderizar toda la cola en cada realtime', () => {
  const base = () => buildGestionPorPedido([fila({})], HOY);

  it('dos mapas con el mismo contenido son iguales', () => {
    expect(mismaGestion(base(), base())).toBe(true);
  });

  it('la misma referencia es igual', () => {
    const m = base();
    expect(mismaGestion(m, m)).toBe(true);
  });

  it('un intento más lo detecta', () => {
    const otro = buildGestionPorPedido([fila({}), fila({ created_at: '2026-07-31T15:00:00Z' })], HOY);
    expect(mismaGestion(base(), otro)).toBe(false);
  });

  it('cambio de resultado lo detecta (noresp → conf)', () => {
    const otro = buildGestionPorPedido([fila({ result: 'conf' })], HOY);
    expect(mismaGestion(base(), otro)).toBe(false);
  });

  it('cambio de persona lo detecta', () => {
    const otro = buildGestionPorPedido([fila({ operator_id: 'sofia' })], HOY);
    expect(mismaGestion(base(), otro)).toBe(false);
  });

  it('un motivo corregido lo detecta (si no, no se veia hasta recargar)', () => {
    const otro = buildGestionPorPedido([fila({ reason: 'pidio llamar mañana' })], HOY);
    expect(mismaGestion(base(), otro)).toBe(false);
  });

  it('un pedido nuevo lo detecta', () => {
    const otro = buildGestionPorPedido([fila({}), fila({ order_id: 'ped-2' })], HOY);
    expect(mismaGestion(base(), otro)).toBe(false);
  });
});

describe('horaDeIntento', () => {
  it('devuelve la hora de BOGOTÁ, no la UTC', () => {
    // 19:00 UTC = 14:00 en Bogotá. Mostrar la UTC le diría a la asesora que la
    // llamaron a una hora que no fue.
    expect(horaDeIntento('2026-07-31T19:00:00Z')).toBe('14:00');
  });

  it('fecha corrupta devuelve cadena vacía en vez de "Invalid Date"', () => {
    expect(horaDeIntento('no-es-fecha')).toBe('');
  });
});

describe('buildGestionSegPorTelefono — Seguimiento (la clave es el teléfono)', () => {
  const toque = (p: Partial<import('./gestionPorPedido').FilaToque> = {}) => ({
    phone: '0991234567',
    action: 'SEG: Envié la guía',
    operator_id: 'ana',
    created_at: '2026-07-31T14:00:00Z',
    ...p,
  });

  it('quita el prefijo SEG: y deja el método legible', () => {
    const m = buildGestionSegPorTelefono([toque()]);
    expect(m.get('0991234567')!.ultimoResult).toBe('Envié la guía');
  });

  it('agrupa por teléfono y cuenta las gestiones del equipo', () => {
    const m = buildGestionSegPorTelefono([
      toque({ operator_id: 'ana', created_at: '2026-07-31T14:00:00Z' }),
      toque({ operator_id: 'sofia', created_at: '2026-07-31T17:00:00Z', action: 'SEG: No contestó' }),
      toque({ phone: '0997654321' }),
    ]);
    expect(m.get('0991234567')!.intentos).toBe(2);
    expect(m.get('0991234567')!.ultimoPor).toBe('sofia');
    expect(m.get('0991234567')!.ultimoResult).toBe('No contestó');
    expect(m.get('0997654321')!.intentos).toBe(1);
  });

  it('ignora filas sin teléfono (no se pueden atribuir a un pedido)', () => {
    expect(buildGestionSegPorTelefono([toque({ phone: '' })]).size).toBe(0);
  });

  it('sin filas devuelve mapa vacío', () => {
    expect(buildGestionSegPorTelefono([]).size).toBe(0);
    expect(buildGestionSegPorTelefono(null).size).toBe(0);
  });
});

describe('haceCuanto — "¿hace cuánto la llamaron?"', () => {
  // La hora del reloj obliga a hacer la cuenta mental; a las 9am tampoco dice
  // si fue hoy. Antes de volver a marcar un número lo que importa es el hace.
  const AHORA = Date.parse('2026-07-31T18:00:00Z');

  it.each([
    ['2026-07-31T17:40:00Z', 'hace 20 min'],
    ['2026-07-31T17:01:00Z', 'hace 59 min'],
    ['2026-07-31T17:00:00Z', 'hace 1 h'],
    ['2026-07-31T09:00:00Z', 'hace 9 h'],
    ['2026-07-30T10:00:00Z', 'ayer'],
    ['2026-07-28T10:00:00Z', 'hace 3 días'],
  ])('%s → %s', (iso, esperado) => {
    expect(haceCuanto(iso, AHORA)).toBe(esperado);
  });

  it('menos de un minuto se lee "recién"', () => {
    expect(haceCuanto('2026-07-31T17:59:30Z', AHORA)).toBe('recién');
  });

  it('un reloj adelantado NO muestra "hace -3 min"', () => {
    // Si la PC de la asesora va adelantada, el futuro daría negativo y parecería
    // un error del sistema.
    expect(haceCuanto('2026-07-31T18:03:00Z', AHORA)).toBe('recién');
  });

  it('fecha corrupta devuelve cadena vacía, no "NaN"', () => {
    expect(haceCuanto('no-es-fecha', AHORA)).toBe('');
  });
});

describe('etiquetaResultado — el código interno nunca llega a la pantalla', () => {
  it.each([
    ['conf', 'Confirmó'],
    ['canc', 'Canceló'],
    ['noresp', 'No contestó'],
  ])('%s → %s', (r, esperado) => expect(etiquetaResultado(r)).toBe(esperado));

  it('el método de Seguimiento ya es legible y pasa tal cual', () => {
    expect(etiquetaResultado('Envié la guía')).toBe('Envié la guía');
  });
});

describe('el motivo — "¿y qué dijo el cliente?"', () => {
  it('guarda lo que escribió la asesora en el último intento', () => {
    const m = buildGestionPorPedido([
      fila({ reason: 'pidió llamar mañana', created_at: '2026-07-31T16:00:00Z' }),
    ], HOY);
    expect(m.get('ped-1')!.ultimoMotivo).toBe('pidió llamar mañana');
  });

  it('gana el motivo del intento MÁS RECIENTE', () => {
    const m = buildGestionPorPedido([
      fila({ reason: 'no contesta', created_at: '2026-07-31T14:00:00Z' }),
      fila({ reason: 'dijo que sí, confirma mañana', created_at: '2026-07-31T17:00:00Z', result: 'conf' }),
    ], HOY);
    expect(m.get('ped-1')!.ultimoMotivo).toBe('dijo que sí, confirma mañana');
  });

  it('sin motivo escrito queda en null (la pantalla no inventa texto)', () => {
    expect(buildGestionPorPedido([fila({ reason: null })], HOY).get('ped-1')!.ultimoMotivo).toBeNull();
    expect(buildGestionPorPedido([fila({ reason: '   ' })], HOY).get('ped-1')!.ultimoMotivo).toBeNull();
    expect(buildGestionPorPedido([fila({})], HOY).get('ped-1')!.ultimoMotivo).toBeNull();
  });
});
