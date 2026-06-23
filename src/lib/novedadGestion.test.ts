import { describe, it, expect } from 'vitest';
import {
  buildNovedadAction,
  parseNovedadAction,
  isNovedadAction,
  classifyDeliveryOutcome,
  normalizeNovedadLabel,
  novedadGroupKey,
  formatDuration,
  bogotaDateNDaysAgo,
} from './novedadGestion';

describe('buildNovedadAction', () => {
  it('resuelta con nota', () => {
    expect(buildNovedadAction('resuelta', 'Cliente en casa mañana 2-5pm'))
      .toBe('NOVEDAD: Resuelta — Cliente en casa mañana 2-5pm');
  });
  it('resuelta sin nota', () => {
    expect(buildNovedadAction('resuelta')).toBe('NOVEDAD: Resuelta');
    expect(buildNovedadAction('resuelta', '   ')).toBe('NOVEDAD: Resuelta');
  });
  it('devolución y sin respuesta ignoran nota', () => {
    expect(buildNovedadAction('devolucion', 'algo')).toBe('NOVEDAD: Devolución');
    expect(buildNovedadAction('sin_respuesta', 'algo')).toBe('NOVEDAD: Sin respuesta');
  });
  it('colapsa espacios y trunca la nota a 180', () => {
    const long = 'a'.repeat(200);
    const out = buildNovedadAction('resuelta', long);
    expect(out).toBe(`NOVEDAD: Resuelta — ${'a'.repeat(180)}`);
  });
  it('round-trip build → parse preserva tipo y nota', () => {
    for (const tipo of ['resuelta', 'devolucion', 'sin_respuesta'] as const) {
      const parsed = parseNovedadAction(buildNovedadAction(tipo, 'nota x'));
      expect(parsed.tipo).toBe(tipo);
    }
  });
});

describe('isNovedadAction', () => {
  it('detecta el prefijo NOVEDAD: (con/sin acento, case-insensitive)', () => {
    expect(isNovedadAction('NOVEDAD: Resuelta')).toBe(true);
    expect(isNovedadAction('novedad: lo que sea')).toBe(true);
    expect(isNovedadAction('  NOVEDAD : x')).toBe(true);
  });
  it('rechaza acciones que no son novedad', () => {
    expect(isNovedadAction('Confirmado')).toBe(false);
    expect(isNovedadAction('SEG: llamada')).toBe(false);
    expect(isNovedadAction('')).toBe(false);
    expect(isNovedadAction(null)).toBe(false);
    expect(isNovedadAction(undefined)).toBe(false);
  });
});

describe('parseNovedadAction', () => {
  it('formato nuevo: Resuelta con nota', () => {
    expect(parseNovedadAction('NOVEDAD: Resuelta — pagó el flete')).toEqual({
      tipo: 'resuelta', nota: 'pagó el flete',
    });
  });
  it('formato nuevo: Devolución', () => {
    expect(parseNovedadAction('NOVEDAD: Devolución')).toEqual({ tipo: 'devolucion', nota: null });
  });
  it('formato nuevo: Sin respuesta', () => {
    expect(parseNovedadAction('NOVEDAD: Sin respuesta')).toEqual({ tipo: 'sin_respuesta', nota: null });
  });
  it('legacy: Volver a ofrecer → resuelta (preserva nota)', () => {
    expect(parseNovedadAction('NOVEDAD: Volver a ofrecer — barrio correcto Chapinero')).toEqual({
      tipo: 'resuelta', nota: 'barrio correcto Chapinero',
    });
  });
  it('legacy: Devolver al remitente → devolución', () => {
    expect(parseNovedadAction('NOVEDAD: Devolver al remitente')).toEqual({ tipo: 'devolucion', nota: null });
  });
  it('NO clasifica por la nota: "Resuelta — le devolví la llamada" sigue siendo resuelta', () => {
    // 'devolví' está en la nota, no en la etiqueta → no debe ser devolución.
    expect(parseNovedadAction('NOVEDAD: Resuelta — le devolví la llamada').tipo).toBe('resuelta');
  });
  it('acción no-novedad → tipo null', () => {
    expect(parseNovedadAction('Confirmado')).toEqual({ tipo: null, nota: null });
  });
  it('novedad con etiqueta desconocida → resuelta (trabajo real)', () => {
    expect(parseNovedadAction('NOVEDAD: algo raro').tipo).toBe('resuelta');
  });
});

