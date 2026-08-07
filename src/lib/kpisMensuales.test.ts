import { describe, it, expect } from 'vitest';
import {
  calcularKpisMes,
  construirKpis,
  veredictoDelMes,
  type KpiMesCrudo,
} from './kpisMensuales';

/** Fila cruda en cero; se pisan solo los campos que el caso necesita. */
function mes(over: Partial<KpiMesCrudo> = {}): KpiMesCrudo {
  return {
    year_month: '2026-07',
    dias: 31,
    generados: 0,
    unidades: 0,
    cancelados: 0,
    entregados: 0,
    devueltos: 0,
    rechazados: 0,
    en_calle: 0,
    valor_no_cancelado: 0,
    valor_entregado: 0,
    valor_en_calle: 0,
    ganancia_bruta: 0,
    entradas: 0,
    salidas: 0,
    operativo: 0,
    pauta: 0,
    admin: 0,
    retirado: 0,
    ...over,
  };
}

// Los dos meses del régimen WhatsApp, con las cifras REALES medidas en la tienda
// CO contra la billetera de Dropi y los paneles mensuales (sesión 2026-08-07).
// `ganancia_bruta` de cada uno es, al centavo, la "Utilidad Total" del panel; los
// `devueltos` son los que reproducen las tasas maduras medidas (68,1% y 76,3%).
const JUNIO: KpiMesCrudo = mes({
  year_month: '2026-06',
  dias: 30,
  generados: 287,
  unidades: 430,
  entregados: 175,
  devueltos: 82,
  ganancia_bruta: 9_135_742.4,
  operativo: 8_742_101,
  pauta: 4_668_205,
  admin: 1_950_000,
});

const JULIO: KpiMesCrudo = mes({
  year_month: '2026-07',
  dias: 31,
  generados: 389,
  unidades: 605,
  entregados: 225,
  devueltos: 70,
  ganancia_bruta: 10_372_011.58,
  operativo: 8_977_230,
  pauta: 4_114_595,
  admin: 1_950_000,
});

describe('la cadena de tres factores', () => {
  it('reproduce los 7 meses publicados: $77,1M prometidos → $63,7M cobrados → -$29,7M', () => {
    const k = calcularKpisMes(
      mes({
        year_month: '2026-total',
        generados: 3044,
        entregados: 1598,
        ganancia_bruta: 77_144_722.79,
        operativo: 63_742_469,
        pauta: 74_155_456,
        admin: 19_300_000,
      }),
    );

    // De lo que Dropi promete, cuánto llega de verdad a la billetera.
    expect(k.factorRealizacion).toBe(82.6);
    // Y de lo que promete, cuánto queda después de pauta y costos fijos.
    expect(k.loQueQueda).toBe(-38.5);
    expect(k.resultado).toBe(63_742_469 - 74_155_456 - 19_300_000);
    expect(k.resultado).toBe(-29_712_987);
  });

  it('junio+julio dan la vuelta: 90,8% llega y queda +25,8%', () => {
    const { totales } = construirKpis([JUNIO, JULIO]);
    expect(totales.factorRealizacion).toBe(90.8);
    expect(totales.loQueQueda).toBe(25.8);
    expect(totales.resultado).toBe(5_036_531);
  });

  it('cada mes por separado reproduce su resultado publicado', () => {
    expect(calcularKpisMes(JUNIO).resultado).toBe(2_123_896);
    expect(calcularKpisMes(JULIO).resultado).toBe(2_912_635);
  });
});

