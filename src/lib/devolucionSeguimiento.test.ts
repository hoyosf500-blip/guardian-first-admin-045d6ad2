import { describe, it, expect } from 'vitest';
import { normalizarTel, resumirDevolucionSeguimiento } from './devolucionSeguimiento';

describe('normalizarTel', () => {
  it('toma los últimos 9 dígitos', () => {
    expect(normalizarTel('593987654321')).toBe('987654321');
    expect(normalizarTel('+57 300 123 4567')).toBe('001234567');
  });
  it('teléfonos cortos quedan tal cual', () => {
    expect(normalizarTel('12345')).toBe('12345');
  });
  it('sin dígitos → cadena vacía', () => {
    expect(normalizarTel(null)).toBe('');
    expect(normalizarTel('sin numero')).toBe('');
  });
  it('mismo número con y sin prefijo colapsa', () => {
    expect(normalizarTel('0987654321')).toBe(normalizarTel('593987654321'));
  });
});

describe('resumirDevolucionSeguimiento', () => {
  it('atribuye cada devuelto a quien lo gestionó en SEG', () => {
    const r = resumirDevolucionSeguimiento(
      [
        { phone: '0987654321', valor: 100 },
        { phone: '0911111111', valor: 50 },
      ],
      [
        { phone: '593987654321', operator_id: 'ana' },  // matchea el 1ro por últimos 9
        { phone: '0911111111', operator_id: 'ana' },
      ],
      [],
    );
    expect(r.total).toBe(2);
    expect(r.valorTotal).toBe(150);
    expect(r.sinGestionSeg).toBe(0);
    expect(r.porGestor).toEqual([{ operatorId: 'ana', devueltos: 2, valor: 150 }]);
  });

  it('un devuelto que nadie tocó cae en sinGestionSeg (cobertura)', () => {
    const r = resumirDevolucionSeguimiento(
      [
        { phone: '0987654321', valor: 100 },
        { phone: '0922222222', valor: 80 },
      ],
      [{ phone: '0987654321', operator_id: 'ana' }],
      [],
    );
    expect(r.sinGestionSeg).toBe(1);
    expect(r.valorSinGestion).toBe(80);
    expect(r.porGestor).toEqual([{ operatorId: 'ana', devueltos: 1, valor: 100 }]);
  });

  it('atribución COMPARTIDA: dos operadoras que lo tocaron cuentan ambas', () => {
    const r = resumirDevolucionSeguimiento(
      [{ phone: '0987654321', valor: 100 }],
      [
        { phone: '0987654321', operator_id: 'ana' },
        { phone: '0987654321', operator_id: 'beto' },
      ],
      [],
    );
    expect(r.porGestor).toHaveLength(2);
    expect(r.porGestor.every((g) => g.devueltos === 1 && g.valor === 100)).toBe(true);
  });

  it('ignora touchpoints de admins (auditoría no cuenta como gestión)', () => {
    const r = resumirDevolucionSeguimiento(
      [{ phone: '0987654321', valor: 100 }],
      [{ phone: '0987654321', operator_id: 'fabian' }],
      ['fabian'],
    );
    expect(r.sinGestionSeg).toBe(1);
    expect(r.porGestor).toEqual([]);
  });

  it('ordena el ranking desc por cantidad y luego por valor', () => {
    const r = resumirDevolucionSeguimiento(
      [
        { phone: '0900000001', valor: 10 },
        { phone: '0900000002', valor: 10 },
        { phone: '0900000003', valor: 999 },
      ],
      [
        { phone: '0900000001', operator_id: 'ana' },
        { phone: '0900000002', operator_id: 'ana' },
        { phone: '0900000003', operator_id: 'beto' },
      ],
      [],
    );
    expect(r.porGestor.map((g) => g.operatorId)).toEqual(['ana', 'beto']);
  });

  it('valor nulo cuenta como 0, no rompe', () => {
    const r = resumirDevolucionSeguimiento(
      [{ phone: '0900000001', valor: null }],
      [{ phone: '0900000001', operator_id: 'ana' }],
      [],
    );
    expect(r.valorTotal).toBe(0);
    expect(r.porGestor[0].valor).toBe(0);
  });
});
