import { describe, it, expect } from 'vitest';
import {
  construirMapaCalor, etiquetaColumna, horasDelHorario, intensidad, quitarSellosEspejo, rangoHora,
  EVENTOS_BITACORA_QUE_CUENTAN, VENTANA_ESPEJO_MS, colapsarEdiciones, depurarGestiones, nombreResultado,
  type GestionCruda, type MarcaHoraria,
} from './mapaCalor';

/** 9:00-17:00 con almuerzo 12:30-13:30 — el default de `useStoreSchedule`. */
const HORARIO = {
  work_start_min: 540, work_end_min: 1020,
  lunch_start_min: 750, lunch_end_min: 810,
};

const marca = (operatorId: string, hora: number, veces = 1): MarcaHoraria[] =>
  Array.from({ length: veces }, () => ({ operatorId, hora }));

describe('las horas que se dibujan salen del horario de la tienda', () => {
  it('9:00-17:00 son las horas 9 a 16 — la última hora trabajada, no una columna vacía', () => {
    expect(horasDelHorario(540, 1020)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it('un cierre a las 17:30 SÍ agrega la columna de las 17: en esa media hora se trabaja', () => {
    expect(horasDelHorario(540, 1050)).toContain(17);
  });

  it('no se sale de 0-23 ni con datos rotos', () => {
    expect(horasDelHorario(-600, 99_999).every((h) => h >= 0 && h <= 23)).toBe(true);
  });
});

describe('el mapa cuenta lo que pasó', () => {
  it('reparte las gestiones en su hora', () => {
    const m = construirMapaCalor({
      marcas: [...marca('a', 9, 3), ...marca('a', 14, 7)],
      operadores: ['a'], horario: HORARIO, medible: true,
    });
    const fila = m.filas[0];
    expect(fila.celdas.find((c) => c.hora === 9)?.cantidad).toBe(3);
    expect(fila.celdas.find((c) => c.hora === 14)?.cantidad).toBe(7);
    expect(fila.total).toBe(10);
    expect(m.maximo).toBe(7);
  });

  /**
   * ⛔ LA FILA EN CERO ES EL DATO QUE SE BUSCA. Si el mapa se armara solo con
   * quienes aparecen en las marcas, la persona que no hizo NADA en todo el día
   * desaparecería de la pantalla — exactamente al revés de para qué existe.
   */
  it('la que no hizo nada igual sale, con su fila entera en cero', () => {
    const m = construirMapaCalor({
      marcas: marca('a', 10, 5), operadores: ['a', 'b'], horario: HORARIO, medible: true,
    });
    const b = m.filas.find((f) => f.operatorId === 'b')!;
    expect(b.total).toBe(0);
    expect(b.celdas.every((c) => c.estado === 'sin_trabajo')).toBe(true);
    expect(b.horasEnCero).toBe(8);
  });

  it('cuenta las horas del horario que pasaron en cero', () => {
    const m = construirMapaCalor({
      marcas: [...marca('a', 9), ...marca('a', 10)],
      operadores: ['a'], horario: HORARIO, medible: true,
    });
    expect(m.filas[0].horasEnCero).toBe(6); // 8 del horario − 2 con trabajo
  });

  it('una marca de alguien que ya no está en el equipo no inventa una fila', () => {
    const m = construirMapaCalor({
      marcas: marca('fantasma', 11, 4), operadores: ['a'], horario: HORARIO, medible: true,
    });
    expect(m.filas).toHaveLength(1);
    expect(m.filas[0].operatorId).toBe('a');
  });
});

/**
 * ⛔ EL CORAZÓN DEL ARCHIVO. Sobre estas celdas el dueño habla con una persona:
 * una celda vacía que en realidad significa "no lo sé" es una acusación falsa.
 */
describe('cuatro estados, y ninguno se confunde con otro', () => {
  it('si la lectura falló, NADA se afirma: ni un cero', () => {
    const m = construirMapaCalor({
      marcas: marca('a', 10, 5), operadores: ['a'], horario: HORARIO, medible: false,
    });
    expect(m.medible).toBe(false);
    expect(m.filas[0].celdas.every((c) => c.estado === 'sin_medir')).toBe(true);
    expect(m.filas[0].celdas.every((c) => c.cantidad === null)).toBe(true);
    expect(m.filas[0].total).toBeNull();
    expect(m.filas[0].horasEnCero).toBeNull();
  });

  /**
   * A las 9 de la mañana el mapa no puede acusar a nadie de no haber trabajado
   * de 10 a 17. Sin esta regla, el equipo entero sale en rojo cada mañana y el
   * mapa se vuelve inservible antes del mediodía.
   */
  it('en el día de hoy, las horas que no llegaron NO cuentan como "sin trabajo"', () => {
    const m = construirMapaCalor({
      marcas: marca('a', 9, 4), operadores: ['a'], horario: HORARIO, medible: true,
      horaActual: 11,
    });
    const c = (h: number) => m.filas[0].celdas.find((x) => x.hora === h)!;
    expect(c(9).estado).toBe('trabajo');
    expect(c(10).estado).toBe('sin_trabajo');   // pasó entera y quedó en cero
    expect(c(11).estado).toBe('todavia_no');    // la hora EN CURSO no se juzga
    expect(c(16).estado).toBe('todavia_no');
    // Y no se le cobran como huecos las horas que todavía no existieron.
    expect(m.filas[0].horasEnCero).toBe(1);
  });

  it('la hora en curso igual suma al total: se cuenta, solo que no acusa', () => {
    const m = construirMapaCalor({
      marcas: [...marca('a', 9, 4), ...marca('a', 11, 2)],
      operadores: ['a'], horario: HORARIO, medible: true, horaActual: 11,
    });
    expect(m.filas[0].total).toBe(6);
  });

  it('sin horaActual (un día ya cerrado) todas las horas se juzgan', () => {
    const m = construirMapaCalor({
      marcas: marca('a', 9, 4), operadores: ['a'], horario: HORARIO, medible: true,
    });
    expect(m.filas[0].celdas.some((c) => c.estado === 'todavia_no')).toBe(false);
    expect(m.filas[0].horasEnCero).toBe(7);
  });
});

describe('el almuerzo se nombra, no se esconde', () => {
  /**
   * Con almuerzo 12:30-13:30, la hora 12 tiene media hora de trabajo REAL.
   * Pintarla entera como "almuerzo" escondería esas gestiones; no marcarla
   * haría reclamar por media hora de comida. Por eso es una bandera aparte y
   * el estado sigue siendo el medido.
   */
  it('las horas que pisan el almuerzo se marcan, pero conservan su estado real', () => {
    const m = construirMapaCalor({
      marcas: marca('a', 12, 3), operadores: ['a'], horario: HORARIO, medible: true,
    });
    const c = (h: number) => m.filas[0].celdas.find((x) => x.hora === h)!;
    expect(c(12).tocaAlmuerzo).toBe(true);
    expect(c(13).tocaAlmuerzo).toBe(true);
    expect(c(11).tocaAlmuerzo).toBe(false);
    expect(c(14).tocaAlmuerzo).toBe(false);
    // Lo importante: el trabajo de las 12:00-12:30 SIGUE contándose.
    expect(c(12).cantidad).toBe(3);
    expect(c(12).estado).toBe('trabajo');
  });

  it('una tienda sin almuerzo configurado no marca ninguna hora', () => {
    const m = construirMapaCalor({
      marcas: [], operadores: ['a'],
      horario: { ...HORARIO, lunch_start_min: 0, lunch_end_min: 0 },
      medible: true,
    });
    expect(m.filas[0].celdas.every((c) => !c.tocaAlmuerzo)).toBe(true);
  });
});

describe('la intensidad del color', () => {
  it('la celda más alta va a tope y las demás en proporción', () => {
    const m = construirMapaCalor({
      marcas: [...marca('a', 9, 10), ...marca('a', 10, 5)],
      operadores: ['a'], horario: HORARIO, medible: true,
    });
    const c = (h: number) => m.filas[0].celdas.find((x) => x.hora === h)!;
    expect(intensidad(c(9), m.maximo)).toBe(1);
    expect(intensidad(c(10), m.maximo)).toBe(0.5);
    expect(intensidad(c(11), m.maximo)).toBe(0);
  });

  /** Un "no se sabe" pintado como "poco trabajo" es la mentira que este
   *  archivo existe para evitar: devuelve null y el dibujo elige otra cosa. */
  it('lo que no se midió NO devuelve un color de "poco": devuelve null', () => {
    const m = construirMapaCalor({
      marcas: [], operadores: ['a'], horario: HORARIO, medible: false,
    });
    expect(intensidad(m.filas[0].celdas[0], 10)).toBeNull();
  });
});

/**
 * ⛔ FUERA DEL HORARIO NO ES "NO TRABAJÓ" (4-sep-2026). Con horario 9-17, la
 * que entró a las 7:30 a limpiar el backlog tenía sus gestiones borradas del
 * total y todas sus celdas en rojo, mientras la tarjeta de al lado sí las
 * contaba: dos cifras contradictorias en la misma pantalla, y la de arriba
 * acusaba.
 */
describe('lo que se hizo fuera del horario', () => {
  it('se cuenta aparte y suma al total del día', () => {
    const m = construirMapaCalor({
      marcas: [...marca('a', 7, 4), ...marca('a', 10, 2), ...marca('a', 19, 1)],
      operadores: ['a'], horario: HORARIO, medible: true,
    });
    expect(m.filas[0].fueraDeHorario).toBe(5);
    expect(m.filas[0].total).toBe(7);
    // Y no inventa columnas: el mapa sigue siendo el horario.
    expect(m.horas.includes(7)).toBe(false);
  });

  it('sin medir, tampoco afirma cero fuera de horario', () => {
    const m = construirMapaCalor({ marcas: [], operadores: ['a'], horario: HORARIO, medible: false });
    expect(m.filas[0].fueraDeHorario).toBeNull();
  });
});

describe('el nombre de la hora', () => {
  it('se dice como lo pidió el dueño: de 10 a 11', () => {
    expect(rangoHora(10)).toBe('10:00 a 11:00');
  });
});

describe('el rótulo de la columna dice hasta dónde llega', () => {
  it('«16-17», no «16»: con horario hasta las 17 el dueño leía que se cortaba a las 4', () => {
    expect(etiquetaColumna(16)).toBe('16-17');
    expect(etiquetaColumna(8)).toBe('8-9');
  });
});

describe('cada marca cuenta UNA vez (el sello espejo de Confirmar)', () => {
  const T0 = Date.parse('2026-09-03T14:00:00Z');
  const cruda = (p: Partial<GestionCruda>): GestionCruda => ({
    operatorId: 'a', phone: '0999123456', ms: T0, fuente: 'gestion', accion: 'SEG: Resuelto', ...p,
  });

  it('la fila de order_results y su sello «Confirmado» segundos después son la MISMA marca', () => {
    const out = quitarSellosEspejo([
      cruda({ fuente: 'confirmar', accion: 'confirmar: conf', ms: T0 }),
      cruda({ fuente: 'gestion', accion: 'Confirmado', ms: T0 + 3_000 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].fuente).toBe('confirmar');
  });

  it('«No respondió» y «Cancelado: …» son sellos igual', () => {
    const out = quitarSellosEspejo([
      cruda({ fuente: 'confirmar', accion: 'confirmar: noresp', ms: T0 }),
      cruda({ fuente: 'gestion', accion: 'No respondió', ms: T0 + 1_000 }),
      cruda({ fuente: 'confirmar', accion: 'confirmar: canc', ms: T0 + 600_000 }),
      cruda({ fuente: 'gestion', accion: 'Cancelado: Se arrepintió', ms: T0 + 601_000 }),
    ]);
    expect(out.map((g) => g.accion)).toEqual(['confirmar: noresp', 'confirmar: canc']);
  });

  it('el sello se compara por PERSONA y por TELÉFONO, aunque el formato del número cambie', () => {
    const out = quitarSellosEspejo([
      cruda({ fuente: 'confirmar', accion: 'confirmar: conf', phone: '+593 999 123 456', ms: T0 }),
      cruda({ fuente: 'gestion', accion: 'Confirmado', phone: '0999123456', ms: T0 + 2_000 }),
      // Otra persona marcó al mismo cliente: no es espejo de nada.
      cruda({ fuente: 'gestion', accion: 'Confirmado', operatorId: 'b', ms: T0 + 2_000 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((g) => g.operatorId)).toEqual(['a', 'b']);
  });

  it('un sello sin su fila de order_results SE QUEDA: es la única prueba de esa marca', () => {
    const out = quitarSellosEspejo([cruda({ fuente: 'gestion', accion: 'Confirmado' })]);
    expect(out).toHaveLength(1);
  });

  it('dos marcas del mismo cliente separadas por más de la ventana son dos marcas', () => {
    const out = quitarSellosEspejo([
      cruda({ fuente: 'confirmar', accion: 'confirmar: noresp', ms: T0 }),
      cruda({ fuente: 'gestion', accion: 'No respondió', ms: T0 + VENTANA_ESPEJO_MS + 1 }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('las gestiones de Seguimiento, las llamadas y la bitácora no se tocan', () => {
    const lista = [
      cruda({ fuente: 'confirmar', accion: 'confirmar: conf', ms: T0 }),
      cruda({ fuente: 'gestion', accion: 'SEG: Avisé: en oficina', ms: T0 + 1_000 }),
      cruda({ fuente: 'gestion', accion: 'LLAMADA: llamó', ms: T0 + 1_000 }),
      cruda({ fuente: 'bitacora', accion: 'Editó el pedido', ms: T0 + 1_000 }),
    ];
    expect(quitarSellosEspejo(lista)).toHaveLength(4);
  });

  it('de la bitácora solo cuenta leer la conversación: lo demás ya vive en otra tabla (edito ↔ order_results) o es solo mirar', () => {
    expect(EVENTOS_BITACORA_QUE_CUENTAN.has('leyo_chat')).toBe(true);
    for (const e of ['abrio', 'cerro', 'salto', 'gestiono', 'llamo', 'escribio', 'marco', 'deshizo', 'edito']) {
      expect(EVENTOS_BITACORA_QUE_CUENTAN.has(e)).toBe(false);
    }
  });
});

describe('una edición con varios pasos es UNA edición', () => {
  const T0 = Date.parse('2026-09-03T14:13:00Z');
  const cruda = (p: Partial<GestionCruda>): GestionCruda => ({
    operatorId: 'a', phone: '0995193388', ms: T0, fuente: 'confirmar', accion: 'confirmar: edicion_orden', ...p,
  });

  it('las tres filas de auditoría del mismo minuto (caso real 3-sep 09:13) se cuentan una vez', () => {
    const out = colapsarEdiciones([
      cruda({ accion: 'confirmar: edicion_orden', ms: T0 }),
      cruda({ accion: 'confirmar: edicion_completa', ms: T0 + 2_000 }),
      cruda({ accion: 'confirmar: edicion_completa', ms: T0 + 4_000 }),
      // Y la confirmación del minuto siguiente es OTRA gestión.
      cruda({ accion: 'confirmar: conf', ms: T0 + 60_000 }),
    ]);
    expect(out.map((g) => g.accion)).toEqual(['confirmar: edicion_orden', 'confirmar: conf']);
  });

  it('dos ediciones separadas (otro cliente, u horas después) son dos', () => {
    const out = colapsarEdiciones([
      cruda({ ms: T0 }),
      cruda({ ms: T0, phone: '0986623273' }),
      cruda({ ms: T0 + 3 * 3600_000 }),
    ]);
    expect(out).toHaveLength(3);
  });

  it('depurarGestiones hace las dos cosas: quita el sello espejo Y colapsa la edición', () => {
    const out = depurarGestiones([
      cruda({ accion: 'confirmar: edicion_orden', ms: T0 }),
      cruda({ accion: 'confirmar: edicion_completa', ms: T0 + 1_000 }),
      cruda({ accion: 'confirmar: conf', ms: T0 + 60_000 }),
      cruda({ fuente: 'gestion', accion: 'Confirmado', ms: T0 + 61_000 }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('el detalle nombra la fila en el idioma de la botonera', () => {
    expect(nombreResultado('conf')).toBe('Confirmó');
    expect(nombreResultado('noresp')).toBe('No respondió');
    expect(nombreResultado('edicion_completa')).toBe('Editó el pedido');
    expect(nombreResultado('cambio_transportadora')).toBe('Editó el pedido');
  });
});