describe('regla 1: un total nunca promedia porcentajes', () => {
  it('el factor del total se recalcula sobre las sumas, no se promedia', () => {
    const { meses, totales } = construirKpis([JUNIO, JULIO]);
    expect(meses[0].factorRealizacion).toBe(95.7);
    expect(meses[1].factorRealizacion).toBe(86.6);

    // El promedio simple daría 91,15. El correcto es 90,8 porque julio pesa más.
    const promedioIngenuo =
      (meses[0].factorRealizacion! + meses[1].factorRealizacion!) / 2;
    expect(promedioIngenuo).toBeCloseTo(91.15, 2);
    expect(totales.factorRealizacion).toBe(90.8);
    expect(totales.factorRealizacion).not.toBe(promedioIngenuo);
  });

  it('la tasa de entrega del total sale de los conteos sumados', () => {
    const { meses, totales } = construirKpis([JUNIO, JULIO]);
    expect(meses[0].tasaEntregaMadura).toBe(68); // junio, 175/257
    expect(meses[1].tasaEntregaMadura).toBe(76); // julio, 225/295
    expect(totales.entregados).toBe(400);
    expect(totales.devueltos).toBe(152);
    // 400 / 552, no el promedio de 68 y 76.
    expect(totales.tasaEntregaMadura).toBe(72);
  });
});

describe('regla 2: sin pauta cargada no se inventa un cero', () => {
  const sinPauta = calcularKpisMes(
    mes({ generados: 100, entregados: 60, devueltos: 40, ganancia_bruta: 3_000_000, operativo: 2_400_000 }),
  );

  it('marca sinPauta y deja en null todo lo que dependa de ella', () => {
    expect(sinPauta.sinPauta).toBe(true);
    expect(sinPauta.cpaPorEntrega).toBeNull();
    expect(sinPauta.contribucionPorEntrega).toBeNull();
    expect(sinPauta.contribucionPorGenerado).toBeNull();
    expect(sinPauta.roasReal).toBeNull();
  });

  it('no dice que el mes ganó: el veredicto es neutro', () => {
    expect(veredictoDelMes(sinPauta).severidad).toBe('neutro');
  });

  it('lo que NO depende de la pauta sigue calculándose', () => {
    expect(sinPauta.netoPorEntrega).toBe(40_000);
    expect(sinPauta.tasaEntregaMadura).toBe(60);
  });
});

describe('divisiones imposibles', () => {
  it('un mes en cero no produce ni NaN ni Infinity', () => {
    const k = calcularKpisMes(mes({ dias: 0 }));
    const numericos = Object.values(k).filter((v) => typeof v === 'number') as number[];
    expect(numericos.every((v) => Number.isFinite(v))).toBe(true);

    expect(k.pedidosPorDia).toBeNull();
    expect(k.unidadesPorPedido).toBeNull();
    expect(k.ticketPromedio).toBeNull();
    expect(k.tasaEntregaMadura).toBeNull();
    expect(k.gananciaBrutaPorEntrega).toBeNull();
    expect(k.netoPorEntrega).toBeNull();
    expect(k.costoPorDevolucion).toBeNull();
    expect(k.tasaEquilibrio).toBeNull();
    expect(k.factorRealizacion).toBeNull();
    expect(k.loQueQueda).toBeNull();
    expect(k.pctRetirado).toBeNull();
  });

  it('con ganancia_bruta en 0 el factor no explota', () => {
    const k = calcularKpisMes(mes({ generados: 10, entregados: 5, devueltos: 5, operativo: 500_000, pauta: 100_000 }));
    expect(k.factorRealizacion).toBeNull();
    expect(k.loQueQueda).toBeNull();
    expect(k.tasaEquilibrio).toBeNull(); // no hay ganancia por entrega con la que dividir
    expect(k.cpaPorEntrega).toBe(20_000);
  });

  it('construirKpis tolera null y lista vacía', () => {
    expect(construirKpis(null).meses).toEqual([]);
    expect(construirKpis(undefined).totales.generados).toBe(0);
    expect(construirKpis([]).rangos).toEqual({});
  });
});

describe('denominadores: qué entra y qué no', () => {
  it('los cancelados salen del denominador de la tasa de entrega y del ticket', () => {
    const k = calcularKpisMes(
      mes({ generados: 100, cancelados: 20, entregados: 60, devueltos: 20, valor_no_cancelado: 8_000_000 }),
    );
    // 80 despachables, no 100.
    expect(k.tasaEntregaCruda).toBe(75);
    expect(k.ticketPromedio).toBe(100_000);
    expect(k.tasaCancelacion).toBe(20); // esta sí va sobre generados
  });

  it('los rechazados cuentan como concluidos pero no diluyen la tasa madura', () => {
    // 60 entregados, 40 "devueltos" de los cuales 10 son rechazos del cliente.
    const k = calcularKpisMes(
      mes({ generados: 100, entregados: 60, devueltos: 40, rechazados: 10 }),
    );
    // Denominador = 60 + (40-10) = 90 → 67%, no 60%.
    expect(k.tasaEntregaMadura).toBe(67);
    expect(k.pctConcluido).toBe(100);
  });
});

