import { describe, it, expect } from 'vitest';
import { avisoAntesDeConfirmar } from './confirmarSinDuplicar';
import type { ActiveDupAlert } from './orderAlerts';

const enCola = (id: string): ActiveDupAlert =>
  ({ externalId: id, estado: 'PENDIENTE CONFIRMACION', fecha: null, source: 'cola' });
const enDropi = (id: string, estado = 'EN TRANSITO'): ActiveDupAlert =>
  ({ externalId: id, estado, fecha: null, source: 'dropi' });

describe('antes de confirmar, cuando el cliente tiene otro pedido', () => {
  /**
   * ⛔ EL CASO DEL DUEÑO (3-sep-2026): *"le dio en confirmar y se duplica"*.
   * Dos PENDIENTE CONFIRMACION del mismo teléfono en la misma cola. El chip ya
   * existía; lo que faltaba era que algo la frenara.
   */
  it('dos pedidos por confirmar del mismo cliente FRENAN la confirmación', () => {
    const r = avisoAntesDeConfirmar([enCola('86142163')]);
    expect(r.frena).toBe(true);
    expect(r.detalle).toContain('86142163');
    expect(r.detalle).toContain('por confirmar');
  });

  it('un pedido ya despachado del mismo cliente también frena', () => {
    const r = avisoAntesDeConfirmar([enDropi('86118300', 'EN TRANSITO')]);
    expect(r.frena).toBe(true);
    expect(r.detalle.toLowerCase()).toContain('en transito');
  });

  it('sin gemelos no molesta a nadie', () => {
    expect(avisoAntesDeConfirmar([]).frena).toBe(false);
    expect(avisoAntesDeConfirmar(null).frena).toBe(false);
    expect(avisoAntesDeConfirmar(undefined).frena).toBe(false);
  });

  /**
   * ⛔ NO SE PREGUNTA DOS VECES. Un cliente puede comprar dos veces de verdad;
   * una vez que ella miró y decidió, la respuesta vale. Repreguntar enseña a
   * apretar "sí" sin leer, y eso deja el candado peor que no tenerlo.
   */
  it('si ya decidió por este pedido, no se vuelve a preguntar', () => {
    expect(avisoAntesDeConfirmar([enCola('1')], true).frena).toBe(false);
  });

  it('los de la cola se nombran primero: son los que despachan dos veces', () => {
    const r = avisoAntesDeConfirmar([enDropi('999'), enCola('111')]);
    expect(r.gemelos[0].externalId).toBe('111');
  });

  it('con muchos no escupe una lista infinita', () => {
    const r = avisoAntesDeConfirmar(['a', 'b', 'c', 'd', 'e'].map(enCola));
    expect(r.detalle).toContain('y 2 más');
    expect(r.titulo).toContain('5 pedidos');
  });

  it('una alerta sin número de pedido no frena nada', () => {
    expect(avisoAntesDeConfirmar([{ ...enCola(''), externalId: '' }]).frena).toBe(false);
  });

  /** El texto tiene que decir QUÉ está en juego, no solo que hay un duplicado. */
  it('explica la consecuencia real: dos guías, dos fletes', () => {
    expect(avisoAntesDeConfirmar([enCola('1')]).detalle).toMatch(/guía|flete/i);
  });
});
