import { describe, it, expect } from 'vitest';
import coOficial from './dropiColombia/novedadesOficiales.json';
import { classifyNovedad, CULPA_LABEL, CULPA_ORDER, Culpa, CULPA_HINT, CULPA_ORDER_REAL } from './novedadTaxonomy';

describe('classifyNovedad — datos_nuestros', () => {
  it('dirección errada', () => {
    expect(classifyNovedad('Dirección errada').culpa).toBe('datos_nuestros');
    expect(classifyNovedad('LA DIRECCION NO EXISTE').categoria).toBe('direccion_errada');
  });
  it('dirección incompleta', () => {
    const c = classifyNovedad('Dirección incompleta, falta nomenclatura');
    expect(c.culpa).toBe('datos_nuestros');
    expect(c.categoria).toBe('direccion_incompleta');
  });
  it('teléfono malo', () => {
    expect(classifyNovedad('Número equivocado').categoria).toBe('telefono_malo');
    expect(classifyNovedad('telefono apagado').culpa).toBe('datos_nuestros');
  });
});

describe('classifyNovedad — cliente', () => {
  it('no responde', () => {
    expect(classifyNovedad('Cliente no contesta').categoria).toBe('no_responde');
    expect(classifyNovedad('NO RESPONDE LLAMADAS').culpa).toBe('cliente');
  });
  it('rechaza', () => {
    expect(classifyNovedad('Cliente rechaza el pedido').categoria).toBe('rechaza');
    expect(classifyNovedad('ya no lo quiere').culpa).toBe('cliente');
  });
  it('sin dinero', () => {
    expect(classifyNovedad('Cliente no tiene dinero').categoria).toBe('sin_dinero');
  });
  it('ausente / reprograma', () => {
    expect(classifyNovedad('No se encontraba en casa').categoria).toBe('ausente_reprograma');
    expect(classifyNovedad('Reprograma para otro día').culpa).toBe('cliente');
  });
});

describe('classifyNovedad — transportadora', () => {
  it('sin cobertura', () => {
    expect(classifyNovedad('Zona sin cobertura').categoria).toBe('sin_cobertura');
    expect(classifyNovedad('ZONA DE DIFICIL ACCESO').culpa).toBe('transportadora');
  });
  it('demora', () => {
    expect(classifyNovedad('Paquete en bodega, demora').categoria).toBe('demora');
  });
  it('dañado', () => {
    expect(classifyNovedad('Producto dañado').categoria).toBe('danado');
    expect(classifyNovedad('llegó roto').culpa).toBe('transportadora');
  });
  it('perdido', () => {
    expect(classifyNovedad('Paquete extraviado').categoria).toBe('perdido');
  });
  it('oficina cerrada', () => {
    expect(classifyNovedad('Oficina cerrada').categoria).toBe('oficina_cerrada');
  });
});

describe('classifyNovedad — genérica / catch-all / ruido', () => {
  it('vacío y null → genérica', () => {
    expect(classifyNovedad('')).toEqual({ categoria: 'otro', culpa: 'generica', esGenerica: true });
    expect(classifyNovedad(null).esGenerica).toBe(true);
    expect(classifyNovedad(undefined).esGenerica).toBe(true);
  });
  it('ruido conocido → genérica', () => {
    for (const noise of ['NOVEDAD', 'sin novedad', '-', 'N/A', 'Gestión', 'OTRO']) {
      const c = classifyNovedad(noise);
      expect(c.culpa, `"${noise}"`).toBe('generica');
      expect(c.esGenerica, `"${noise}"`).toBe(true);
    }
  });
  it('texto < 4 chars → genérica', () => {
    expect(classifyNovedad('xy').esGenerica).toBe(true);
  });
  it('texto desconocido (regla faltante) → genérica pero clasificable a futuro', () => {
    const c = classifyNovedad('algo totalmente nuevo que no matchea nada');
    expect(c.categoria).toBe('otro');
    expect(c.esGenerica).toBe(true);
  });
});

describe('classifyNovedad — robustez', () => {
  it('insensible a acentos, mayúsculas y espacios', () => {
    const variants = ['Dirección  Errada', 'DIRECCION ERRADA', 'direccion errada', '  Direccion   Errada  '];
    for (const v of variants) {
      expect(classifyNovedad(v).categoria, v).toBe('direccion_errada');
    }
  });
  it('prioriza datos_nuestros sobre cliente cuando ambos aparecen', () => {
    // "dirección errada" (datos_nuestros) gana sobre "no contesta" (cliente).
    expect(classifyNovedad('Dirección errada y el cliente no contesta').culpa).toBe('datos_nuestros');
  });
});

