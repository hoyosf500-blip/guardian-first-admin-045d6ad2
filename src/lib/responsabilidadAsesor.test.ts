import { describe, it, expect } from 'vitest';
import {
  construirScores, semaforoAsesor, diasDelRango, META_GESTIONES_DIA,
  type AsesorScoreInput, type AsesorScore,
} from './responsabilidadAsesor';

const base: AsesorScoreInput = {
  operatorId: 'a', name: 'Ana', gestionados: 100, confirmados: 40,
  devoluciones: 4, evitables: 2, despachadosConSello: 20, despachadosEnRojo: 2,
};

describe('diasDelRango', () => {
  it('mapea el rango a días', () => {
    expect(diasDelRango('today')).toBe(1);
    expect(diasDelRango('7d')).toBe(7);
    expect(diasDelRango('30d')).toBe(30);
  });
});

describe('construirScores', () => {
  it('calcula tasa de devolución (÷ confirmados) y % en rojo (÷ con sello)', () => {
    const [s] = construirScores([base], 90);
    expect(s.tasaDevolucion).toBe(10);   // 4/40
    expect(s.pctEnRojo).toBe(10);        // 2/20
    expect(s.metaOk).toBe(true);         // 100 >= 90
  });

  it('sin confirmados → tasa null (no 0)', () => {
    const [s] = construirScores([{ ...base, confirmados: 0, devoluciones: 0 }], 90);
    expect(s.tasaDevolucion).toBeNull();
  });

  it('sin pedidos con sello → % en rojo null (no 0)', () => {
    const [s] = construirScores([{ ...base, despachadosConSello: 0, despachadosEnRojo: 0 }], 90);
    expect(s.pctEnRojo).toBeNull();
  });

  it('meta: por debajo → metaOk false', () => {
    const [s] = construirScores([{ ...base, gestionados: 50 }], 90);
    expect(s.metaOk).toBe(false);
  });

  it('ordena: los que no llegan a la meta primero, luego por tasa desc', () => {
    const scores = construirScores([
      { ...base, operatorId: 'buena', name: 'Buena', gestionados: 200, confirmados: 100, devoluciones: 2 },
      { ...base, operatorId: 'floja', name: 'Floja', gestionados: 10, confirmados: 5, devoluciones: 1 },
      { ...base, operatorId: 'sucia', name: 'Sucia', gestionados: 150, confirmados: 40, devoluciones: 12 },
    ], 90);
    // 'floja' no llega a la meta → primero. Luego entre las que sí llegan, 'sucia'
    // (tasa 30%) antes que 'buena' (tasa 2%).
    expect(scores.map((s) => s.operatorId)).toEqual(['floja', 'sucia', 'buena']);
  });
});

describe('semaforoAsesor', () => {
  const mk = (over: Partial<AsesorScore>): AsesorScore =>
    ({ ...construirScores([base], 90)[0], ...over });

  it('sin actividad → neutro', () => {
    expect(semaforoAsesor(mk({ gestionados: 0, confirmados: 0 }))).toBe('neutro');
  });
  it('no llega a la meta → rojo', () => {
    expect(semaforoAsesor(mk({ metaOk: false }))).toBe('rojo');
  });
  it('tasa devolución alta → rojo', () => {
    expect(semaforoAsesor(mk({ tasaDevolucion: 20 }))).toBe('rojo');
  });
  it('% en rojo alto con base suficiente → rojo', () => {
    expect(semaforoAsesor(mk({ pctEnRojo: 40, despachadosConSello: 10 }))).toBe('rojo');
  });
  it('% en rojo alto pero POCA base (sello reciente) → NO rojo por eso', () => {
    const s = mk({ pctEnRojo: 40, despachadosConSello: 3, tasaDevolucion: 5, metaOk: true });
    expect(semaforoAsesor(s)).toBe('verde');
  });
  it('tasa en banda de alerta → ámbar', () => {
    expect(semaforoAsesor(mk({ tasaDevolucion: 12, metaOk: true }))).toBe('ambar');
  });
  it('todo bien → verde', () => {
    expect(semaforoAsesor(mk({ tasaDevolucion: 3, pctEnRojo: 5, metaOk: true }))).toBe('verde');
  });
});

describe('META_GESTIONES_DIA', () => {
  it('es una meta orientativa positiva', () => {
    expect(META_GESTIONES_DIA).toBeGreaterThan(0);
  });
});
