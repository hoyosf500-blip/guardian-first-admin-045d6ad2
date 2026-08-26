import { describe, it, expect } from 'vitest';
import {
  construirScores, semaforoAsesor, motivoSemaforo, diasDelRango, metaGestionesDelRango, META_GESTIONES_DIA,
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
    expect(s.nivelMeta).toBe('optimo');  // 100 >= 90
  });

  it('sin confirmados → tasa null (no 0)', () => {
    const [s] = construirScores([{ ...base, confirmados: 0, devoluciones: 0 }], 90);
    expect(s.tasaDevolucion).toBeNull();
  });

  it('sin pedidos con sello → % en rojo null (no 0)', () => {
    const [s] = construirScores([{ ...base, despachadosConSello: 0, despachadosEnRojo: 0 }], 90);
    expect(s.pctEnRojo).toBeNull();
  });

  it('meta en TRES niveles: <60% lento · 60-100% aceptable · ≥100% óptimo', () => {
    // meta óptimo 90 → alerta = 54 (60%).
    expect(construirScores([{ ...base, gestionados: 50 }], 90)[0].nivelMeta).toBe('lento');
    expect(construirScores([{ ...base, gestionados: 60 }], 90)[0].nivelMeta).toBe('aceptable');
    expect(construirScores([{ ...base, gestionados: 90 }], 90)[0].nivelMeta).toBe('optimo');
  });

  it('ordena: los LENTOS (bajo la alerta) primero, luego por tasa desc', () => {
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
  it('lento (bajo la alerta) → rojo', () => {
    expect(semaforoAsesor(mk({ nivelMeta: 'lento' }))).toBe('rojo');
  });
  it('aceptable (bajo el óptimo) → ámbar', () => {
    expect(semaforoAsesor(mk({ nivelMeta: 'aceptable', tasaDevolucion: 3, pctEnRojo: 5 }))).toBe('ambar');
  });
  it('tasa devolución alta → rojo', () => {
    expect(semaforoAsesor(mk({ tasaDevolucion: 20 }))).toBe('rojo');
  });
  it('% en rojo alto con base suficiente → rojo', () => {
    expect(semaforoAsesor(mk({ pctEnRojo: 40, despachadosConSello: 10 }))).toBe('rojo');
  });
  it('% en rojo alto pero POCA base (sello reciente) → NO rojo por eso', () => {
    const s = mk({ pctEnRojo: 40, despachadosConSello: 3, tasaDevolucion: 5, nivelMeta: 'optimo' });
    expect(semaforoAsesor(s)).toBe('verde');
  });
  it('tasa en banda de alerta → ámbar', () => {
    expect(semaforoAsesor(mk({ tasaDevolucion: 12, nivelMeta: 'optimo' }))).toBe('ambar');
  });
  it('todo bien → verde', () => {
    expect(semaforoAsesor(mk({ tasaDevolucion: 3, pctEnRojo: 5, nivelMeta: 'optimo' }))).toBe('verde');
  });
});

describe('motivoSemaforo', () => {
  const mk = (over: Partial<AsesorScore>): AsesorScore =>
    ({ ...construirScores([base], 90)[0], ...over });

  it('verde → sin motivo (null)', () => {
    expect(motivoSemaforo(mk({ tasaDevolucion: 3, pctEnRojo: 5, nivelMeta: 'optimo' }))).toBeNull();
  });
  it('neutro → sin motivo (null)', () => {
    expect(motivoSemaforo(mk({ gestionados: 0, confirmados: 0 }))).toBeNull();
  });
  it('lento → dice que va lento', () => {
    expect(motivoSemaforo(mk({ nivelMeta: 'lento' }))).toContain('va lento');
  });
  it('tasa alta → dice mucha devolución', () => {
    expect(motivoSemaforo(mk({ tasaDevolucion: 20, nivelMeta: 'optimo', pctEnRojo: 5 }))).toContain('devolución');
  });
  it('% en rojo alto con base → dice direcciones malas', () => {
    expect(motivoSemaforo(mk({ pctEnRojo: 40, despachadosConSello: 10, tasaDevolucion: 3, nivelMeta: 'optimo' })))
      .toContain('direcciones malas');
  });
  it('ámbar por bajo el óptimo → lo dice', () => {
    expect(motivoSemaforo(mk({ nivelMeta: 'aceptable', tasaDevolucion: 3, pctEnRojo: 5 }))).toContain('bajo el óptimo');
  });
});

describe('metaGestionesDelRango', () => {
  it('today se prorratea al turno transcurrido', () => {
    expect(metaGestionesDelRango('today', 0.5)).toBe(Math.round(META_GESTIONES_DIA * 0.5));
    expect(metaGestionesDelRango('today', 0)).toBe(0);
    expect(metaGestionesDelRango('today', 1)).toBe(META_GESTIONES_DIA);
  });
  it('today clampa fracciones fuera de rango', () => {
    expect(metaGestionesDelRango('today', 2)).toBe(META_GESTIONES_DIA);
    expect(metaGestionesDelRango('today', -1)).toBe(0);
  });
  it('7d/30d usan la meta completa (días cerrados)', () => {
    expect(metaGestionesDelRango('7d')).toBe(META_GESTIONES_DIA * 7);
    expect(metaGestionesDelRango('30d')).toBe(META_GESTIONES_DIA * 30);
  });
});

describe('META_GESTIONES_DIA', () => {
  it('es una meta orientativa positiva', () => {
    expect(META_GESTIONES_DIA).toBeGreaterThan(0);
  });
});
