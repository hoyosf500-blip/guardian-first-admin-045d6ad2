import { describe, it, expect } from 'vitest';
import { SEG_LISTS, findSegList, isValidSegListSlug } from './segLists';
import type { OrderData } from './orderUtils';

/**
 * Tests deterministas: setean `fecha: ''` + `dias: N` para forzar el fallback
 * `diasDesdeCreacion → o.dias`. Esto evita jitter por fines de semana/feriados
 * que afectaría a `calcBusinessDays` si usáramos una fecha calendárica real.
 */

const baseOrder: OrderData = {
  idx: 0,
  id: '0',
  externalId: 'X-1',
  dbId: 'X-1',
  nombre: 'Test',
  phone: '3001234567',
  ciudad: 'BOGOTA',
  departamento: 'CUNDINAMARCA',
  producto: 'Test',
  estado: 'PENDIENTE',
  fecha: '',
  fechaConf: '',
  dias: 0,
  diasConf: 0,
  valor: 100000,
  flete: 8000,
  costoProd: 30000,
  costoDev: 0,
  cantidad: 1,
  direccion: 'Cl 1 # 1-1',
  novedad: '',
  guia: '',
  transportadora: '',
  tags: '',
  tienda: '',
  email: '',
  novedadSol: false,
  barrio: '',
  complemento: '',
  documentoDestinatario: '',
  googlePlaceId: '',
  lat: null,
  lng: null,
  validationDecision: null,
  addressKind: null,
  missingFields: [],
  suggestedCustomerMessage: '',
  suggestedAddress: null,
  addressParsed: null,
};

describe('SEG_LISTS — definición', () => {
  it('exporta exactamente 8 listas', () => {
    expect(SEG_LISTS).toHaveLength(8);
  });

  it('orden mantiene paridad con Boostec (confirmación primero, otros al final)', () => {
    expect(SEG_LISTS[0].slug).toBe('pendientes_confirmacion_2d');
    expect(SEG_LISTS[SEG_LISTS.length - 1].slug).toBe('otros_estados');
  });

  it('pendientes_confirmacion_2d tiene externalRoute /confirmar y nunca matchea', () => {
    const lista = findSegList('pendientes_confirmacion_2d')!;
    expect(lista.externalRoute).toBe('/confirmar');
    expect(lista.matches({ ...baseOrder, estado: 'PENDIENTE CONFIRMACION', dias: 5 })).toBe(false);
  });
});

