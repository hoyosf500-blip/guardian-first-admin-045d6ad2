import { describe, it, expect } from 'vitest';
import { deriveCarrierRecommendations } from './carrierRecommendations';
import type { CityCarrierMatrix } from './logistics.types';

function row(p: Partial<CityCarrierMatrix> & { ciudad: string; transportadora: string }): CityCarrierMatrix {
  return {
    ciudad: p.ciudad,
    departamento: p.departamento ?? 'Cundinamarca',
    transportadora: p.transportadora,
    total_pedidos: p.total_pedidos ?? 0,
    entregados: p.entregados ?? 0,
    devueltos: p.devueltos ?? 0,
    tasa_entrega: p.tasa_entrega ?? 0,
    tasa_devolucion: p.tasa_devolucion ?? 0,
    ciudad_total: p.ciudad_total ?? 0,
  };
}

describe('deriveCarrierRecommendations', () => {
  it('rankea por tasa MADURA, no por entregados/total', () => {
    // Carrier A: 50 entregados, 10 devueltos, 40 en tránsito (100 total)
    //   madura = 50/60 = 83.3%  (cruda sería 50/100 = 50%)
    // Carrier B: 30 entregados, 30 devueltos, 0 en tránsito (60 total)
    //   madura = 30/60 = 50%    (cruda sería 30/60 = 50%)
    // Por tasa madura A (83.3%) > B (50%) → A es el mejor.
    const rows = [
      row({ ciudad: 'Bogota', transportadora: 'A', total_pedidos: 100, entregados: 50, devueltos: 10, ciudad_total: 160 }),
      row({ ciudad: 'Bogota', transportadora: 'B', total_pedidos: 60, entregados: 30, devueltos: 30, ciudad_total: 160 }),
    ];
    const recs = deriveCarrierRecommendations(rows, 20);
    expect(recs).toHaveLength(1);
    expect(recs[0].mejor_transportadora).toBe('A');
    expect(recs[0].mejor_tasa_entrega).toBe(83.3);
    expect(recs[0].peor_transportadora).toBe('B');
    expect(recs[0].peor_tasa_entrega).toBe(50);
    expect(recs[0].delta_puntos).toBe(33.3);
  });

  it('current_top = mayor volumen; recomienda mantener si coincide con el mejor', () => {
    const rows = [
      row({ ciudad: 'Cali', transportadora: 'Envia', total_pedidos: 100, entregados: 90, devueltos: 10, ciudad_total: 130 }),
      row({ ciudad: 'Cali', transportadora: 'TCC', total_pedidos: 30, entregados: 10, devueltos: 20, ciudad_total: 130 }),
    ];
    const recs = deriveCarrierRecommendations(rows, 20);
    expect(recs[0].carrier_actual_top).toBe('Envia');     // más volumen
    expect(recs[0].mejor_transportadora).toBe('Envia');   // mejor tasa madura
    expect(recs[0].recomendacion).toBe('Mantener Envia');
  });

  it('recomienda cambiar si el mejor no es el más usado', () => {
    const rows = [
      row({ ciudad: 'Medellin', transportadora: 'Usado', total_pedidos: 100, entregados: 50, devueltos: 50, ciudad_total: 150 }),
      row({ ciudad: 'Medellin', transportadora: 'Mejor', total_pedidos: 50, entregados: 45, devueltos: 5, ciudad_total: 150 }),
    ];
    const recs = deriveCarrierRecommendations(rows, 20);
    expect(recs[0].carrier_actual_top).toBe('Usado');
    expect(recs[0].mejor_transportadora).toBe('Mejor');
    expect(recs[0].recomendacion).toBe('Cambiar a Mejor');
  });

  it('descarta ciudades bajo el umbral minOrders', () => {
    const rows = [
      row({ ciudad: 'Chica', transportadora: 'A', total_pedidos: 10, entregados: 8, devueltos: 2, ciudad_total: 10 }),
    ];
    expect(deriveCarrierRecommendations(rows, 20)).toHaveLength(0);
  });

  it('ignora transportadoras sin resueltos (todo en tránsito) en el ranking', () => {
    const rows = [
      row({ ciudad: 'Bogota', transportadora: 'EnTransito', total_pedidos: 80, entregados: 0, devueltos: 0, ciudad_total: 140 }),
      row({ ciudad: 'Bogota', transportadora: 'Real', total_pedidos: 60, entregados: 40, devueltos: 20, ciudad_total: 140 }),
    ];
    const recs = deriveCarrierRecommendations(rows, 20);
    // 'EnTransito' tiene más volumen → current_top, pero no compite en calidad.
    expect(recs[0].carrier_actual_top).toBe('EnTransito');
    expect(recs[0].mejor_transportadora).toBe('Real');
    expect(recs[0].peor_transportadora).toBe('Real');
  });

  it('ordena ciudades por volumen descendente', () => {
    const rows = [
      row({ ciudad: 'Chica', transportadora: 'A', total_pedidos: 30, entregados: 20, devueltos: 10, ciudad_total: 30 }),
      row({ ciudad: 'Grande', transportadora: 'B', total_pedidos: 200, entregados: 150, devueltos: 50, ciudad_total: 200 }),
    ];
    const recs = deriveCarrierRecommendations(rows, 20);
    expect(recs.map(r => r.ciudad)).toEqual(['Grande', 'Chica']);
  });
});

