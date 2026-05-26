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
  lastMovementAt: null,
};

describe('SEG_LISTS — definición (embudo por prioridad)', () => {
  it('exporta exactamente 9 listas', () => {
    expect(SEG_LISTS).toHaveLength(9);
  });

  it('orden: confirmación → final (oficina/reparto) → medio → inicial → otros', () => {
    const slugs = SEG_LISTS.map((l) => l.slug);
    expect(slugs[0]).toBe('pendientes_confirmacion_2d');
    expect(slugs[1]).toBe('en_oficina');
    expect(slugs[2]).toBe('en_reparto_novedad');
    expect(slugs[3]).toBe('en_transito');
    expect(slugs[slugs.length - 1]).toBe('otros_estados');
  });

  it('pendientes_confirmacion_2d tiene externalRoute /confirmar y nunca matchea', () => {
    const lista = findSegList('pendientes_confirmacion_2d')!;
    expect(lista.externalRoute).toBe('/confirmar');
    expect(lista.matches({ ...baseOrder, estado: 'PENDIENTE CONFIRMACION', dias: 5 })).toBe(false);
  });
});

describe('SEG_LISTS — predicados de fase (sin umbral de SLA)', () => {
  it('en_oficina: RECLAMAR EN OFICINA → matchea sin importar días', () => {
    const lista = findSegList('en_oficina')!;
    expect(lista.matches({ ...baseOrder, estado: 'RECLAMAR EN OFICINA', dias: 1 })).toBe(true);
    expect(lista.matches({ ...baseOrder, estado: 'EN PUNTO DE ENTREGA', dias: 0 })).toBe(true);
  });

  it('en_reparto_novedad: EN REPARTO / NOVEDAD / INTENTO DE ENTREGA → matchea', () => {
    const lista = findSegList('en_reparto_novedad')!;
    expect(lista.matches({ ...baseOrder, estado: 'EN REPARTO', dias: 0 })).toBe(true);
    expect(lista.matches({ ...baseOrder, estado: 'NOVEDAD', dias: 1 })).toBe(true);
    expect(lista.matches({ ...baseOrder, estado: 'INTENTO DE ENTREGA', dias: 2 })).toBe(true);
  });

  it('en_transito: EN TRANSPORTE recién creado → matchea (no requiere +7d)', () => {
    const lista = findSegList('en_transito')!;
    expect(lista.matches({ ...baseOrder, estado: 'EN TRANSPORTE', dias: 1 })).toBe(true);
    expect(lista.matches({ ...baseOrder, estado: 'EN TRANSPORTE', dias: 10 })).toBe(true);
  });
});

describe('SEG_LISTS — predicados iniciales con indem disjoint', () => {
  it('pendientes_guia: PENDIENTE sin guía, 1 día → matchea (no exige +2d)', () => {
    const lista = findSegList('pendientes_guia')!;
    const o: OrderData = { ...baseOrder, estado: 'PENDIENTE', guia: '', fecha: '', dias: 1 };
    expect(lista.matches(o)).toBe(true);
  });

  it('pendientes_guia: PENDIENTE con guía generada NO matchea', () => {
    const lista = findSegList('pendientes_guia')!;
    const o: OrderData = { ...baseOrder, estado: 'PENDIENTE', guia: 'ABC123', fecha: '', dias: 3 };
    expect(lista.matches(o)).toBe(false);
  });

  it('indem_pendientes_guia_4d: 5d → matchea SOLO en indem (disjoint de pendientes_guia)', () => {
    const indem = findSegList('indem_pendientes_guia_4d')!;
    const pend = findSegList('pendientes_guia')!;
    const o: OrderData = { ...baseOrder, estado: 'PENDIENTE', guia: '', fecha: '', dias: 5 };
    expect(indem.matches(o)).toBe(true);
    expect(pend.matches(o)).toBe(false);
  });

  it('guia_generada: GUIA GENERADA recién → matchea (no exige +2d)', () => {
    const lista = findSegList('guia_generada')!;
    const o: OrderData = { ...baseOrder, estado: 'GUIA GENERADA', fecha: '', dias: 1 };
    expect(lista.matches(o)).toBe(true);
  });

  it('indem_guia_generada_5d: ADMITIDA 6d → matchea acá, NO en guia_generada', () => {
    const indem = findSegList('indem_guia_generada_5d')!;
    const gg = findSegList('guia_generada')!;
    const o: OrderData = { ...baseOrder, estado: 'ADMITIDA', fecha: '', dias: 6 };
    expect(indem.matches(o)).toBe(true);
    expect(gg.matches(o)).toBe(false);
  });
});

