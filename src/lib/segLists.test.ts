import { describe, it, expect } from 'vitest';
import { SEG_LISTS, findSegList, isValidSegListSlug, hasSeguimientoWork } from './segLists';
import type { SegListSlug } from './segLists';
import { classifySegEstado } from './segStatus';
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
  productosDetalle: [],
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

  it('estados terminales (ENTREGADO/CANCELADO/REEMPLAZADA/DEVOLUCION/INDEMNIZADA) NO matchean ninguna lista', () => {
    for (const estadoTerminal of ['ENTREGADO', 'CANCELADO', 'REEMPLAZADA', 'DEVOLUCION', 'INDEMNIZADA']) {
      const o: OrderData = { ...baseOrder, estado: estadoTerminal, fecha: '', dias: 10 };
      for (const lista of SEG_LISTS) {
        expect(lista.matches(o), `${lista.slug} no debe matchear ${estadoTerminal}`).toBe(false);
      }
    }
  });

  it('ARCHIVADO GHOST (borrado en Dropi) NO es trabajo: no matchea ninguna lista, ni con espacio ni con guion bajo', () => {
    // 'ARCHIVADO GHOST' (CON espacio) es lo que escribe dropi-nightly-reconcile
    // en la DB; el guion bajo sobrevive en mapas TS viejos. Ninguna de las dos
    // variantes puede caer en "otros_estados" — es un pedido que Dropi borró.
    for (const estadoGhost of ['ARCHIVADO GHOST', 'ARCHIVADO_GHOST']) {
      const o: OrderData = { ...baseOrder, estado: estadoGhost, fecha: '', dias: 10 };
      for (const lista of SEG_LISTS) {
        expect(lista.matches(o), `${lista.slug} no debe matchear ${estadoGhost}`).toBe(false);
      }
    }
  });
});

