import { describe, it, expect } from 'vitest';
import {
  buildGestionPorPedido,
  mismaGestion,
  horaDeIntento,
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
