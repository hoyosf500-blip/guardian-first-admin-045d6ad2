import { describe, it, expect } from 'vitest';
import { classifySegEstado, matchOficina, matchTransito } from './segStatus';

// Regression: SeguimientoTab antes tenía su propio clasificador que no
// reconocía variantes EC → pedidos EC caían en 'otros' y el resumen mostraba
// solo 3 cards mientras el Kanban abajo sí los agrupaba correctamente. Estos
// tests blindan los estados EC reales que vimos en producción.

describe('classifySegEstado', () => {
  // Los seis estados que el 31-jul-2026 estaban SIN CLASIFICAR en el tablero en
  // vivo de Rushmira Ecuador (238 pedidos entre todos). Se leyeron de la pantalla
  // real, no se inventaron. Si Dropi les cambia el texto, este test lo delata.
  describe('estados EC vistos en producción el 31-jul-2026', () => {
    it.each([
      ['ZONA DE ENTREGA', 'reparto'],
      ['EN DISTRIBUCIÓN A CLIENTE', 'reparto'],
      ['EN DISTRIBUCION A CLIENTE', 'reparto'],
      ['POR RECOLECTAR', 'guia'],
      ['EN DISTRIBUCION PARA ENTREGA EN AGENCIA', 'oficina'],
      ['EN PROCESO DE DEVOLUCION', 'devolucion_transito'],
      ['INGRESO A CONFIRMACION', 'procesamiento'],
    ])('%s → %s', (estado, esperado) => {
      expect(classifySegEstado(estado)).toBe(esperado);
    });

    it('NINGUNO cae ya en el cajón sin clasificar', () => {
      for (const e of ['ZONA DE ENTREGA', 'POR RECOLECTAR', 'EN DISTRIBUCIÓN A CLIENTE',
        'EN DISTRIBUCION PARA ENTREGA EN AGENCIA', 'EN PROCESO DE DEVOLUCION', 'INGRESO A CONFIRMACION']) {
        expect(classifySegEstado(e)).not.toBe('otros');
      }
    });

    it('"EN DISTRIBUCION" pelado sigue siendo tránsito', () => {
      // El matcher de reparto es EXACTO justamente para no tragarse este.
      expect(classifySegEstado('EN DISTRIBUCION')).toBe('transito');
    });
  });

  describe('procesamiento', () => {
    it.each([
      'PENDIENTE',
      'EN PROCESAMIENTO',
      'ALISTAMIENTO',
      'EN BODEGA DROPI',
      'RECOGIDO POR DROPI',
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
      // "droop" = drop point (CO): punto de retiro donde el cliente recoge.
      // Antes estaba en PROCESAMIENTO_EXACT y el Kanban le escondía la
      // urgencia mientras el paquete vencía en el punto.
      'EN PUNTO DROOP',
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
    // Variante EC vista en consola Rushmira Ecuador 2026-05-28: Dropi usa
    // "SOLUCION APROBADA" para algunos casos en lugar de NOVEDAD SOLUCIONADA.
    it('SOLUCION APROBADA (variante EC) tambien va a novedad_sol', () =>
      expect(classifySegEstado('SOLUCION APROBADA')).toBe('novedad_sol'));
  });

  describe('terminales', () => {
    it('ENTREGADO', () => expect(classifySegEstado('ENTREGADO')).toBe('entregado'));
    it('CANCELADO', () => expect(classifySegEstado('CANCELADO')).toBe('cancelado'));
    it('REEMPLAZADA (orden vieja soft-borrada por una edición)', () =>
      expect(classifySegEstado('REEMPLAZADA')).toBe('cancelado'));
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

// Regression: el commit 05f6363 movió matchTransito/matchOficina a este módulo
// como const PRIVADOS, pero CrmTable.tsx:STALLED_LABEL_TO_MATCH los seguía
// referenciando → "matchOficina is not defined" al cargar el módulo →
// /seguimiento crasheaba. Estos tests blindan el contrato: si alguien remueve
// el `export`, el test rompe ANTES de que llegue a producción.
describe('matchers exportados (consumidos por STALLED_LABEL_TO_MATCH en CrmTable)', () => {
  it('matchTransito existe como función', () => {
    expect(typeof matchTransito).toBe('function');
  });
  it('matchTransito reconoce variantes EC', () => {
    expect(matchTransito('EN RUTA A CENTRO LOGISTICO')).toBe(true);
    expect(matchTransito('INGRESANDO DE RECEPCION')).toBe(true);
    expect(matchTransito('ASIGNADO A GINTRACOM')).toBe(true);
  });
  it('matchTransito rechaza estados que no son tránsito', () => {
    expect(matchTransito('ENTREGADO')).toBe(false);
    expect(matchTransito('NOVEDAD')).toBe(false);
  });

  it('matchOficina existe como función', () => {
    expect(typeof matchOficina).toBe('function');
  });
  it('matchOficina reconoce variantes CO + EC', () => {
    expect(matchOficina('RECLAME EN OFICINA')).toBe(true);
    expect(matchOficina('PARA RETIRO EN AGENCIA')).toBe(true);
    expect(matchOficina('EN PUNTO DE RETIRO')).toBe(true);
  });
  it('matchOficina rechaza estados que no son oficina', () => {
    expect(matchOficina('EN TRANSPORTE')).toBe(false);
    expect(matchOficina('ENTREGADO')).toBe(false);
  });
});
