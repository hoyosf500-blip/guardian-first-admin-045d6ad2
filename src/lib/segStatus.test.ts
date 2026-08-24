import { describe, it, expect } from 'vitest';
import { classifySegEstado, matchOficina, matchTransito, esNovedadResuelta, estadoDifiereDeFase } from './segStatus';

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
      // H7 (auditoría devoluciones 14-ago-2026): el cliente pidió recoger en
      // el centro de servicio — si nadie coordina, se devuelve. Caía en
      // 'otros' y no entraba ni a la cola accionable ni al reloj agencia_2d.
      'CLIENTE SOLICITA RETIRAR EN CS',
    ])('clasifica %s como oficina', (e) => {
      expect(classifySegEstado(e)).toBe('oficina');
    });

    it('el primo TERMINAL "DEVOLUCION DE DISTRIBUCION CLIENTE SOLICITA RETIRAR EN CS" NO es oficina — es una devolución consumada', () => {
      expect(matchOficina('DEVOLUCION DE DISTRIBUCION CLIENTE SOLICITA RETIRAR EN CS')).toBe(false);
      expect(classifySegEstado('DEVOLUCION DE DISTRIBUCION CLIENTE SOLICITA RETIRAR EN CS')).not.toBe('oficina');
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
    // GUARDIANA (20-ago-2026): estas variantes EC caian en 'otros' → el hero
    // las contaba como "en ruta" y nadie hacia la llamada de rescate. SQL ya
    // las contaba como devueltas (DEVOLUC%/DEVUELT% en _estado_bucket): dos
    // numeros distintos para el mismo pedido.
    it('DEVOLUCION A ORIGEN (EC) es devolución en tránsito, no "otros"', () =>
      expect(classifySegEstado('DEVOLUCION A ORIGEN')).toBe('devolucion_transito'));
    it('variantes DEVUELTO/DEVOLUC con sufijo caen en devolución, no en "otros"', () => {
      expect(classifySegEstado('DEVUELTO A ORIGEN')).toBe('devolucion');
      expect(classifySegEstado('DEVOLUCIÓN')).toBe('devolucion');
    });
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

// ─────────────────────────────────────────────────────────────────────────────
// La cola de Novedades pesca con `estado ilike '%NOVEDAD%'`, red ancha a
// propósito. Pero esa red también atrapa NOVEDAD SOLUCIONADA — lo contrario de
// lo que busca. Lo único que lo sacaba era la bandera `novedad_sol`, que NO
// sale del estado sino de Dropi (`issue_solved_by_operator`): si la novedad la
// cerró la transportadora y no la operadora, el pedido se quedaba en la cola
// para siempre, mientras Seguimiento lo mostraba en "Nov. Solucionada".
describe('esNovedadResuelta — sacar de la cola lo que ya se resolvió', () => {
  it('reconoce las dos escrituras, incluida la de Ecuador', () => {
    expect(esNovedadResuelta('NOVEDAD SOLUCIONADA')).toBe(true);
    expect(esNovedadResuelta('SOLUCION APROBADA')).toBe(true);
    // Dropi EC manda las tildes; el clasificador las quita antes de comparar.
    expect(esNovedadResuelta('SOLUCIÓN APROBADA')).toBe(true);
    expect(esNovedadResuelta('novedad solucionada')).toBe(true);
  });

  it('NO saca una novedad que sigue pendiente', () => {
    expect(esNovedadResuelta('NOVEDAD')).toBe(false);
    expect(esNovedadResuelta('INTENTO DE ENTREGA')).toBe(false);
  });

  // El matcher de `novedad` es EXACTO, así que quedarse solo con él descartaría
  // las variantes — justo el error que la red ancha del SQL evita. Por eso se
  // filtra por lo que se SABE resuelto, no por lo que se sabe pendiente.
  it('deja pasar una variante desconocida en vez de tragársela', () => {
    expect(esNovedadResuelta('NOVEDAD PENDIENTE')).toBe(false);
    expect(esNovedadResuelta('NOVEDAD EN RUTA')).toBe(false);
  });

  it('sin estado no afirma que esté resuelta', () => {
    expect(esNovedadResuelta('')).toBe(false);
    expect(esNovedadResuelta(null)).toBe(false);
    expect(esNovedadResuelta(undefined)).toBe(false);
  });
});

describe('variantes terminales de Ecuador', () => {
  // Auditoria 23-ago-2026 (visto ademas en la consola de produccion: el
  // clasificador avisaba "ENTREGADO A DESTINO cae en otros"). Un ENTREGADO
  // tratado como vivo entra al tablero, cuenta como "en ruta" y hasta puede
  // salir en detenidos: un pedido TERMINADO presentado como trabado.
  it("'ENTREGADO A DESTINO' clasifica como entregado, no como otros", () => {
    expect(classifySegEstado('ENTREGADO A DESTINO')).toBe('entregado');
  });
});

// Careo vs panel Dropi 24-ago-2026: paridad de datos perfecta (1.084/1.084) y
// aun así el dueño leyó "guía generada" donde había un POR RECOLECTAR del
// 31-jul con 24 días sin recoger — porque la tarjeta solo mostraba el TÍTULO
// de la columna (una fase que agrupa varios estados). El chip del estatus
// crudo existe para eso; estas pruebas fijan cuándo se dibuja y cuándo sobra.
describe('estadoDifiereDeFase — el chip del estatus crudo en la tarjeta', () => {
  it('POR RECOLECTAR difiere de la columna "Guía Generada" → chip visible', () => {
    expect(estadoDifiereDeFase('POR RECOLECTAR', 'Guía Generada')).toBe(true);
  });

  it('GUIA_GENERADA (guion bajo) ES el rótulo de la columna → sin chip redundante', () => {
    expect(estadoDifiereDeFase('GUIA_GENERADA', 'Guía Generada')).toBe(false);
    expect(estadoDifiereDeFase('GUIA GENERADA', 'Guía Generada')).toBe(false);
  });

  it('las tildes de EC no fabrican una diferencia falsa', () => {
    expect(estadoDifiereDeFase('EN TRÁNSITO', 'En Tránsito')).toBe(false);
    expect(estadoDifiereDeFase('EN TRANSITO', 'En Tránsito')).toBe(false);
  });

  it('las variantes EC de tránsito sí muestran su estatus exacto', () => {
    expect(estadoDifiereDeFase('EN RUTA A CONCESION', 'En Tránsito')).toBe(true);
    expect(estadoDifiereDeFase('INGRESANDO OPERATIVO A', 'En Tránsito')).toBe(true);
    expect(estadoDifiereDeFase('PARA RETIRO EN AGENCIA SERVIENTREGA', 'En Oficina')).toBe(true);
  });

  it('sin estado no hay chip (no se inventa una diferencia)', () => {
    expect(estadoDifiereDeFase('', 'Guía Generada')).toBe(false);
    expect(estadoDifiereDeFase(null, 'Guía Generada')).toBe(false);
    expect(estadoDifiereDeFase(undefined, 'Guía Generada')).toBe(false);
  });
});