describe('metadata de culpa', () => {
  // La lista ya NO se escribe a mano: `CULPA_LABEL` es un Record<Culpa, …>, así
  // que TypeScript obliga a completarlo y sus claves SON el universo de culpas.
  // Escrita a mano, agregar una culpa nueva rompía esta prueba por la razón
  // equivocada (la lista quedaba vieja) en vez de vigilar lo que importa.
  it('CULPA_ORDER cubre exactamente las culpas que existen, sin huecos ni repetidos', () => {
    const universo = Object.keys(CULPA_LABEL) as Culpa[];
    expect([...CULPA_ORDER].sort()).toEqual([...universo].sort());
    expect(new Set(CULPA_ORDER).size).toBe(CULPA_ORDER.length);
  });

  it('cada culpa tiene etiqueta Y explicación — el rótulo solo no alcanza', () => {
    for (const c of Object.keys(CULPA_LABEL) as Culpa[]) {
      expect(CULPA_LABEL[c], c).toBeTruthy();
      expect(CULPA_HINT[c], c).toBeTruthy();
    }
  });

  it('⛔ CULPA_ORDER_REAL saca lo que no es una novedad, y solo eso', () => {
    // Los estados de flujo («EN RUTA», «ENTREGADO») no son novedades: contarlos
    // distorsiona el denominador de toda la pantalla de Puntos de Mejora.
    expect(CULPA_ORDER_REAL).not.toContain('no_es_novedad');
    for (const c of CULPA_ORDER_REAL) expect(CULPA_ORDER).toContain(c);
    expect(CULPA_ORDER_REAL.length).toBe(CULPA_ORDER.length - 1);
  });

  it('⛔ «el carrier no dijo nada» y «no supimos leerlo» NO son el mismo bucket', () => {
    // Mezclados, un hueco de reglas NUESTRO se pintaba como una acusación a la
    // transportadora — y en Colombia era el bucket dominante (51 de 66).
    expect(classifyNovedad('-').culpa).toBe('generica');
    expect(classifyNovedad('SIN INFORMACION').culpa).toBe('generica');
    expect(classifyNovedad('UN TEXTO QUE NADIE PREVIO TODAVIA').culpa).toBe('sin_clasificar');
    expect(CULPA_LABEL.generica).not.toBe(CULPA_LABEL.sin_clasificar);
  });
});

/**
 * ⛔ GUARDIÁN — las novedades OFICIALES de Colombia tienen que clasificar.
 *
 * Medido el 30-ago-2026: 51 de las 66 novedades del propio diccionario CO caían
 * en el catch-all, y como ese bucket se rotulaba «Sin info / genérica · el
 * carrier no dice el motivo», el dueño leía que la transportadora no informa y
 * que no hay nada que corregir del lado propio. Justo al revés.
 *
 * Las reglas se habían escrito con vocabulario COD genérico y probado con texto
 * de ECUADOR — el encabezado del módulo lo declaraba "PUNTO DE PARTIDA" — y
 * nadie las afinó al abrir Colombia.
 *
 * Este umbral es el KPI del módulo: baja agregando reglas, no ignorándolo.
 */
describe('⛔ cobertura sobre el diccionario oficial de Colombia', () => {
  const oficiales = Object.values<{ fichas?: { novedad: string }[] }>(
    (coOficial as { transportadoras: Record<string, { fichas?: { novedad: string }[] }> }).transportadoras,
  ).flatMap((c) => (c.fichas ?? []).map((f) => f.novedad));

  it('el diccionario trae las 66 novedades esperadas (si cambió, revisar el umbral)', () => {
    expect(oficiales.length).toBeGreaterThanOrEqual(60);
  });

  it('a lo sumo 8 quedan sin clasificar (eran 51 el 30-ago, antes del arreglo)', () => {
    const sin = oficiales.filter((n) => classifyNovedad(n).culpa === 'sin_clasificar');
    expect(
      sin.length,
      `novedades oficiales de Colombia sin regla: ${sin.join(' | ')}`,
    ).toBeLessThanOrEqual(8);
  });

  it('las de dirección clasifican aunque lleven palabras intercaladas', () => {
    // El defecto de fondo no era la falta de entradas sino el `includes()` de
    // FRASES pegadas: «DIRECCIÓN DESTINATARIO NO EXISTE» no contiene
    // «DIRECCION NO EXISTE», y esa palabra en el medio rompía el match.
    expect(classifyNovedad('DIRECCIÓN DESTINATARIO NO EXISTE').culpa).toBe('datos_nuestros');
    expect(classifyNovedad('DIRECCIÓN DESTINATARIO INCOMPLETA').culpa).toBe('datos_nuestros');
    expect(classifyNovedad('NO SE LOCALIZA DIRECCIÓN DEL DESTINATARIO').culpa).toBe('datos_nuestros');
  });

  it('«no conocen al destinatario» es culpa NUESTRA, no del cliente', () => {
    // Si nadie lo conoce en esa dirección, la dirección que cargamos está mal.
    for (const s of ['NO LO CONOCEN', 'EN DIRECCIÓN DE ENTREGA NO CONOCEN DESTINATARIO', 'NO CONOCEN AL DESTINATARIO']) {
      expect(classifyNovedad(s).culpa, s).toBe('datos_nuestros');
    }
  });

  it('un estado de flujo de Guatemala NO es una novedad de nadie', () => {
    for (const s of ['EN RUTA', 'RECOLECTADO', 'ENTREGADO', 'PROGRAMADO PARA ENTREGA']) {
      expect(classifyNovedad(s).culpa, s).toBe('no_es_novedad');
    }
  });
});

/**
 * Corpus de regresión. Llenar con strings REALES de producción tras el Módulo 0
 * (`SELECT novedad, COUNT(*) FROM orders GROUP BY 1 ORDER BY 2 DESC`). Cada par
 * fija el comportamiento esperado sobre datos reales y atrapa regresiones al
 * agregar reglas. Por ahora vacío — se popula con la salida de M0.
 */
const REAL_SAMPLES: Array<[string, Culpa]> = [
  // ['CLIENTE SOLICITA REPROGRAMAR ENTREGA', 'cliente'],
  // ['ZONA DE DIFICIL ACCESO VEREDA', 'transportadora'],
];

describe('corpus real (Módulo 0)', () => {
  it.skipIf(REAL_SAMPLES.length === 0)('cada muestra real cae en la culpa esperada', () => {
    for (const [text, culpa] of REAL_SAMPLES) {
      expect(classifyNovedad(text).culpa, text).toBe(culpa);
    }
  });
});