describe('auditoría 24-ago-2026: veredictos honestos', () => {
  it('con UNA sola transportadora rankeable el veredicto es neutro, nunca "Cambiar"', () => {
    // El top por volumen no rankea (todo en tránsito) y solo 'Real' tiene datos:
    // antes salía "Cambiar a Real" — abandonar un carrier de desempeño
    // DESCONOCIDO hacia el único medido, sin comparación real.
    const rows = [
      row({ ciudad: 'Bogota', transportadora: 'EnTransito', total_pedidos: 80, entregados: 0, devueltos: 0 }),
      row({ ciudad: 'Bogota', transportadora: 'Real', total_pedidos: 60, entregados: 40, devueltos: 20 }),
    ];
    const recs = deriveCarrierRecommendations(rows, 20);
    expect(recs[0].recomendacion).toBe('Sin alternativa medida');
    expect(recs[0].delta_puntos).toBe(0);
  });

  it('ciudades homónimas de departamentos distintos NO heredan el volumen combinado', () => {
    // El server calcula ciudad_total por NOMBRE (sin departamento): las dos
    // La Unión llegaban con 30 combinado y ambas pasaban minOrders=20 sin
    // llegar solas. El total ahora se deriva sumando las filas del grupo.
    const rows = [
      row({ ciudad: 'La Union', departamento: 'Antioquia', transportadora: 'A', total_pedidos: 15, entregados: 10, devueltos: 5, ciudad_total: 30 }),
      row({ ciudad: 'La Union', departamento: 'Narino', transportadora: 'B', total_pedidos: 15, entregados: 5, devueltos: 10, ciudad_total: 30 }),
    ];
    expect(deriveCarrierRecommendations(rows, 20)).toHaveLength(0);
  });

  it('la tasa va con floor: 1999 entregados + 1 devuelto NO imprime 100.0%', () => {
    const rows = [
      row({ ciudad: 'Quito', transportadora: 'A', total_pedidos: 2000, entregados: 1999, devueltos: 1 }),
      row({ ciudad: 'Quito', transportadora: 'B', total_pedidos: 100, entregados: 50, devueltos: 50 }),
    ];
    const recs = deriveCarrierRecommendations(rows, 20);
    expect(recs[0].mejor_tasa_entrega).toBe(99.9);
  });

  it('marca mejor_prelim cuando el cohorte del ganador aún está inmaduro', () => {
    // 6 concluidos de 40 (15% concluido): rankea (≥5 resueltos) pero prelim.
    const rows = [
      row({ ciudad: 'Cali', transportadora: 'Joven', total_pedidos: 40, entregados: 5, devueltos: 1 }),
      row({ ciudad: 'Cali', transportadora: 'Maduro', total_pedidos: 30, entregados: 20, devueltos: 10 }),
    ];
    const recs = deriveCarrierRecommendations(rows, 20);
    expect(recs[0].mejor_transportadora).toBe('Joven'); // 83.3% > 66.6%
    expect(recs[0].mejor_prelim).toBe(true);
  });
});

describe('mínimo de resueltos para rankear (auditoría 2026-07-02)', () => {
  it('un carrier con 1 solo resuelto (100%) NO le gana al establecido con muestra real', () => {
    // Carrier NUEVO: 5 pedidos, 1 entregado, 0 devueltos → 100% sobre n=1 (ruido).
    // Carrier ESTABLECIDO: 50 pedidos, 30 entregados, 10 devueltos → 75% sobre n=40.
    const rows = [
      row({ ciudad: 'Quito', transportadora: 'NUEVO', total_pedidos: 5, entregados: 1, devueltos: 0, ciudad_total: 55 }),
      row({ ciudad: 'Quito', transportadora: 'ESTABLECIDO', total_pedidos: 50, entregados: 30, devueltos: 10, ciudad_total: 55 }),
    ];
    const recs = deriveCarrierRecommendations(rows, 20);
    expect(recs).toHaveLength(1);
    expect(recs[0].mejor_transportadora).toBe('ESTABLECIDO');
    expect(recs[0].mejor_resueltos).toBe(40);
  });

  it('si NINGÚN carrier llega al mínimo de resueltos, la ciudad no genera recomendación', () => {
    const rows = [
      row({ ciudad: 'Loja', transportadora: 'A', total_pedidos: 15, entregados: 2, devueltos: 1, ciudad_total: 30 }),
      row({ ciudad: 'Loja', transportadora: 'B', total_pedidos: 15, entregados: 1, devueltos: 0, ciudad_total: 30 }),
    ];
    expect(deriveCarrierRecommendations(rows, 20)).toHaveLength(0);
  });
});
