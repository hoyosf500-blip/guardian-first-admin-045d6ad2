import { describe, it, expect } from 'vitest';
import { agruparMezcla, porcentajeDificiles, type FilaMezcla } from './mezclaAsesor';

describe('agruparMezcla', () => {
  it('agrupa por asesor y cuenta la mezcla', () => {
    const rows: FilaMezcla[] = [
      { operatorId: 'ana', riesgo: 'mudo' },
      { operatorId: 'ana', riesgo: 'mudo' },
      { operatorId: 'ana', riesgo: 'confirmado' },
      { operatorId: 'ana', riesgo: 'tibio' },
      { operatorId: 'beto', riesgo: 'confirmado' },
      { operatorId: 'beto', riesgo: 'confirmado' },
    ];
    const m = agruparMezcla(rows);
    const ana = m.get('ana')!;
    expect(ana.mudo).toBe(2);
    expect(ana.confirmado).toBe(1);
    expect(ana.tibio).toBe(1);
    expect(ana.total).toBe(4);
    expect(ana.dificiles).toBe(3); // 2 mudo + 1 tibio
    expect(ana.faciles).toBe(1);   // 1 confirmado
    const beto = m.get('beto')!;
    expect(beto.faciles).toBe(2);
    expect(beto.dificiles).toBe(0);
  });

  it('riesgo null → sinSenal, no cuenta como fácil ni difícil', () => {
    const m = agruparMezcla([
      { operatorId: 'x', riesgo: null },
      { operatorId: 'x', riesgo: 'sin_dato' },
      { operatorId: 'x', riesgo: 'mudo' },
    ]);
    const x = m.get('x')!;
    expect(x.sinSenal).toBe(1);
    expect(x.sin_dato).toBe(1);
    expect(x.dificiles).toBe(1);
    expect(x.faciles).toBe(0);
  });

  it('ignora filas sin operatorId', () => {
    const m = agruparMezcla([{ operatorId: '', riesgo: 'mudo' }]);
    expect(m.size).toBe(0);
  });
});

describe('porcentajeDificiles', () => {
  it('ana con 3 difíciles y 1 fácil → 75%', () => {
    const m = agruparMezcla([
      { operatorId: 'ana', riesgo: 'mudo' },
      { operatorId: 'ana', riesgo: 'mudo' },
      { operatorId: 'ana', riesgo: 'tibio' },
      { operatorId: 'ana', riesgo: 'confirmado' },
    ]);
    expect(porcentajeDificiles(m.get('ana')!)).toBe(75);
  });

  it('beto que solo agarró fáciles → 0% (descrema)', () => {
    const m = agruparMezcla([
      { operatorId: 'beto', riesgo: 'confirmado' },
      { operatorId: 'beto', riesgo: 'confirmado' },
    ]);
    expect(porcentajeDificiles(m.get('beto')!)).toBe(0);
  });

  it('sin clasificables (todo sin leer) → null, no se opina', () => {
    const m = agruparMezcla([
      { operatorId: 'c', riesgo: 'sin_dato' },
      { operatorId: 'c', riesgo: null },
    ]);
    expect(porcentajeDificiles(m.get('c')!)).toBeNull();
  });
});
