import { describe, it, expect } from 'vitest';
import {
  minutosTarde,
  llegoTarde,
  contarTardanzas,
  avisoEntrada,
  retrasoLegible,
  ordinalFem,
  GRACIA_MIN,
} from './entradaTarde';

// Bogotá es UTC−5 fijo: las 09:00 de Bogotá son las 14:00 UTC.
const bog = (h: number, m = 0) =>
  new Date(Date.UTC(2026, 8, 3, h + 5, m, 0)).toISOString();

const NUEVE = 9 * 60; // apertura 09:00, en minutos desde medianoche

describe('minutos tarde', () => {
  it('llegar en punto no es llegar tarde', () => {
    expect(minutosTarde(bog(9, 0), NUEVE)).toBe(0);
  });

  it('llegar antes tampoco', () => {
    expect(minutosTarde(bog(8, 30), NUEVE)).toBe(0);
  });

  it('32 minutos tarde son 32', () => {
    expect(minutosTarde(bog(9, 32), NUEVE)).toBe(32);
  });

  /**
   * ⛔ El primer latido llega cuando la persona ya se sentó, abrió el navegador
   * y esperó a que cargue el CRM. Acusar por dos minutos quema la herramienta:
   * la próxima vez el aviso se ignora, incluida la vez que sí importaba.
   */
  it('dentro de la gracia no se acusa', () => {
    expect(minutosTarde(bog(9, GRACIA_MIN), NUEVE)).toBe(0);
    expect(minutosTarde(bog(9, GRACIA_MIN + 1), NUEVE)).toBe(GRACIA_MIN + 1);
  });
});

/**
 * ⛔ NUNCA CERO POR NO SABER. Este número se le muestra a una persona sobre su
 * puntualidad; "0 min tarde" sobre algo que no se midió la absuelve por error, y
 * un retraso inventado la acusa por error. Las dos cosas son mentiras.
 */
describe('lo que no se pudo medir', () => {
  it('sin marca de entrada devuelve null', () => {
    expect(minutosTarde(null, NUEVE)).toBeNull();
    expect(minutosTarde(undefined, NUEVE)).toBeNull();
    expect(minutosTarde('cualquier cosa', NUEVE)).toBeNull();
  });

  it('sin horario de la tienda NO acusa', () => {
    expect(minutosTarde(bog(11, 0), null)).toBeNull();
    expect(minutosTarde(bog(11, 0), undefined)).toBeNull();
    expect(minutosTarde(bog(11, 0), NaN)).toBeNull();
  });

  it('null no cuenta como tardanza', () => {
    expect(llegoTarde(null)).toBe(false);
    expect(llegoTarde(0)).toBe(false);
    expect(llegoTarde(1)).toBe(true);
  });
});

describe('el acumulado de la semana', () => {
  it('cuenta solo las tardanzas medidas', () => {
    const entradas = [bog(9, 40), bog(8, 55), null, bog(10, 10), 'roto'];
    expect(contarTardanzas(entradas, NUEVE)).toBe(2);
  });

  it('sin horario, no cuenta ninguna', () => {
    expect(contarTardanzas([bog(11, 0), bog(12, 0)], null)).toBe(0);
  });
});

describe('el aviso que ve la asesora', () => {
  it('puntual: no se le dice nada', () => {
    const a = avisoEntrada(bog(8, 58), [bog(9, 40)], NUEVE);
    expect(a.tardeMin).toBe(0);
    expect(a.texto).toBeNull();
  });

  /** "1ª vez esta semana" se lee como amenaza sobre algo que aún no es patrón. */
  it('la primera vez va sin contador', () => {
    const a = avisoEntrada(bog(9, 32), [bog(8, 50), bog(8, 45)], NUEVE);
    expect(a.texto).toBe('32 min tarde');
    expect(a.vecesEnLaSemana).toBe(1);
  });

  it('a la tercera, el acumulado pesa', () => {
    const a = avisoEntrada(bog(9, 32), [bog(9, 20), bog(10, 5), bog(8, 50)], NUEVE);
    expect(a.vecesEnLaSemana).toBe(3);
    expect(a.texto).toBe('32 min tarde · 3ª vez esta semana');
  });

  it('sin poder medir, no hay aviso', () => {
    expect(avisoEntrada(null, [bog(10, 0)], NUEVE).texto).toBeNull();
    expect(avisoEntrada(bog(10, 0), [], null).texto).toBeNull();
  });
});

describe('cómo se leen los números', () => {
  it('el retraso largo no se dice en minutos sueltos', () => {
    expect(retrasoLegible(32)).toBe('32 min');
    expect(retrasoLegible(60)).toBe('1 h');
    expect(retrasoLegible(125)).toBe('2 h 05 min');
  });

  it('el ordinal va en femenino', () => {
    expect(ordinalFem(3)).toBe('3ª');
    expect(ordinalFem(0)).toBe('1ª');
  });
});
