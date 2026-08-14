import { describe, it, expect } from 'vitest';
import { splitNovedades } from './novedadesSplit';

const q = (ids: (string | null | undefined)[]) => ids.map((externalId, i) => ({ externalId, i }));

describe('splitNovedades', () => {
  it('openIds null (edge caída / función vieja) → todo a porGestionar, sin separar', () => {
    const queue = q(['1', '2', '3']);
    const r = splitNovedades(queue, null);
    expect(r.conocido).toBe(false);
    expect(r.porGestionar).toHaveLength(3);
    expect(r.esperando).toHaveLength(0);
  });

  it('separa por pertenencia al set de incidencias abiertas', () => {
    const queue = q(['10', '20', '30', '40']);
    const r = splitNovedades(queue, new Set(['10', '30']));
    expect(r.conocido).toBe(true);
    expect(r.porGestionar.map(o => o.externalId)).toEqual(['10', '30']);
    expect(r.esperando.map(o => o.externalId)).toEqual(['20', '40']);
  });

  // H1 (auditoría 14-ago-2026): "cero incidencias abiertas con N novedades en
  // cola" no se distingue de "Dropi cambió un literal y la consulta devuelve 0
  // con HTTP 200". Antes esto separaba con conocido:true y TODA la cola caía a
  // "Esperando transportadora" con check verde — trabajo real escondido.
  it('set vacío CON cola no-vacía → sospechoso: NO se separa (todo visible como pendiente)', () => {
    const r = splitNovedades(q(['1', '2']), new Set());
    expect(r.conocido).toBe(false);
    expect(r.porGestionar).toHaveLength(2);
    expect(r.esperando).toHaveLength(0);
  });

  it('set vacío con cola vacía → sin nada que decidir, el split vacío es legítimo', () => {
    const r = splitNovedades(q([]), new Set());
    expect(r.conocido).toBe(true);
    expect(r.porGestionar).toHaveLength(0);
    expect(r.esperando).toHaveLength(0);
  });

  it('pedido sin externalId nunca puede matchear → esperando', () => {
    const r = splitNovedades(q([null, undefined, '5']), new Set(['5']));
    expect(r.porGestionar.map(o => o.externalId)).toEqual(['5']);
    expect(r.esperando).toHaveLength(2);
  });

  it('ids que Dropi lista pero no están en la cola local se ignoran (sync atrasado)', () => {
    const r = splitNovedades(q(['1']), new Set(['1', '999']));
    expect(r.porGestionar).toHaveLength(1);
    expect(r.esperando).toHaveLength(0);
  });
});
