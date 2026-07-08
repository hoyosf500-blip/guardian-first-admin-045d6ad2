import { describe, it, expect } from 'vitest';
import { deriveAutoLabels, LABELS, MANUAL_LABELS, type AutoLabelInput } from './orderLabels';

describe('deriveAutoLabels', () => {
  it('semáforo amarillo → datos_incompletos', () => {
    expect(deriveAutoLabels({ validationDecision: 'yellow' })).toContain('datos_incompletos');
  });
  it('semáforo rojo → datos_incompletos', () => {
    expect(deriveAutoLabels({ validationDecision: 'red' })).toContain('datos_incompletos');
  });
  it('faltan campos → datos_incompletos aunque el semáforo no sea amarillo/rojo', () => {
    expect(deriveAutoLabels({ validationDecision: 'green', missingFields: ['telefono'] }))
      .toContain('datos_incompletos');
  });
  it('verde y sin faltantes → NO datos_incompletos', () => {
    expect(deriveAutoLabels({ validationDecision: 'green', missingFields: [] })).not.toContain('datos_incompletos');
  });
  it('pickup_office no cuenta como incompleto', () => {
    expect(deriveAutoLabels({ validationDecision: 'pickup_office', missingFields: [] }))
      .not.toContain('datos_incompletos');
  });
  it('3 noresp → no_contesta', () => {
    expect(deriveAutoLabels({ norespCount: 3 })).toContain('no_contesta');
  });
  it('2 noresp → todavía NO no_contesta', () => {
    expect(deriveAutoLabels({ norespCount: 2 })).not.toContain('no_contesta');
  });
  it('sin datos → sin etiquetas auto', () => {
    expect(deriveAutoLabels({})).toEqual([]);
  });
  it('incompleto + no_contesta juntos, en orden (incompletos primero)', () => {
    const r = deriveAutoLabels({ validationDecision: 'red', norespCount: 3 });
    expect(r).toEqual(['datos_incompletos', 'no_contesta']);
  });
  it('norespCount undefined se trata como 0', () => {
    const input: AutoLabelInput = { validationDecision: 'green' };
    expect(deriveAutoLabels(input)).toEqual([]);
  });
});

describe('registro de etiquetas', () => {
  it('las 4 etiquetas tienen def con text/tone/auto', () => {
    (['datos_incompletos', 'no_contesta', 'dificil', 'interesado'] as const).forEach((k) => {
      expect(LABELS[k].text).toBeTruthy();
      expect(['yellow', 'red', 'orange', 'green']).toContain(LABELS[k].tone);
    });
  });
  it('auto vs manual bien marcadas', () => {
    expect(LABELS.datos_incompletos.auto).toBe(true);
    expect(LABELS.no_contesta.auto).toBe(true);
    expect(LABELS.dificil.auto).toBe(false);
    expect(LABELS.interesado.auto).toBe(false);
  });
  it('MANUAL_LABELS son solo las no-auto', () => {
    expect(MANUAL_LABELS.every((l) => !l.auto)).toBe(true);
    expect(MANUAL_LABELS.map((l) => l.key).sort()).toEqual(['dificil', 'interesado']);
  });
});
