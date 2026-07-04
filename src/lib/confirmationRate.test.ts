import { describe, it, expect } from 'vitest';
import {
  confRateBySample, confRateByCohort, contactRate, isBelowTarget, isBelowDailyTarget,
  MATURITY_MIN_RESUELTOS, COHORTE_MATURITY_PCT, CONF_TARGET_PCT, CONF_DIA_TARGET_PCT,
} from './confirmationRate';

describe('confRateBySample (tasa madura por operadora/personal)', () => {
  it('conf÷(conf+canc): Mayra 5 conf / 5 canc → 50%', () => {
    const r = confRateBySample(5, 5);
    expect(r.tasa).toBe(50);
    expect(r.resueltos).toBe(10);
    expect(r.inmaduro).toBe(false);
  });

  it('NO mete noresp en el denominador (2 conf / 0 canc → 100%)', () => {
    const r = confRateBySample(2, 0);
    expect(r.tasa).toBe(100);
    // 2 resueltos < 5 → inmaduro (poca muestra)
    expect(r.inmaduro).toBe(true);
  });

  it('0 resueltos → tasa null (no 0% rojo)', () => {
    const r = confRateBySample(0, 0);
    expect(r.tasa).toBeNull();
    expect(r.resueltos).toBe(0);
    expect(r.inmaduro).toBe(true);
  });

  it('inmaduro cuando resueltos < MATURITY_MIN_RESUELTOS', () => {
    expect(confRateBySample(2, 2).inmaduro).toBe(true);  // 4 < 5
    expect(confRateBySample(3, 2).inmaduro).toBe(false); // 5 >= 5
  });

  it('umbral de muestra configurable', () => {
    expect(confRateBySample(1, 0, 1).inmaduro).toBe(false);
  });

  it('valores negativos/NaN se sanean a 0', () => {
    const r = confRateBySample(-3 as number, NaN as unknown as number);
    expect(r.tasa).toBeNull();
    expect(r.resueltos).toBe(0);
  });
});

describe('confRateByCohort (día con inflow conocido)', () => {
  it('tasa madura = conf÷resueltos, no ÷entrantes', () => {
    // 10 entrantes, 5 conf + 3 canc resueltos
    const r = confRateByCohort(5, 3, 10);
    expect(r.tasa).toBe(63);          // 5/8
    expect(r.tasaCanc).toBe(38);      // 3/8
    expect(r.resueltos).toBe(8);
    expect(r.pctProcesado).toBe(80);  // 8/10
    expect(r.inmaduro).toBe(true);    // 80 < 90
  });

  it('cohorte maduro cuando pctProcesado >= 90%', () => {
    const r = confRateByCohort(8, 1, 10); // 9/10 = 90%
    expect(r.pctProcesado).toBe(90);
    expect(r.inmaduro).toBe(false);
  });

  it('0 entrantes → pctProcesado 0, inmaduro', () => {
    const r = confRateByCohort(0, 0, 0);
    expect(r.tasa).toBeNull();
    expect(r.pctProcesado).toBe(0);
    expect(r.inmaduro).toBe(true);
  });

  it('tasaDia = confirmados ÷ ENTRANTES (la "confirmación del día"), distinta de tasa ÷resueltos', () => {
    // Caso real María José: 26 entraron, 14 conf, 5 canc, 3 no contestaron.
    const r = confRateByCohort(14, 5, 26);
    expect(r.tasaDia).toBe(54);       // 14/26 = 53.8 → 54 (cómo va el día, NO infla)
    expect(r.tasa).toBe(74);          // 14/19 efectividad de cierre (÷resueltos, la vieja)
    expect(r.pctProcesado).toBe(73);  // 19/26 trabajado
    expect(r.inmaduro).toBe(true);    // 73 < 90 → el día no terminó → provisional, NO rojo
  });

  it('tasaDia null cuando no hay entrantes', () => {
    expect(confRateByCohort(0, 0, 0).tasaDia).toBeNull();
  });

  it('tasaDia siempre <= tasa (÷entrantes nunca infla sobre ÷resueltos)', () => {
    const r = confRateByCohort(8, 1, 20); // 9 resueltos de 20
    expect(r.tasaDia).toBe(40);  // 8/20
    expect(r.tasa).toBe(89);     // 8/9
    expect(r.tasaDia! <= r.tasa!).toBe(true);
  });
});

describe('contactRate (contactabilidad)', () => {
  it('(conf+canc)÷atendidos: 10 atendidos sin noresp → 100%', () => {
    expect(contactRate(5, 5, 10)).toBe(100);
  });

  it('penaliza los no-contesta: 8 contactados de 10 atendidos → 80%', () => {
    expect(contactRate(5, 3, 10)).toBe(80);
  });

  it('0 atendidos → 0%', () => {
    expect(contactRate(0, 0, 0)).toBe(0);
  });
});

describe('constantes', () => {
  it('umbrales esperados', () => {
    expect(MATURITY_MIN_RESUELTOS).toBe(5);
    expect(COHORTE_MATURITY_PCT).toBe(90);
  });

  it('meta oficial de confirmación = 85% (fuente única)', () => {
    expect(CONF_TARGET_PCT).toBe(85);
  });

  it('meta del día (÷inflow) = 55%, distinta del 85% (÷resueltos)', () => {
    expect(CONF_DIA_TARGET_PCT).toBe(55);
    expect(CONF_DIA_TARGET_PCT).toBeLessThan(CONF_TARGET_PCT);
  });
});

describe('isBelowDailyTarget (por debajo de la meta del día ~55% ÷inflow)', () => {
  it('true cuando tasaDia < 55', () => {
    expect(isBelowDailyTarget(54)).toBe(true);
    expect(isBelowDailyTarget(20)).toBe(true);
  });

  it('false cuando tasaDia >= 55 (en meta del día)', () => {
    expect(isBelowDailyTarget(55)).toBe(false);
    expect(isBelowDailyTarget(60)).toBe(false);
  });

  it('null/undefined → false (no penaliza sin datos)', () => {
    expect(isBelowDailyTarget(null)).toBe(false);
    expect(isBelowDailyTarget(undefined)).toBe(false);
  });
});

describe('isBelowTarget (por debajo de la meta oficial 85%)', () => {
  it('true cuando tasa < 85', () => {
    expect(isBelowTarget(84)).toBe(true);
    expect(isBelowTarget(70)).toBe(true);
    expect(isBelowTarget(0)).toBe(true);
  });

  it('false cuando tasa >= 85 (en meta)', () => {
    expect(isBelowTarget(85)).toBe(false);
    expect(isBelowTarget(100)).toBe(false);
  });

  it('null/undefined (sin datos) → false, no penaliza muestra vacía', () => {
    expect(isBelowTarget(null)).toBe(false);
    expect(isBelowTarget(undefined)).toBe(false);
  });
});
