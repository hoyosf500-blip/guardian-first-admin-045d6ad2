import { describe, it, expect } from 'vitest';
import {
  resumirPorProducto,
  claveProducto,
  MIN_RESUELTOS_PRODUCTO,
  UMBRAL_HERMANAS_PUNTOS,
  EMPTY_POR_PRODUCTO,
  type ProductoCrudo,
} from './cancelacionesPorProducto';

const p = (o: Partial<ProductoCrudo> & { producto: string; generados: number; cancelados: number }): ProductoCrudo => ({
  entregados: 0, devueltos: 0, pendientes: 0, enCurso: 0,
  valorGenerado: 0, valorCancelado: 0,
  ...o,
});

// Los cinco productos reales de agosto-2026 en Ecuador, con sus cifras medidas.
// No son fixtures inventados: si el cálculo cambia, esta prueba lo dice contra
// números que ya se auditaron contra la base.
const AGOSTO_EC: ProductoCrudo[] = [
  p({ producto: 'GAFAS BLUETOOH PR', generados: 403, cancelados: 109, pendientes: 18, valorCancelado: 3456 }),
  p({ producto: 'EJERCITADOR PELVICO (Pantalla digital)', generados: 133, cancelados: 25, pendientes: 4, valorCancelado: 752 }),
  p({ producto: 'Freidora con canasta winner', generados: 95, cancelados: 35, pendientes: 7, valorCancelado: 1062 }),
  p({ producto: 'DRENAJE LINFATICO  (59 ML)', generados: 84, cancelados: 21, pendientes: 5, valorCancelado: 656 }),
  p({ producto: 'Aurelis | Drenaje Linfático', generados: 58, cancelados: 20, pendientes: 1, valorCancelado: 604 }),
  p({ producto: 'FREIDORA IMP WINNER', generados: 18, cancelados: 2, pendientes: 1, valorCancelado: 60 }),
];

describe('la tasa, no la cantidad', () => {
  const r = resumirPorProducto(AGOSTO_EC);

  it('la Freidora queda PRIMERA aunque las Gafas tengan el triple de cancelaciones', () => {
    // Es la razón de ser del módulo: la pantalla vieja ordenaba por cantidad y
    // las Gafas (109 cancelaciones, 51% del total) encabezaban siempre.
    expect(r.ranking[0].producto).toBe('Freidora con canasta winner');
    expect(r.ranking[0].tasa).toBe(39.8);
    const gafas = r.ranking.find(f => f.producto === 'GAFAS BLUETOOH PR')!;
    expect(gafas.cancelados).toBeGreaterThan(r.ranking[0].cancelados * 3);
    expect(r.ranking.indexOf(gafas)).toBe(2);
    expect(gafas.tasa).toBe(28.3);
  });

  it('reproduce las tasas medidas de agosto', () => {
    const tasas = Object.fromEntries(r.ranking.map(f => [f.producto, f.tasa]));
    expect(tasas['Aurelis | Drenaje Linfático']).toBe(35.1);
    expect(tasas['DRENAJE LINFATICO  (59 ML)']).toBe(26.6);
    expect(tasas['EJERCITADOR PELVICO (Pantalla digital)']).toBe(19.4);
    expect(tasas['FREIDORA IMP WINNER']).toBe(11.8);
  });

  it('el promedio sale de la MISMA fórmula que las filas', () => {
    // 28,1 y no el 27,8 de la tienda entera: este fixture son los seis
    // productos con volumen y deja afuera la cola de listados chicos. Que el
    // promedio se calcule sobre lo que hay en la tabla —y no se importe de
    // otra RPC— es justamente lo que hace auditable el delta.
    expect(r.promedioTienda).toBe(28.1);
  });

  it('el delta dice cuántos puntos está por encima del promedio', () => {
    // Un porcentaje solo no es una decisión; "+11,7 puntos" sí.
    expect(r.ranking[0].delta).toBe(11.7);
    // Y el signo importa: el que está mejor que el promedio va en negativo.
    const mejor = r.ranking[r.ranking.length - 1];
    expect(mejor.delta).toBeLessThan(0);
  });
});