describe('classifyDeliveryOutcome', () => {
  it('entregada', () => {
    expect(classifyDeliveryOutcome('ENTREGADO')).toBe('entregada');
    expect(classifyDeliveryOutcome('Entregada a destinatario')).toBe('entregada');
  });
  it('devuelta', () => {
    expect(classifyDeliveryOutcome('DEVUELTO AL REMITENTE')).toBe('devuelta');
    expect(classifyDeliveryOutcome('DEVOLUCION')).toBe('devuelta');
    expect(classifyDeliveryOutcome('RECHAZADO')).toBe('devuelta');
  });
  it('en_proceso', () => {
    expect(classifyDeliveryOutcome('NOVEDAD EN RUTA')).toBe('en_proceso');
    expect(classifyDeliveryOutcome('EN REPARTO')).toBe('en_proceso');
    expect(classifyDeliveryOutcome('GUIA GENERADA')).toBe('en_proceso');
    expect(classifyDeliveryOutcome('RECLAMAR EN OFICINA')).toBe('en_proceso');
  });
  it('otro / vacío', () => {
    expect(classifyDeliveryOutcome('PENDIENTE CONFIRMACION')).toBe('otro');
    expect(classifyDeliveryOutcome('')).toBe('otro');
    expect(classifyDeliveryOutcome(null)).toBe('otro');
  });
});

describe('normalizeNovedadLabel / novedadGroupKey', () => {
  it('vacío → "Sin descripción"', () => {
    expect(normalizeNovedadLabel('')).toBe('Sin descripción');
    expect(normalizeNovedadLabel(null)).toBe('Sin descripción');
    expect(normalizeNovedadLabel('   ')).toBe('Sin descripción');
  });
  it('colapsa espacios', () => {
    expect(normalizeNovedadLabel('  cliente   no   estaba  ')).toBe('cliente no estaba');
  });
  it('groupKey agrupa variantes de mayúsculas/acentos', () => {
    expect(novedadGroupKey('Dirección errada')).toBe(novedadGroupKey('direccion ERRADA'));
  });
});

describe('formatDuration', () => {
  it('rangos', () => {
    expect(formatDuration(30 * 1000)).toBe('<1m');
    expect(formatDuration(45 * 60 * 1000)).toBe('45m');
    expect(formatDuration((60 + 20) * 60 * 1000)).toBe('1h 20m');
    expect(formatDuration(2 * 60 * 60 * 1000)).toBe('2h');
    expect(formatDuration((2 * 24 + 3) * 60 * 60 * 1000)).toBe('2d 3h');
    expect(formatDuration(2 * 24 * 60 * 60 * 1000)).toBe('2d');
  });
  it('inválidos → guion', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(-5)).toBe('—');
    expect(formatDuration(Infinity)).toBe('—');
  });
});

describe('bogotaDateNDaysAgo', () => {
  it('resta días calendario', () => {
    expect(bogotaDateNDaysAgo('2026-06-23', 0)).toBe('2026-06-23');
    expect(bogotaDateNDaysAgo('2026-06-23', 6)).toBe('2026-06-17');
  });
  it('cruza límite de mes', () => {
    expect(bogotaDateNDaysAgo('2026-06-02', 5)).toBe('2026-05-28');
  });
  it('cruza límite de año', () => {
    expect(bogotaDateNDaysAgo('2026-01-03', 5)).toBe('2025-12-29');
  });
});
