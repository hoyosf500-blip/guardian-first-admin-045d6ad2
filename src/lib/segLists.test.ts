import { describe, it, expect } from 'vitest';
import { SEG_LISTS, findSegList, isValidSegListSlug, hasSeguimientoWork, seMuestraComoChip, ACTIONABLE_SEG_SLUGS, esAccionable } from './segLists';
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
  it('exporta exactamente 13 listas', () => {
    expect(SEG_LISTS).toHaveLength(13);
  });

  it('orden: confirmación → detenidos → agencia vencida → devolución reciente → final (oficina/reparto) → medio → inicial → otros', () => {
    const slugs = SEG_LISTS.map((l) => l.slug);
    expect(slugs[0]).toBe('pendientes_confirmacion_2d');
    // Los detenidos van arriba: son los que se están pudriendo, sin importar
    // en qué fase estén.
    expect(slugs[1]).toBe('detenidos_3d');
    // La agencia vencida va pegada: es la plata más fácil de perder (el
    // courier devuelve a los ~7 días de espera).
    expect(slugs[2]).toBe('agencia_2d');
    // Y pegado el segundo tramo del mismo protocolo: a los 5 días le quedan
    // dos antes de que la transportadora lo devuelva.
    expect(slugs[3]).toBe('agencia_5d');
    // Y lo que YA se fue de vuelta va antes de las fases: es la llamada de
    // rescate (auditoría devoluciones 14-ago-2026).
    expect(slugs[4]).toBe('devolucion_reciente');
    expect(slugs[5]).toBe('en_oficina');
    expect(slugs[6]).toBe('en_reparto_novedad');
    expect(slugs[7]).toBe('en_transito');
    expect(slugs[slugs.length - 1]).toBe('otros_estados');
  });

  // El dueño lo señaló con un círculo rojo: "En tránsito 72" en el chip y
  // "72 EN TRÁNSITO" en la columna de abajo. Las que espejan una columna dejan
  // de dibujarse, pero su lógica sigue viva para el guard de inactividad.
  it('solo se dibujan como chip las listas que el Tablero NO puede decir', () => {
    const visibles = SEG_LISTS.filter(seMuestraComoChip).map((l) => l.slug);
    expect(visibles).toEqual([
      'pendientes_confirmacion_2d',
      'detenidos_3d',
      'agencia_2d',
      'agencia_5d',
      'devolucion_reciente',
      'indem_guia_generada_5d',
      'indem_pendientes_guia_4d',
    ]);
  });

  it('las ocultas siguen existiendo — el guard de inactividad las necesita', () => {
    for (const slug of ['en_oficina', 'en_reparto_novedad', 'pendientes_guia'] as const) {
      expect(findSegList(slug)).toBeDefined();
      expect(ACTIONABLE_SEG_SLUGS).toContain(slug);
    }
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
  // Las listas de FASE se reparten el trabajo sin pisarse: si un pedido cayera
  // en dos, dos asesoras lo trabajarían por separado creyendo cada una que era
  // suyo. Las tres listas de RELOJ (`detenidos_3d`, `agencia_2d`,
  // `devolucion_reciente`) quedan fuera de esta regla a propósito (ver abajo).
  const LISTAS_DE_FASE = SEG_LISTS.filter(
    (l) => l.slug !== 'detenidos_3d' && l.slug !== 'agencia_2d' && l.slug !== 'devolucion_reciente',
  );

  // `detenidos_3d` mira el RELOJ, no la fase, así que ATRAVIESA las columnas —
  // esa es exactamente su razón de existir y por eso no puede ser disjunta.
  // Esta prueba fija el cruce: si dejara de darse, la lista habría perdido el
  // sentido. (Antes la prueba de disyunción "pasaba" con esta lista incluida
  // solo porque todos sus pedidos de ejemplo iban sin `lastMovementAt`, con lo
  // cual nunca la ejercitaba: daba tranquilidad falsa.)
  it('detenidos_3d SÍ se cruza con la lista de su fase — es su razón de ser', () => {
    const hace5dias = new Date(Date.now() - 5 * 86400000).toISOString();
    const parado: OrderData = { ...baseOrder, estado: 'EN REPARTO', guia: 'G1', fecha: '', dias: 6, lastMovementAt: hace5dias };
    const matched = SEG_LISTS.filter((l) => l.matches(parado)).map((l) => l.slug);
    expect(matched).toContain('detenidos_3d');
    expect(matched).toContain('en_reparto_novedad');
  });

  it('un pedido CANCELADO parado hace días no entra en detenidos', () => {
    const hace9dias = new Date(Date.now() - 9 * 86400000).toISOString();
    const cerrado: OrderData = { ...baseOrder, estado: 'CANCELADO', fecha: '', dias: 12, lastMovementAt: hace9dias };
    expect(findSegList('detenidos_3d')!.matches(cerrado)).toBe(false);
  });

  it('agencia_2d SÍ se cruza con en_oficina (y con detenidos si además está quieto 3+ días)', () => {
    const hace4dias = new Date(Date.now() - 4 * 86400000).toISOString();
    const vencido: OrderData = { ...baseOrder, estado: 'RECLAME EN OFICINA', guia: 'G1', fecha: '', dias: 6, lastMovementAt: hace4dias };
    const matched = SEG_LISTS.filter((l) => l.matches(vencido)).map((l) => l.slug);
    expect(matched).toContain('agencia_2d');
    expect(matched).toContain('en_oficina');
    expect(matched).toContain('detenidos_3d');
  });

  it('ningún estado cae en dos listas de fase a la vez', () => {
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
        const matched = LISTAS_DE_FASE.filter((l) => l.matches(o)).map((l) => l.slug);
        expect(matched.length, `${estado} (${dias}d) cayó en ${matched.join(' + ')}`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('agencia_2d — paquete esperando al cliente (reloj, no fase)', () => {
  // Nace de la auditoría 14-ago-2026: 76 devoluciones de julio-EC ($2.316)
  // fueron paquetes que vencieron en la oficina de la transportadora, con
  // clientes yendo a retirar cuando ya iban de regreso (caso Muisne).
  const hace3dias = new Date(Date.now() - 3 * 86400000).toISOString();
  const hoy = new Date().toISOString();
  const lista = () => findSegList('agencia_2d')!;

  it('RETIRO/RECLAME quieto 3 días → vencido, matchea', () => {
    for (const estado of ['RECLAME EN OFICINA', 'PARA RETIRO EN AGENCIA SERVIENTREGA', 'EN PUNTO DROOP']) {
      const o: OrderData = { ...baseOrder, estado, guia: 'G1', fecha: '', dias: 5, lastMovementAt: hace3dias };
      expect(lista().matches(o), estado).toBe(true);
    }
  });

  it('recién llegado a oficina (movido hoy) NO matchea — todavía no venció', () => {
    const o: OrderData = { ...baseOrder, estado: 'RECLAME EN OFICINA', guia: 'G1', fecha: '', dias: 5, lastMovementAt: hoy };
    expect(lista().matches(o)).toBe(false);
  });

  it('sin lastMovementAt NO matchea: no saber cuándo llegó no es estar vencido', () => {
    const o: OrderData = { ...baseOrder, estado: 'RECLAME EN OFICINA', guia: 'G1', fecha: '', dias: 9, lastMovementAt: null };
    expect(lista().matches(o)).toBe(false);
  });

  it('el estado terminal EC "DEVOLUCION DE DISTRIBUCION CLIENTE SOLICITA RETIRAR EN CS" NO matchea (guard global)', () => {
    // Contiene "RETIRAR" (huele a agencia) pero DEVOLUC lo corta el guard: ya murió.
    const o: OrderData = { ...baseOrder, estado: 'DEVOLUCION DE DISTRIBUCION CLIENTE SOLICITA RETIRAR EN CS', fecha: '', dias: 9, lastMovementAt: hace3dias };
    expect(lista().matches(o)).toBe(false);
  });

  it('quieto 3 días en fase TRÁNSITO no es agencia (eso es detenidos_3d)', () => {
    const o: OrderData = { ...baseOrder, estado: 'EN TRANSPORTE', guia: 'G1', fecha: '', dias: 5, lastMovementAt: hace3dias };
    expect(lista().matches(o)).toBe(false);
  });
});

describe('devolucion_reciente — se fue a devolución (reloj sobre terminales)', () => {
  // Nace de la queja del dueño "Dropi o Guardian no reportan las devoluciones"
  // (auditoría 14-ago-2026): la base las tenía; la pantalla las escondía. Es la
  // ÚNICA lista eximida del guard terminal — su trabajo ES el terminal.
  const hace2dias = new Date(Date.now() - 2 * 86400000).toISOString();
  const hace40dias = new Date(Date.now() - 40 * 86400000).toISOString();
  const lista = () => findSegList('devolucion_reciente')!;

  it('DEVOLUCION / DEVUELTO / EN PROCESO DE DEVOLUCION con movimiento reciente → matchea', () => {
    for (const estado of ['DEVOLUCION', 'DEVUELTO', 'DEVOLUCION EN TRANSITO', 'EN PROCESO DE DEVOLUCION']) {
      const o: OrderData = { ...baseOrder, estado, fecha: '', dias: 8, lastMovementAt: hace2dias };
      expect(lista().matches(o), estado).toBe(true);
    }
  });

  it('devolución VIEJA (40 días) NO matchea — el rescate ya no tiene sentido', () => {
    const o: OrderData = { ...baseOrder, estado: 'DEVOLUCION', fecha: '', dias: 50, lastMovementAt: hace40dias };
    expect(lista().matches(o)).toBe(false);
  });

  it('sin lastMovementAt NO matchea: sin saber CUÁNDO se devolvió no es "reciente"', () => {
    const o: OrderData = { ...baseOrder, estado: 'DEVOLUCION', fecha: '', dias: 8, lastMovementAt: null };
    expect(lista().matches(o)).toBe(false);
  });

  it('una devolución reciente cae SOLO acá — el guard terminal corta al resto', () => {
    const o: OrderData = { ...baseOrder, estado: 'DEVOLUCION', fecha: '', dias: 8, lastMovementAt: hace2dias };
    expect(SEG_LISTS.filter((l) => l.matches(o)).map((l) => l.slug)).toEqual(['devolucion_reciente']);
  });

  it('NO es accionable: la llamada de rescate se hace una vez, no se exige a diario', () => {
    const o: OrderData = { ...baseOrder, estado: 'DEVOLUCION', fecha: '', dias: 8, lastMovementAt: hace2dias };
    expect(esAccionable(o)).toBe(false);
    expect(hasSeguimientoWork([o])).toBe(false);
  });

  it('un pedido VIVO (EN REPARTO) jamás cae acá', () => {
    const o: OrderData = { ...baseOrder, estado: 'EN REPARTO', fecha: '', dias: 2, lastMovementAt: hace2dias };
    expect(lista().matches(o)).toBe(false);
  });
});

describe('esAccionable — la COLA DE HOY del hero de Seguimiento', () => {
  it('agencia vencida y novedad cuentan; tránsito viajando normal NO', () => {
    const hace3dias = new Date(Date.now() - 3 * 86400000).toISOString();
    expect(esAccionable({ ...baseOrder, estado: 'RECLAME EN OFICINA', lastMovementAt: hace3dias })).toBe(true);
    expect(esAccionable({ ...baseOrder, estado: 'NOVEDAD' })).toBe(true);
    expect(esAccionable({ ...baseOrder, estado: 'EN TRANSPORTE', lastMovementAt: new Date().toISOString() })).toBe(false);
  });

  it('terminales nunca son cola de hoy', () => {
    expect(esAccionable({ ...baseOrder, estado: 'ENTREGADO' })).toBe(false);
    expect(esAccionable({ ...baseOrder, estado: 'DEVOLUCION' })).toBe(false);
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
    expect(isValidSegListSlug('agencia_2d')).toBe(true);
    expect(isValidSegListSlug('devolucion_reciente')).toBe(true);
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

describe('agencia_5d — el segundo tramo del protocolo', () => {
  // El texto de `agencia_2d` decía "Día 2: aviso. Día 5: llamada" desde agosto,
  // pero el código tenía UN solo umbral de 48 h: el paquete de seis días se veía
  // igual que el de dos, y el que estaba por devolverse no se distinguía.
  const horasAtras = (h: number) => new Date(Date.now() - h * 3600000).toISOString();
  const enOficina = (h: number | null): OrderData => ({
    ...baseOrder, estado: 'RECLAME EN OFICINA', guia: 'G1', fecha: '', dias: 6,
    lastMovementAt: h == null ? null : horasAtras(h),
  });
  const dosDias = () => findSegList('agencia_2d')!;
  const cincoDias = () => findSegList('agencia_5d')!;

  it('a las 72 h es aviso, no llamada', () => {
    expect(dosDias().matches(enOficina(72))).toBe(true);
    expect(cincoDias().matches(enOficina(72))).toBe(false);
  });

  it('a las 130 h es llamada, y YA NO aviso', () => {
    expect(cincoDias().matches(enOficina(130))).toBe(true);
    expect(dosDias().matches(enOficina(130))).toBe(false);
  });

  it('los dos tramos son DISJUNTOS: ningún paquete cae en los dos', () => {
    // Si se solaparan, los chips sumarían el mismo paquete dos veces y la cola
    // del día mentiría hacia arriba.
    for (const h of [0, 24, 47, 48, 72, 119, 120, 121, 200, 500]) {
      const o = enOficina(h);
      const enAmbas = dosDias().matches(o) && cincoDias().matches(o);
      expect(enAmbas, `${h} h cae en las dos listas`).toBe(false);
    }
  });

  it('el corte está exactamente en 120 h', () => {
    expect(dosDias().matches(enOficina(119))).toBe(true);
    expect(cincoDias().matches(enOficina(119))).toBe(false);
    expect(dosDias().matches(enOficina(120))).toBe(false);
    expect(cincoDias().matches(enOficina(120))).toBe(true);
  });

  it('sin fecha de movimiento no matchea ninguno de los dos', () => {
    // Mismo criterio que el tramo de 2 días: no saber cuándo llegó a la oficina
    // no es lo mismo que saber que está vencido.
    expect(dosDias().matches(enOficina(null))).toBe(false);
    expect(cincoDias().matches(enOficina(null))).toBe(false);
  });

  it('un paquete de 6 días en agencia SIGUE siendo trabajo del día', () => {
    // El riesgo de partir la lista: que el más urgente desaparezca de la cola
    // al cruzar las 120 h. `esAccionable` es una unión, así que tiene que
    // seguir contando — y una sola vez.
    const o = enOficina(140);
    expect(esAccionable(o)).toBe(true);
    const listas = SEG_LISTS.filter((l) => l.matches(o)).map((l) => l.slug);
    expect(listas).toContain('agencia_5d');
    expect(listas).not.toContain('agencia_2d');
  });

  it('los dos tramos explican qué son y qué hacer', () => {
    // `/como-se-trabaja` sale de acá: una lista sin texto deja a la operadora
    // con un chip que no sabe qué significa.
    for (const l of [dosDias(), cincoDias()]) {
      expect(l.queEs?.length ?? 0).toBeGreaterThan(30);
      expect(l.queHacer?.length ?? 0).toBeGreaterThan(30);
    }
  });
});
