import { describe, it, expect } from 'vitest';
import { classifyNovedad, CULPA_LABEL, CULPA_ORDER, Culpa } from './novedadTaxonomy';

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
  it('CULPA_LABEL cubre todas las culpas y CULPA_ORDER no tiene huecos', () => {
    const all: Culpa[] = ['datos_nuestros', 'cliente', 'transportadora', 'generica'];
    for (const c of all) expect(CULPA_LABEL[c]).toBeTruthy();
    expect([...CULPA_ORDER].sort()).toEqual([...all].sort());
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