describe('SEG_LISTS — catch-all y terminales', () => {
  it('otros_estados: estado raro inventado → matchea solo aquí', () => {
    const otros = findSegList('otros_estados')!;
    const o: OrderData = { ...baseOrder, estado: 'ESTADO_INVENTADO', fecha: '', dias: 1 };
    expect(otros.matches(o)).toBe(true);
    for (const lista of SEG_LISTS) {
      if (lista.slug === 'otros_estados') continue;
      expect(lista.matches(o)).toBe(false);
    }
  });

  it('estados terminales (ENTREGADO/CANCELADO/DEVOLUCION/INDEMNIZADA) NO matchean ninguna lista', () => {
    for (const estadoTerminal of ['ENTREGADO', 'CANCELADO', 'DEVOLUCION', 'INDEMNIZADA']) {
      const o: OrderData = { ...baseOrder, estado: estadoTerminal, fecha: '', dias: 10 };
      for (const lista of SEG_LISTS) {
        expect(lista.matches(o), `${lista.slug} no debe matchear ${estadoTerminal}`).toBe(false);
      }
    }
  });
});

describe('SEG_LISTS — días sin movimiento (lastMovementAt)', () => {
  const hoyIso = new Date().toISOString();

  it('guía generada VIEJA (10d) pero movida HOY → NO cae en indemnización', () => {
    const indem = findSegList('indem_guia_generada_5d')!;
    const stale: OrderData = { ...baseOrder, estado: 'GUIA GENERADA', fecha: '', dias: 10 };
    expect(indem.matches(stale)).toBe(true);
    const movedToday: OrderData = { ...stale, lastMovementAt: hoyIso };
    expect(indem.matches(movedToday)).toBe(false);
  });

  it('guía generada movida HOY cae en guia_generada (recien movida, 0d sin movimiento)', () => {
    const lista = findSegList('guia_generada')!;
    const movedToday: OrderData = { ...baseOrder, estado: 'GUIA GENERADA', fecha: '', dias: 10, lastMovementAt: hoyIso };
    expect(lista.matches(movedToday)).toBe(true);
  });

  it('pendientes_guia sigue usando antigüedad desde CREACIÓN (sin guía → no hay movimiento real)', () => {
    const lista = findSegList('pendientes_guia')!;
    const o: OrderData = { ...baseOrder, estado: 'PENDIENTE', guia: '', fecha: '', dias: 3, lastMovementAt: new Date().toISOString() };
    expect(lista.matches(o)).toBe(true);
  });
});

describe('helpers', () => {
  it('isValidSegListSlug acepta slugs válidos nuevos', () => {
    expect(isValidSegListSlug('pendientes_guia')).toBe(true);
    expect(isValidSegListSlug('en_oficina')).toBe(true);
    expect(isValidSegListSlug('en_reparto_novedad')).toBe(true);
    expect(isValidSegListSlug('en_transito')).toBe(true);
    expect(isValidSegListSlug('guia_generada')).toBe(true);
    expect(isValidSegListSlug('otros_estados')).toBe(true);
  });

  it('isValidSegListSlug rechaza slugs viejos / inválidos / null', () => {
    expect(isValidSegListSlug('pendientes_guia_2d')).toBe(false); // viejo
    expect(isValidSegListSlug('en_proceso_7d')).toBe(false); // viejo
    expect(isValidSegListSlug('foo_bar')).toBe(false);
    expect(isValidSegListSlug(null)).toBe(false);
    expect(isValidSegListSlug('')).toBe(false);
    expect(isValidSegListSlug(undefined)).toBe(false);
  });
});