describe('SEG_LISTS — estados de ECUADOR', () => {
  // Los terminales de EC ('ENTREGADO A DESTINO', 'DEVOLUCION A ORIGEN') y las
  // variantes por transportadora ('CANCELADO POR ...') matcheaban predicados de
  // fase: como el estado ya no cambia más, el pedido quedaba clavado en la cola
  // y la asesora llamaba a clientes que ya tenían el paquete.
  const TERMINALES_EC = [
    'ENTREGADO A DESTINO',
    'DEVOLUCION A ORIGEN',
    'DEVOLUCIÓN A ORIGEN',
    'DEVUELTO',
    'DEVUELTO A ORIGEN',
    'CANCELADO POR TRANSPORTADORA',
    'RECHAZADO POR EL CLIENTE',
  ];

  it('terminales EC no matchean NINGUNA lista', () => {
    for (const estado of TERMINALES_EC) {
      const o: OrderData = { ...baseOrder, estado, fecha: '', dias: 12 };
      for (const lista of SEG_LISTS) {
        expect(lista.matches(o), `${lista.slug} no debe matchear ${estado}`).toBe(false);
      }
    }
  });

  it('terminales EC no cuentan como trabajo accionable', () => {
    expect(hasSeguimientoWork(TERMINALES_EC.map((estado) => ({ ...baseOrder, estado, dias: 12 })))).toBe(false);
  });

  it('tránsito EC (EN CAMINO / EN TRÁNSITO con tilde / EN BODEGA) cae en en_transito, no en otros', () => {
    const transito = findSegList('en_transito')!;
    const otros = findSegList('otros_estados')!;
    for (const estado of ['EN CAMINO', 'EN TRANSITO', 'EN TRÁNSITO', 'EN BODEGA', 'DISTRIBUCION PARA ENTREGA']) {
      const o: OrderData = { ...baseOrder, estado, fecha: '', dias: 3 };
      expect(transito.matches(o), `en_transito debe matchear ${estado}`).toBe(true);
      expect(otros.matches(o), `otros_estados NO debe matchear ${estado}`).toBe(false);
    }
  });

  // Los estados que el 31-jul-2026, con el CRM ya publicado, seguían cayendo en
  // "Otros estados" (46 pedidos) aunque el Tablero ya sabía qué eran. Se leyeron
  // de la pantalla en vivo de Rushmira Ecuador. Cada uno va a su lista de fase.
  describe('los que quedaban en "Otros estados" con el clasificador viejo', () => {
    it.each([
      ['ZONA DE ENTREGA', 'en_reparto_novedad'],
      ['EN DISTRIBUCIÓN A CLIENTE', 'en_reparto_novedad'],
      ['POR RECOLECTAR', 'guia_generada'],
      ['EN DISTRIBUCION PARA ENTREGA EN AGENCIA', 'en_oficina'],
      ['INGRESO A CONFIRMACION', 'pendientes_guia'],
    ])('%s cae SOLO en %s', (estado, slug) => {
      const o: OrderData = { ...baseOrder, estado, guia: '', fecha: '', dias: 1 };
      expect(SEG_LISTS.filter((l) => l.matches(o)).map((l) => l.slug)).toEqual([slug]);
    });

    it('última milla EC cuenta como TRABAJO, no como monitoreo', () => {
      // 56 pedidos en ZONA DE ENTREGA se monitoreaban como "en tránsito": el
      // guard de inactividad creía que no había nada que hacer mientras el
      // repartidor ya estaba en la calle con la plata del día.
      expect(hasSeguimientoWork([{ ...baseOrder, estado: 'ZONA DE ENTREGA', dias: 1 }])).toBe(true);
    });
  });

  // El Tablero y la Lista salen del MISMO clasificador (segStatus.ts). Si
  // alguien vuelve a escribir matchers paralelos acá, este test lo delata: era
  // el bug que hacía decir "91 en tránsito" arriba y "36" abajo.
  it('Lista y Tablero coinciden: ninguna fase viva se queda sin lista', () => {
    const porFase: Record<string, SegListSlug> = {
      procesamiento: 'pendientes_guia',
      guia: 'guia_generada',
      bodega_trans: 'guia_generada',
      transito: 'en_transito',
      reparto: 'en_reparto_novedad',
      novedad: 'en_reparto_novedad',
      novedad_sol: 'en_reparto_novedad',
      oficina: 'en_oficina',
    };
    const ejemplos: [string, string][] = [
      ['PENDIENTE', 'procesamiento'],
      ['GUIA GENERADA', 'guia'],
      ['ADMITIDA', 'bodega_trans'],
      ['EN TRANSPORTE', 'transito'],
      ['EN REPARTO', 'reparto'],
      ['NOVEDAD', 'novedad'],
      ['NOVEDAD SOLUCIONADA', 'novedad_sol'],
      ['RECLAMAR EN OFICINA', 'oficina'],
    ];
    for (const [estado, fase] of ejemplos) {
      expect(classifySegEstado(estado), `${estado} debe clasificar como ${fase}`).toBe(fase);
      const o: OrderData = { ...baseOrder, estado, guia: '', fecha: '', dias: 1 };
      expect(SEG_LISTS.filter((l) => l.matches(o)).map((l) => l.slug)).toEqual([porFase[fase]]);
    }
  });
});

describe('SEG_LISTS — tramo pre-guía (CONFIRMADO / GENERADO)', () => {
  it('CONFIRMADO sin guía y 5d cae SOLO en indem_pendientes_guia_4d', () => {
    const o: OrderData = { ...baseOrder, estado: 'CONFIRMADO', guia: '', fecha: '', dias: 5 };
    const matched = SEG_LISTS.filter((l) => l.matches(o)).map((l) => l.slug);
    expect(matched).toEqual(['indem_pendientes_guia_4d']);
  });

  it('GENERADO sin guía y 1d cae SOLO en pendientes_guia (accionable)', () => {
    const o: OrderData = { ...baseOrder, estado: 'GENERADO', guia: '', fecha: '', dias: 1 };
    const matched = SEG_LISTS.filter((l) => l.matches(o)).map((l) => l.slug);
    expect(matched).toEqual(['pendientes_guia']);
    expect(hasSeguimientoWork([o])).toBe(true);
  });

  it('CONFIRMADO CON guía ya no es "pendiente de guía" — queda visible en otros_estados', () => {
    const o: OrderData = { ...baseOrder, estado: 'CONFIRMADO', guia: 'ABC123', fecha: '', dias: 5 };
    const matched = SEG_LISTS.filter((l) => l.matches(o)).map((l) => l.slug);
    expect(matched).toEqual(['otros_estados']);
  });

  it('GUIA_GENERADA con guion bajo se normaliza a la lista de guía generada', () => {
    const o: OrderData = { ...baseOrder, estado: 'GUIA_GENERADA', fecha: '', dias: 1 };
    expect(findSegList('guia_generada')!.matches(o)).toBe(true);
  });
});