describe('no se publica una tasa que no se puede sostener', () => {
  it('sin pedidos resueltos la tasa es null, NUNCA 0', () => {
    const r = resumirPorProducto([p({ producto: 'Nuevo', generados: 10, cancelados: 0, pendientes: 10 })]);
    expect(r.ranking).toHaveLength(0);
    expect(r.bajoMinimo[0].tasa).toBeNull();
    expect(r.bajoMinimo[0].resueltos).toBe(0);
  });

  it('los pendientes salen del denominador', () => {
    // 20 pedidos, 15 todavía pendientes, 5 resueltos de los cuales 1 canceló.
    // La tasa es 20% sobre lo resuelto, no 5% sobre todo.
    const r = resumirPorProducto([p({ producto: 'X', generados: 20, cancelados: 1, pendientes: 15 })]);
    expect(r.bajoMinimo[0].tasa).toBe(20);
  });

  it('un producto de poco volumen no encabeza el ranking con ruido', () => {
    // 2 de 3 = 67%, el número más alto de la lista. Antes de la guarda, ese
    // producto se comía el primer puesto (mismo bug que carrierRecommendations).
    const r = resumirPorProducto([
      p({ producto: 'Ruido', generados: 3, cancelados: 2 }),
      p({ producto: 'Real', generados: 200, cancelados: 60 }),
    ]);
    expect(r.ranking.map(f => f.producto)).toEqual(['Real']);
    expect(r.bajoMinimo.map(f => f.producto)).toEqual(['Ruido']);
  });

  it('pero el de poco volumen NO se esconde: se lista con su tasa aparte', () => {
    const r = resumirPorProducto([p({ producto: 'Ruido', generados: 3, cancelados: 2 })]);
    expect(r.bajoMinimo).toHaveLength(1);
    expect(r.bajoMinimo[0].tasa).toBe(66.7);
    expect(r.bajoMinimo[0].rankeable).toBe(false);
  });

  it('el umbral es el mismo criterio que el de transportadoras', () => {
    const justo = resumirPorProducto([
      p({ producto: 'Justo', generados: MIN_RESUELTOS_PRODUCTO, cancelados: 1 }),
    ]);
    expect(justo.ranking).toHaveLength(1);
    const uno_menos = resumirPorProducto([
      p({ producto: 'Casi', generados: MIN_RESUELTOS_PRODUCTO - 1, cancelados: 1 }),
    ]);
    expect(uno_menos.ranking).toHaveLength(0);
  });

  it('lista vacía no explota', () => {
    expect(resumirPorProducto([])).toEqual(EMPTY_POR_PRODUCTO);
  });
});

describe('publicaciones hermanas: el mismo producto publicado distinto', () => {
  const r = resumirPorProducto(AGOSTO_EC);

  it('empareja las dos Freidoras pese a los nombres distintos', () => {
    expect(claveProducto('Freidora con canasta winner'))
      .toBe(claveProducto('FREIDORA IMP WINNER'));
  });

  it('empareja los dos Drenajes ignorando marca, paréntesis y acentos', () => {
    expect(claveProducto('Aurelis | Drenaje Linfático'))
      .toBe(claveProducto('DRENAJE LINFATICO  (59 ML)'));
  });

  it('NO empareja productos distintos', () => {
    expect(claveProducto('GAFAS BLUETOOH PR'))
      .not.toBe(claveProducto('EJERCITADOR PELVICO (Pantalla digital)'));
    expect(claveProducto('Freidora con canasta winner'))
      .not.toBe(claveProducto('Aurelis | Drenaje Linfático'));
  });

  it('marca las Freidoras como discrepantes: 28 puntos de brecha', () => {
    const g = r.hermanas.find(h => h.filas.some(f => /freidora/i.test(f.producto)))!;
    expect(g.filas).toHaveLength(2);
    expect(g.brechaPuntos).toBe(28);
    expect(g.discrepan).toBe(true);
    expect(g.brechaPuntos!).toBeGreaterThanOrEqual(UMBRAL_HERMANAS_PUNTOS);
  });

  it('los Drenajes se agrupan pero NO se marcan: 8,5 puntos es ruido de oferta', () => {
    const g = r.hermanas.find(h => h.filas.some(f => /drenaje/i.test(f.producto)))!;
    expect(g.brechaPuntos).toBe(8.5);
    expect(g.discrepan).toBe(false);
  });

  it('las hermanas NUNCA se suman: siguen siendo dos filas con sus cifras', () => {
    // Fusionarlas borraría el hallazgo — que el problema es el anuncio y no el
    // producto — y además inventaría una tasa que no existe en ningún lado.
    const freidoras = r.ranking.concat(r.bajoMinimo).filter(f => /freidora/i.test(f.producto));
    expect(freidoras).toHaveLength(2);
    expect(freidoras.map(f => f.generados).sort((a, b) => a - b)).toEqual([18, 95]);
  });

  it('un producto sin hermanas no arma grupo', () => {
    expect(r.hermanas.some(h => h.filas.some(f => f.producto === 'GAFAS BLUETOOH PR'))).toBe(false);
  });

  it('los grupos salen ordenados por brecha: primero el que más hay que mirar', () => {
    const brechas = r.hermanas.map(h => h.brechaPuntos ?? -1);
    expect(brechas).toEqual([...brechas].sort((a, b) => b - a));
  });
});