describe('SEG_LISTS — predicados', () => {
  // Para tests deterministas usamos `fecha: ''` y seteamos `dias` directamente —
  // diasDesdeCreacion() cae al fallback de `o.dias` cuando la fecha está vacía,
  // evitando jitter por fines de semana/feriados de calcBusinessDays.

  it('pendientes_guia_2d: PENDIENTE sin guía, 3 días → matchea', () => {
    const lista = findSegList('pendientes_guia_2d')!;
    const o: OrderData = { ...baseOrder, estado: 'PENDIENTE', guia: '', fecha: '', dias: 3 };
    expect(lista.matches(o)).toBe(true);
  });

  it('pendientes_guia_2d: PENDIENTE con guía generada NO matchea', () => {
    const lista = findSegList('pendientes_guia_2d')!;
    const o: OrderData = { ...baseOrder, estado: 'PENDIENTE', guia: 'ABC123', fecha: '', dias: 3 };
    expect(lista.matches(o)).toBe(false);
  });

  it('indem_pendientes_guia_4d: 5 días → matchea acá, NO en pendientes_guia_2d (sin duplicar)', () => {
    const indem = findSegList('indem_pendientes_guia_4d')!;
    const pend = findSegList('pendientes_guia_2d')!;
    const o: OrderData = { ...baseOrder, estado: 'PENDIENTE', guia: '', fecha: '', dias: 5 };
    expect(indem.matches(o)).toBe(true);
    expect(pend.matches(o)).toBe(false);
  });

  it('guia_generada_2d: estado GUIA GENERADA, 3 días → matchea', () => {
    const lista = findSegList('guia_generada_2d')!;
    const o: OrderData = { ...baseOrder, estado: 'GUIA GENERADA', fecha: '', dias: 3 };
    expect(lista.matches(o)).toBe(true);
  });

  it('indem_guia_generada_5d: ADMITIDA con 6 días → matchea (alias de guía generada)', () => {
    const lista = findSegList('indem_guia_generada_5d')!;
    const o: OrderData = { ...baseOrder, estado: 'ADMITIDA', fecha: '', dias: 6 };
    expect(lista.matches(o)).toBe(true);
  });

  it('guia_generada_2d con 6 días NO matchea (cae en indem)', () => {
    const lista = findSegList('guia_generada_2d')!;
    const o: OrderData = { ...baseOrder, estado: 'GUIA GENERADA', fecha: '', dias: 6 };
    expect(lista.matches(o)).toBe(false);
  });

  it('reclamar_oficina_4d: estado con RECLAMAR, 5 días → matchea', () => {
    const lista = findSegList('reclamar_oficina_4d')!;
    const o: OrderData = { ...baseOrder, estado: 'RECLAMAR EN OFICINA', fecha: '', dias: 5 };
    expect(lista.matches(o)).toBe(true);
  });

  it('en_proceso_7d: EN TRANSPORTE 8 días → matchea', () => {
    const lista = findSegList('en_proceso_7d')!;
    const o: OrderData = { ...baseOrder, estado: 'EN TRANSPORTE', fecha: '', dias: 8 };
    expect(lista.matches(o)).toBe(true);
  });

  it('en_proceso_7d: EN REPARTO 3 días NO matchea (no llegó al SLA)', () => {
    const lista = findSegList('en_proceso_7d')!;
    const o: OrderData = { ...baseOrder, estado: 'EN REPARTO', fecha: '', dias: 3 };
    expect(lista.matches(o)).toBe(false);
  });

  it('otros_estados: estado raro (NOVEDAD) → matchea solo aquí', () => {
    const otros = findSegList('otros_estados')!;
    const o: OrderData = { ...baseOrder, estado: 'NOVEDAD', fecha: '', dias: 1 };
    expect(otros.matches(o)).toBe(true);
    // ninguna otra lista debería matchear NOVEDAD
    for (const lista of SEG_LISTS) {
      if (lista.slug === 'otros_estados') continue;
      expect(lista.matches(o)).toBe(false);
    }
  });

  it('estados terminales (ENTREGADO/CANCELADO/DEVOLUCION) NO matchean ninguna lista', () => {
    for (const estadoTerminal of ['ENTREGADO', 'CANCELADO', 'DEVOLUCION']) {
      const o: OrderData = { ...baseOrder, estado: estadoTerminal, fecha: '', dias: 10 };
      for (const lista of SEG_LISTS) {
        expect(lista.matches(o), `${lista.slug} no debe matchear ${estadoTerminal}`).toBe(false);
      }
    }
  });

  it('fallback a o.dias cuando fecha es inválida/vacía', () => {
    const lista = findSegList('en_proceso_7d')!;
    const o: OrderData = { ...baseOrder, estado: 'EN TRANSPORTE', fecha: '', dias: 8 };
    expect(lista.matches(o)).toBe(true);
  });
});

describe('helpers', () => {
  it('isValidSegListSlug acepta slugs válidos', () => {
    expect(isValidSegListSlug('pendientes_guia_2d')).toBe(true);
    expect(isValidSegListSlug('otros_estados')).toBe(true);
  });

  it('isValidSegListSlug rechaza slugs inválidos / null / vacío', () => {
    expect(isValidSegListSlug('foo_bar')).toBe(false);
    expect(isValidSegListSlug(null)).toBe(false);
    expect(isValidSegListSlug('')).toBe(false);
    expect(isValidSegListSlug(undefined)).toBe(false);
  });
});