describe('SEG_LISTS — las listas son DISJUNTAS', () => {
  it('ningún estado cae en dos listas a la vez', () => {
    const estados = [
      'PENDIENTE', 'PENDIENTE CONFIRMACION', 'CONFIRMADO', 'GENERADO',
      'GUIA GENERADA', 'ADMITIDA', 'ENTREGADO A TRANSPORTADORA',
      'EN TRANSPORTE', 'EN TRANSITO', 'EN TRÁNSITO', 'EN CAMINO', 'EN BODEGA',
      'EN RUTA A CENTRO LOGISTICO', 'ASIGNADO A GINTRACOM', 'ZONA DE ENTREGA',
      'EN REPARTO', 'NOVEDAD', 'INTENTO DE ENTREGA',
      'RECLAMAR EN OFICINA', 'PARA RETIRO EN AGENCIA SERVIENTREGA', 'EN PUNTO DROOP',
      'ENTREGADO', 'ENTREGADO A DESTINO', 'DEVOLUCION A ORIGEN', 'CANCELADO',
      'ESTADO_RARO_NUEVO',
    ];
    for (const estado of estados) {
      for (const dias of [1, 6]) {
        const o: OrderData = { ...baseOrder, estado, guia: '', fecha: '', dias };
        const matched = SEG_LISTS.filter((l) => l.matches(o)).map((l) => l.slug);
        expect(matched.length, `${estado} (${dias}d) cayó en ${matched.join(' + ')}`).toBeLessThanOrEqual(1);
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

describe('hasSeguimientoWork — gate del guard de inactividad', () => {
  it('false sin pedidos', () => {
    expect(hasSeguimientoWork([])).toBe(false);
  });

  it('true con EN REPARTO / NOVEDAD (accionable)', () => {
    expect(hasSeguimientoWork([{ ...baseOrder, estado: 'NOVEDAD' }])).toBe(true);
    expect(hasSeguimientoWork([{ ...baseOrder, estado: 'EN REPARTO' }])).toBe(true);
  });

  it('true con cliente en oficina (accionable)', () => {
    expect(hasSeguimientoWork([{ ...baseOrder, estado: 'RECLAMAR EN OFICINA' }])).toBe(true);
  });

  it('true con pendiente de guía sin guía (accionable)', () => {
    expect(hasSeguimientoWork([{ ...baseOrder, estado: 'PENDIENTE', guia: '', dias: 1 }])).toBe(true);
  });

  it('FALSE con solo monitoreo (en tránsito) — no es trabajo accionable', () => {
    expect(hasSeguimientoWork([
      { ...baseOrder, estado: 'EN TRANSPORTE' },
      { ...baseOrder, estado: 'EN DISTRIBUCION' },
    ])).toBe(false);
  });

  it('FALSE con guía generada reciente (monitoreo, no accionable)', () => {
    expect(hasSeguimientoWork([{ ...baseOrder, estado: 'GUIA GENERADA', dias: 1 }])).toBe(false);
  });

  it('FALSE con solo terminales (entregado/devuelto/archivado ghost)', () => {
    expect(hasSeguimientoWork([
      { ...baseOrder, estado: 'ENTREGADO' },
      { ...baseOrder, estado: 'DEVOLUCION' },
      { ...baseOrder, estado: 'ARCHIVADO GHOST' },
    ])).toBe(false);
  });

  it('true si AL MENOS uno es accionable aunque el resto sea monitoreo', () => {
    expect(hasSeguimientoWork([
      { ...baseOrder, estado: 'EN TRANSPORTE' },
      { ...baseOrder, estado: 'NOVEDAD' },
      { ...baseOrder, estado: 'ENTREGADO' },
    ])).toBe(true);
  });
});
