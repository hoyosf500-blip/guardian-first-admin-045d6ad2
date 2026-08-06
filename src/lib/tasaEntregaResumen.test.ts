// La tasa de entrega que muestra "Cómo voy" (/logistica → Resumen) y el KPI de
// efectividad del CFO.
//
// POR QUÉ EXISTE ESTE ARCHIVO
// Julio 2026 en Ecuador cerró con 143 pedidos todavía despachados y sin
// desenlace. La pantalla dividía entregados ÷ generados, así que esos 143
// pedidos en camino entraban en el denominador y hundían la cifra: el mes se
// leía como una efectividad mala cuando lo que pasaba es que faltaba que
// llegaran. El resto de /logistica (Transportadoras, Ciudades, Productos,
// Geografía, Comparación) ya usaba la tasa madura desde antes — la pantalla que
// mira el dueño era la única cruda, y por eso el MISMO mes daba dos números
// distintos según la pestaña.
//
// Estos casos fijan la diferencia entre las dos fórmulas con la forma real de
// un mes en curso, para que nadie "simplifique" de vuelta a entregados ÷ total.

import { describe, it, expect } from 'vitest';
import {
  deriveDeliveryMaturity,
  isRatePreliminary,
  DELIVERY_MATURITY_THRESHOLD,
} from './logisticsRates';

/** Cohorte con la forma de un mes en curso: la mayoría todavía en la calle. */
const MES_EN_CURSO = {
  entregados: 180,
  devueltos: 45,   // devoluciones logísticas puras
  rechazados: 15,  // el cliente rechazó en la puerta
  enTransito: 143, // los que seguían en la calle al cierre
  novedad: 20,
};

/** Cohorte de despacho como lo arma MesActualResumen (DISPATCHED_KEYS). */
function despachados(c: typeof MES_EN_CURSO): number {
  return c.entregados + c.devueltos + c.rechazados + c.enTransito + c.novedad;
}

describe('tasa de entrega del Resumen — madura, no cruda', () => {
  it('no mete en el denominador los pedidos que siguen en la calle', () => {
    const c = MES_EN_CURSO;
    const total = despachados(c); // 403
    const m = deriveDeliveryMaturity(
      c.entregados, c.devueltos + c.rechazados, total, c.rechazados,
    );

    // Madura: 180 entregados sobre 225 concluidos (los 15 rechazos NO cuentan:
    // el cliente rechazó, la transportadora sí entregó).
    expect(m.resueltos).toBe(225);
    expect(m.tasaEntregaMadura).toBe(80);

    // Cruda (la que se mostraba antes): 180 / 403 = 45%. Los 143 en tránsito y
    // las 20 novedades castigan una entrega que todavía no falló.
    const cruda = Math.round((c.entregados / total) * 100);
    expect(cruda).toBe(45);

    // 35 puntos de diferencia sobre el MISMO mes. Ese era el sesgo.
    expect(m.tasaEntregaMadura! - cruda).toBe(35);
  });

  it('los rechazos del cliente no bajan la tasa pero sí cuentan como concluidos', () => {
    const sinRechazos = deriveDeliveryMaturity(180, 45, 403, 0);
    const conRechazos = deriveDeliveryMaturity(180, 60, 403, 15);

    // Mismo numerador y mismo denominador efectivo → misma tasa.
    expect(conRechazos.tasaEntregaMadura).toBe(80);
    expect(sinRechazos.tasaEntregaMadura).toBe(80);

    // Pero el cohorte con rechazos está MÁS maduro: esos 15 ya cerraron su ciclo.
    expect(conRechazos.pctConcluido).toBeGreaterThan(sinRechazos.pctConcluido);
  });

  it('marca preliminar mientras falte llegar buena parte de lo despachado', () => {
    const c = MES_EN_CURSO;
    const m = deriveDeliveryMaturity(
      c.entregados, c.devueltos + c.rechazados, despachados(c), c.rechazados,
    );
    // 240 concluidos de 403 despachados = 60% < 70% de umbral.
    expect(m.pctConcluido).toBe(60);
    expect(m.pctConcluido).toBeLessThan(DELIVERY_MATURITY_THRESHOLD);
    expect(isRatePreliminary(m)).toBe(true);
  });

  it('deja de ser preliminar cuando el mes ya llegó', () => {
    // Mismo mes, un par de semanas después: los 143 llegaron.
    const m = deriveDeliveryMaturity(300, 88, 403, 15);
    expect(m.pctConcluido).toBeGreaterThanOrEqual(DELIVERY_MATURITY_THRESHOLD);
    expect(isRatePreliminary(m)).toBe(false);
    expect(m.tasaEntregaMadura).toBe(80);
  });

  it('sin ningún pedido concluido devuelve null, NUNCA 0%', () => {
    // Producto o mes recién lanzado: 50 despachados, ninguno resuelto. Un "0%"
    // acá se lee "no entregamos nada" y es falso: no se resolvió nada todavía.
    const m = deriveDeliveryMaturity(0, 0, 50, 0);
    expect(m.tasaEntregaMadura).toBeNull();
    expect(m.tasaDevolucionMadura).toBeNull();
    expect(m.resueltos).toBe(0);
  });

  it('un cohorte cerrado da lo mismo con las dos fórmulas', () => {
    // Sin nada en la calle, madura y cruda coinciden — el fix no mueve el pasado.
    const total = 100;
    const m = deriveDeliveryMaturity(70, 30, total, 0);
    const cruda = Math.round((70 / total) * 100);
    expect(m.tasaEntregaMadura).toBe(cruda);
    expect(isRatePreliminary(m)).toBe(false);
  });
});

describe('umbrales de veredicto del CFO sobre la tasa', () => {
  // El CFO pinta rojo por debajo de 55% y avisa entre 55% y 65%. Con la tasa
  // cruda un mes en curso caía SIEMPRE en rojo los primeros días, sin que nada
  // estuviera mal. Estos casos fijan que el veredicto se emite sobre la madura.
  const UMBRAL_ROJO = 55;

  it('el mes en curso NO dispara la alerta roja por estar a mitad de camino', () => {
    const c = MES_EN_CURSO;
    const total = despachados(c);
    const m = deriveDeliveryMaturity(
      c.entregados, c.devueltos + c.rechazados, total, c.rechazados,
    );

    // La cruda habría disparado la alarma.
    expect(Math.round((c.entregados / total) * 100)).toBeLessThan(UMBRAL_ROJO);
    // La madura no: la operación entrega 80% de lo que ya se definió.
    expect(m.tasaEntregaMadura).toBeGreaterThanOrEqual(UMBRAL_ROJO);
  });

  it('una operación que SÍ entrega mal sigue disparando la alerta', () => {
    // 90 entregados contra 110 devueltos: acá el problema es real y tiene que
    // sonar. El fix silencia el falso positivo, no la alarma.
    const m = deriveDeliveryMaturity(90, 110, 260, 0);
    expect(m.tasaEntregaMadura).toBe(45);
    expect(m.tasaEntregaMadura!).toBeLessThan(UMBRAL_ROJO);
    expect(isRatePreliminary(m)).toBe(false); // 200 de 260 concluidos = 77%
  });
});
