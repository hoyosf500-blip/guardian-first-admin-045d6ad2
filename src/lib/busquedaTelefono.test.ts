import { describe, it, expect } from 'vitest';
import { pareceTelefono, variantesDeBusqueda, fusionarResultados, MIN_DIGITOS_TELEFONO } from './busquedaTelefono';

describe('el caso que lo motivó: #6853503, Néstor Isaías Ayme', () => {
  it('⛔ el cliente escribe con cero inicial y el pedido está guardado sin él', () => {
    // Lo que la asesora copia y pega del chat.
    const v = variantesDeBusqueda('0986255535');
    // La cruda va primero: la búsqueda que hoy funciona no cambia.
    expect(v[0]).toBe('0986255535');
    // Y la canónica es SUBCADENA de como está guardado ('986255535'), así que
    // el LIKE de la RPC ahora sí lo encuentra.
    expect(v[1]).toBe('986255535');
    expect('986255535'.includes(v[1])).toBe(true);
  });

  it('escrito como ya funcionaba, NO se dispara una segunda consulta', () => {
    expect(variantesDeBusqueda('986255535')).toEqual(['986255535']);
  });

  it('con +593 y con espacios también llega a la misma forma', () => {
    expect(variantesDeBusqueda('+593 98 625 5535')[1]).toBe('986255535');
    expect(variantesDeBusqueda('593986255535')[1]).toBe('986255535');
  });
});

describe('Colombia no se rompe: la canónica sigue siendo subcadena', () => {
  it('un móvil colombiano guardado con 10 dígitos se encuentra igual', () => {
    const v = variantesDeBusqueda('3143048595');
    expect(v[1]).toBe('143048595');
    // Es lo que hace que el LIKE siga funcionando pese a perder el 3.
    expect('3143048595'.includes(v[1])).toBe(true);
  });

  it('con indicativo +57 también', () => {
    expect('3143048595'.includes(variantesDeBusqueda('+573143048595')[1])).toBe(true);
  });
});

describe('lo que NO es un teléfono no se toca', () => {
  it('un nombre se busca tal cual, una sola vez', () => {
    expect(variantesDeBusqueda('Johana Guerra')).toEqual(['Johana Guerra']);
    expect(pareceTelefono('Johana Guerra')).toBe(false);
  });

  it('un número de pedido corto no se normaliza', () => {
    expect(pareceTelefono('685494')).toBe(false); // 6 dígitos < mínimo
    expect(variantesDeBusqueda('685494')).toEqual(['685494']);
  });

  it('un external_id de 7 dígitos SÍ parece teléfono, pero la canónica no cambia nada', () => {
    // 7 dígitos: pasa el filtro, y `normalizePhone` lo devuelve igual porque ya
    // tiene menos de 9. Una sola consulta, como antes.
    expect(pareceTelefono('6853503')).toBe(true);
    expect(variantesDeBusqueda('6853503')).toEqual(['6853503']);
  });

  it('una guía con letras no entra por la rama de teléfono', () => {
    expect(pareceTelefono('LAAR-99182')).toBe(false);
    expect(pareceTelefono('AB1234567')).toBe(false);
  });

  it('el vacío no genera ninguna consulta', () => {
    expect(variantesDeBusqueda('')).toEqual([]);
    expect(variantesDeBusqueda('   ')).toEqual([]);
  });

  it('el mínimo de dígitos es el declarado, no un número escondido', () => {
    expect(pareceTelefono('1'.repeat(MIN_DIGITOS_TELEFONO))).toBe(true);
    expect(pareceTelefono('1'.repeat(MIN_DIGITOS_TELEFONO - 1))).toBe(false);
  });
});

describe('fusionar sin repetir y sin perder', () => {
  const f = (id: string, phone = '') => ({ external_id: id, phone });

  it('el mismo pedido en las dos tandas aparece UNA vez', () => {
    const r = fusionarResultados([[f('1'), f('2')], [f('2'), f('3')]], 50);
    expect(r.map((x) => x.external_id)).toEqual(['1', '2', '3']);
  });

  it('la primera tanda manda en el orden: es la búsqueda que la asesora escribió', () => {
    const r = fusionarResultados([[f('9')], [f('1'), f('2')]], 50);
    expect(r[0].external_id).toBe('9');
  });

  it('respeta el tope y corta ahí', () => {
    const muchos = Array.from({ length: 80 }, (_, i) => f(String(i)));
    expect(fusionarResultados([muchos], 50)).toHaveLength(50);
  });

  it('una tanda vacía o nula no rompe nada', () => {
    expect(fusionarResultados([null, undefined, [f('1')]], 50).map((x) => x.external_id)).toEqual(['1']);
    expect(fusionarResultados([], 50)).toEqual([]);
  });

  it('sin external_id se deduplica por teléfono', () => {
    const a = { external_id: null, phone: '986255535' };
    const r = fusionarResultados([[a], [{ ...a }]], 50);
    expect(r).toHaveLength(1);
  });

  it('⛔ sin external_id NI teléfono la fila pasa: perder un resultado es peor que repetirlo', () => {
    const x = { external_id: null, phone: null };
    expect(fusionarResultados([[x], [{ ...x }]], 50)).toHaveLength(2);
  });
});
