import { describe, it, expect } from 'vitest';
import { classifySegEstado } from './segStatus';

// Regression: SeguimientoTab antes tenía su propio clasificador que no
// reconocía variantes EC → pedidos EC caían en 'otros' y el resumen mostraba
// solo 3 cards mientras el Kanban abajo sí los agrupaba correctamente. Estos
// tests blindan los estados EC reales que vimos en producción.

describe('classifySegEstado', () => {
  describe('procesamiento', () => {
    it.each([
      'PENDIENTE',
      'EN PROCESAMIENTO',
      'ALISTAMIENTO',
      'EN BODEGA DROPI',
      'RECOGIDO POR DROPI',
      'EN PUNTO DROOP',
    ])('clasifica %s como procesamiento', (e) => {
      expect(classifySegEstado(e)).toBe('procesamiento');
    });
  });

  describe('guia', () => {
    it.each(['GUIA GENERADA', 'GUIA_GENERADA', 'PREPARADO PARA TRANSPORTADORA'])(
      'clasifica %s como guia',
      (e) => expect(classifySegEstado(e)).toBe('guia'),
    );
  });

  describe('transito (CO + EC)', () => {
    it.each([
      'EN TRANSPORTE',
      'EN DESPACHO',
      'EN TERMINAL ORIGEN',
      // ── EC ────────────────────────────────────────────────────────────
      'EN RUTA A CENTRO LOGISTICO',
      'EN RUTA A CONCESION',
      'INGRESANDO DE RECEPCION',
      'INGRESANDO OPERATIVO A QUITO',
      'ASIGNADO A GINTRACOM',
    ])('clasifica %s como transito', (e) => {
      expect(classifySegEstado(e)).toBe('transito');
    });
  });

  describe('oficina (CO + EC)', () => {
    it.each([
      'RECLAME EN OFICINA',
      'EN OFICINA',
      // ── EC ────────────────────────────────────────────────────────────
      'PARA RETIRO EN AGENCIA',
      'PARA RETIRO EN OFICINA GUAYAQUIL',
      'EN PUNTO DE RETIRO',
    ])('clasifica %s como oficina', (e) => {
      expect(classifySegEstado(e)).toBe('oficina');
    });
  });

  describe('novedad', () => {
    it('clasifica NOVEDAD', () => expect(classifySegEstado('NOVEDAD')).toBe('novedad'));
    it('clasifica INTENTO DE ENTREGA', () =>
      expect(classifySegEstado('INTENTO DE ENTREGA')).toBe('novedad'));
    it('NOVEDAD SOLUCIONADA es categoría aparte', () =>
      expect(classifySegEstado('NOVEDAD SOLUCIONADA')).toBe('novedad_sol'));
  });

  describe('terminales', () => {
    it('ENTREGADO', () => expect(classifySegEstado('ENTREGADO')).toBe('entregado'));
    it('CANCELADO', () => expect(classifySegEstado('CANCELADO')).toBe('cancelado'));
    it('DEVOLUCION', () => expect(classifySegEstado('DEVOLUCION')).toBe('devolucion'));
    it('DEVOLUCION EN TRANSITO va a su categoría propia', () =>
      expect(classifySegEstado('DEVOLUCION EN TRANSITO')).toBe('devolucion_transito'));
    it('ORDEN INDEMNIZADA', () =>
      expect(classifySegEstado('ORDEN INDEMNIZADA')).toBe('indemnizada'));
  });

  describe('robustez', () => {
    it('acepta lowercase', () =>
      expect(classifySegEstado('en transporte')).toBe('transito'));
    it('acepta mixed case + espacios', () =>
      expect(classifySegEstado('  En Reparto  ')).toBe('reparto'));
    it('vacío → otros', () => expect(classifySegEstado('')).toBe('otros'));
    it('desconocido → otros', () =>
      expect(classifySegEstado('ESTADO_RARO_NUEVO')).toBe('otros'));
  });
});