describe('punto de equilibrio', () => {
  it('sale por encima de 100% cuando ninguna tasa de entrega salvaba el mes', () => {
    // 100 generados, 50 entregados, cada entrega deja $40.000 brutos según Dropi.
    // Potencial del mes = 100 × 40.000 = $4.000.000. Se invirtieron $5.000.000.
    const k = calcularKpisMes(
      mes({
        generados: 100,
        entregados: 50,
        devueltos: 50,
        ganancia_bruta: 2_000_000,
        operativo: 1_000_000,
        pauta: 4_000_000,
        admin: 1_000_000,
      }),
    );
    expect(k.gananciaBrutaPorEntrega).toBe(40_000);
    expect(k.tasaEquilibrio).toBe(125);
    expect(veredictoDelMes(k).severidad).toBe('grave');
  });

  it('la contribución negativa manda sobre el equilibrio en el veredicto', () => {
    const k = calcularKpisMes(
      mes({
        generados: 100,
        entregados: 50,
        devueltos: 50,
        ganancia_bruta: 2_000_000,
        operativo: 1_000_000,
        pauta: 4_000_000,
      }),
    );
    // neto por entrega 20.000 − CPA 80.000 = −60.000
    expect(k.contribucionPorEntrega).toBe(-60_000);
    expect(veredictoDelMes(k).texto).toContain('vender más');
  });
});

describe('meses preliminares', () => {
  const enCurso = mes({
    year_month: '2026-08',
    dias: 7,
    generados: 100,
    entregados: 20,
    devueltos: 5,
    ganancia_bruta: 1_000_000,
    operativo: 900_000,
    pauta: 800_000,
  });

  it('se marcan como preliminares y no se juzgan', () => {
    const k = calcularKpisMes(enCurso);
    expect(k.preliminar).toBe(true);
    expect(k.pctConcluido).toBe(25);
    expect(veredictoDelMes(k).severidad).toBe('neutro');
  });

  it('quedan fuera del rango mínimo–máximo', () => {
    const { rangos } = construirKpis([JUNIO, JULIO, enCurso]);
    // El mes en curso tiene la peor tasa de todas (80%), pero no debe aparecer.
    expect(rangos.tasaEntregaMadura?.mesMin).not.toBe('2026-08');
    expect(rangos.tasaEntregaMadura?.mesMax).not.toBe('2026-08');
  });
});

describe('rangos mínimo–máximo', () => {
  it('señalan en qué mes ocurrió cada extremo', () => {
    const { rangos } = construirKpis([JUNIO, JULIO]);

    const entrega = rangos.tasaEntregaMadura!;
    expect(entrega.min).toBe(68); // junio
    expect(entrega.max).toBe(76); // julio
    expect(entrega.mesMin).toBe('2026-06');
    expect(entrega.mesMax).toBe('2026-07');

    // El CPA es el que de verdad se movió entre los dos meses.
    const cpa = rangos.cpaPorEntrega!;
    expect(cpa.mesMax).toBe('2026-06'); // 4.668.205 / 175 = 26.675
    expect(cpa.mesMin).toBe('2026-07'); // 4.114.595 / 225 = 18.287
    expect(Math.round(cpa.max)).toBe(26_675);
    expect(Math.round(cpa.min)).toBe(18_287);
  });

  it('omite las tasas que ningún mes pudo calcular', () => {
    const { rangos } = construirKpis([mes({ generados: 10 })]);
    expect(rangos.cpaPorEntrega).toBeUndefined();
    expect(rangos.factorRealizacion).toBeUndefined();
  });
});
