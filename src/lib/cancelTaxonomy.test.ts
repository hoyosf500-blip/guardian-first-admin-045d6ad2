import { describe, it, expect } from 'vitest';
import {
  classifyCancel,
  classifyCancelRow,
  cancelCategoriaLabel,
  CANCEL_CULPA_ORDER,
  CANCEL_TIPO_ORDER,
  CANCEL_CATEGORIA_LABEL,
} from './cancelTaxonomy';
import { CANCEL_REASONS } from './constants';

/**
 * El motivo exacto que escribe ConfirmarTab cuando cancela un duplicado sola.
 * Si alguien cambia ese string allá y no acá, el test avisa.
 */
const MOTIVO_DUPLICADO_AUTO = 'Duplicado — ya existe el pedido #7412345 del mismo cliente';

describe('classifyCancel — ruido y vacíos', () => {
  it('vacío, null y undefined caen al catch-all sin romperse', () => {
    for (const v of [null, undefined, '', '   ']) {
      const c = classifyCancel(v);
      expect(c.categoria).toBe('otro');
      expect(c.tipo).toBe('desconocido');
      expect(c.esGenerica).toBe(true);
    }
  });

  it('la basura conocida NO se clasifica como motivo', () => {
    // Si esto falla, un "." cuenta como motivo y la cobertura del reporte
    // miente al alza — que es exactamente el fallo que este módulo evita.
    for (const v of ['.', '-', '--', 'x', 'XX', 'n/a', 'N/A', 'ninguno', 'sin motivo', 'otro', 'NO']) {
      expect(classifyCancel(v).esGenerica).toBe(true);
    }
  });

  it('acepta motivos cortos pero legítimos (el guard es 3, no 4)', () => {
    // 'CARO' tiene 4 letras y es una objeción de venta perfectamente accionable.
    const c = classifyCancel('caro');
    expect(c.categoria).toBe('precio_flete');
    expect(c.esGenerica).toBe(false);
  });

  it('es insensible a acentos, mayúsculas y espacios de más', () => {
    const esperado = classifyCancel('NO TIENE DINERO');
    for (const v of ['no tiene dinero', '  No   Tiene   Dinero  ', 'nó tiéne dinéro']) {
      expect(classifyCancel(v)).toEqual(esperado);
    }
  });
});

describe('classifyCancel — los tres ejes', () => {
  it('cancelar por filtro nuestro es AHORRO, no pérdida', () => {
    // El corazón del rediseño: cancelar un duplicado o un mal historial evitó
    // una devolución. Contarlo como venta perdida esconde la plata.
    for (const v of ['Duplicado', 'Mal historial', 'No pagó anticipo', 'pedido de prueba']) {
      const c = classifyCancel(v);
      expect(c.tipo).toBe('ahorro');
      expect(c.culpa).toBe('filtro_interno');
    }
  });

  it('el pedido recreado NO cuenta en la tasa (se contaría dos veces)', () => {
    for (const v of ['Cambio de transportadora', 'se recreó por cambio de talla']) {
      expect(classifyCancel(v).cuentaEnTasa).toBe(false);
    }
    // Todo lo demás sí cuenta.
    expect(classifyCancel('No contesta').cuentaEnTasa).toBe(true);
    expect(classifyCancel('Duplicado').cuentaEnTasa).toBe(true);
  });

  it('separa el lead falso (tráfico) de la objeción de venta (cliente)', () => {
    // "No lo pidió" es plata de PAUTA mal gastada; "ya no lo quiere" es una
    // objeción de venta. Se parecen en el texto y son negocios opuestos.
    expect(classifyCancel('el cliente no hizo el pedido').culpa).toBe('trafico');
    expect(classifyCancel('ya no lo quiere').culpa).toBe('cliente');
  });

  it('lo que no se puede evitar no se cuenta como evitable', () => {
    expect(classifyCancel('el cliente está de viaje').tipo).toBe('perdida_inevitable');
    expect(classifyCancel('sin cobertura en esa zona').tipo).toBe('perdida_inevitable');
    expect(classifyCancel('el esposo no la autoriza').tipo).toBe('perdida_inevitable');
  });
});

describe('classifyCancel — el orden de las reglas (no reordenar sin correr esto)', () => {
  it('"cambió de opinión" NO se confunde con un cambio de transportadora', () => {
    // Ambos normalizan empezando con 'CAMBIO DE'. Si alguna regla de recreado
    // usara ese token desnudo, se tragaría todos los arrepentimientos y el
    // motivo más frecuente del CRM desaparecería del reporte.
    const c = classifyCancel('Cambió de opinión');
    expect(c.categoria).toBe('arrepentido');
    expect(c.culpa).toBe('cliente');
    expect(c.cuentaEnTasa).toBe(true);
  });

  it('el anticipo gana sobre "no contesta" cuando aparecen los dos', () => {
    // La causa real es el anticipo; que no conteste es la consecuencia.
    expect(classifyCancel('no contestó cuando lo llamamos por el anticipo').categoria)
      .toBe('sin_anticipo');
  });

  it('"no reconoce el pedido" gana sobre "no quiere"', () => {
    expect(classifyCancel('no reconoce el pedido, dice que no lo quiere').culpa)
      .toBe('trafico');
  });
});

describe('GUARDIÁN: el picklist no puede tener un motivo sin regla', () => {
  // Si esto se pone rojo, alguien agregó una opción al modal de cancelación sin
  // enseñarle a la taxonomía qué significa. Ese motivo caería en "sin clasificar"
  // y el reporte tendría un agujero silencioso.
  const motivos = CANCEL_REASONS.filter(r => r.kind !== 'texto');

  it.each(motivos.map(m => [m.value, m.label]))(
    '"%s" clasifica a algo concreto',
    (value) => {
      const c = classifyCancel(value);
      expect(c.categoria).not.toBe('otro');
      expect(c.esGenerica).toBe(false);
      expect(c.tipo).not.toBe('desconocido');
    },
  );

  it('cada categoría del picklist tiene etiqueta legible', () => {
    for (const m of motivos) {
      const cat = classifyCancel(m.value).categoria;
      expect(CANCEL_CATEGORIA_LABEL[cat], `falta label de "${cat}"`).toBeTruthy();
    }
  });

  it('las teclas de atajo son únicas y de un solo dígito', () => {
    const keys = CANCEL_REASONS.map(r => r.hotkey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[0-9]$/);
  });

  it('los valores canónicos son únicos', () => {
    const vals = CANCEL_REASONS.map(r => r.value);
    expect(new Set(vals).size).toBe(vals.length);
  });

  it('hay exactamente un sentinel de texto libre', () => {
    expect(CANCEL_REASONS.filter(r => r.kind === 'texto')).toHaveLength(1);
  });
});

describe('GUARDIÁN: el histórico sigue clasificando (sin backfill)', () => {
  // Los 7 valores que se escribieron durante meses con el picklist viejo. Si
  // esto se rompe, meses de cancelaciones ya registradas quedan sin clasificar
  // y el reporte pierde toda comparabilidad hacia atrás.
  const HISTORICO: Array<[string, string, string]> = [
    ['No contesta',              'no_contesta',           'perdida_evitable'],
    ['Duplicado',                'duplicado',             'ahorro'],
    ['Cambió de opinión',        'arrepentido',           'perdida_evitable'],
    ['Cambio de transportadora', 'cambio_transportadora', 'ahorro'],
    ['Mal historial',            'mal_historial',         'ahorro'],
    ['No pagó anticipo',         'sin_anticipo',          'ahorro'],
    [MOTIVO_DUPLICADO_AUTO,      'duplicado',             'ahorro'],
  ];

  it.each(HISTORICO)('"%s" → %s / %s', (texto, categoria, tipo) => {
    const c = classifyCancel(texto);
    expect(c.categoria).toBe(categoria);
    expect(c.tipo).toBe(tipo);
  });
});

describe('classifyCancelRow — los dos faltantes NO son el mismo problema', () => {
  it('cancelado fuera del CRM ≠ cancelado sin anotar motivo', () => {
    // Uno se arregla entrenando a la asesora; el otro, cambiando dónde se
    // cancela. Meterlos en el mismo bucket haría invisible esa diferencia.
    expect(classifyCancelRow({ motivo: null, origen: 'externo' }).categoria)
      .toBe('externo_dropi');
    expect(classifyCancelRow({ motivo: null, origen: 'guardian' }).categoria)
      .toBe('sin_motivo');
  });

  it('un motivo que llegara con origen externo igual se marca externo', () => {
    // Por construcción no debería pasar (externo = no hay fila), pero si la RPC
    // cambia, el origen manda: no se inventa cobertura que no existe.
    expect(classifyCancelRow({ motivo: 'muy caro', origen: 'externo' }).categoria)
      .toBe('externo_dropi');
  });

  it('con origen guardian y motivo real, delega en classifyCancel', () => {
    expect(classifyCancelRow({ motivo: 'muy caro', origen: 'guardian' }))
      .toEqual(classifyCancel('muy caro'));
  });

  it('la basura con origen guardian cuenta como sin_motivo, no como motivo', () => {
    expect(classifyCancelRow({ motivo: '.', origen: 'guardian' }).categoria)
      .toBe('sin_motivo');
  });

  it('los dos faltantes son `desconocido`: nunca se les inventa un tipo', () => {
    expect(classifyCancelRow({ motivo: null, origen: 'externo' }).tipo).toBe('desconocido');
    expect(classifyCancelRow({ motivo: '', origen: 'guardian' }).tipo).toBe('desconocido');
  });
});

describe('contratos de UI', () => {
  it('el orden de culpas cubre todas las culpas, sin repetir', () => {
    expect(new Set(CANCEL_CULPA_ORDER).size).toBe(CANCEL_CULPA_ORDER.length);
    expect(CANCEL_CULPA_ORDER).toHaveLength(7);
  });

  it('el orden de tipos pone lo accionable primero', () => {
    expect(CANCEL_TIPO_ORDER[0]).toBe('perdida_evitable');
    expect(new Set(CANCEL_TIPO_ORDER).size).toBe(4);
  });

  it('cancelCategoriaLabel cae al slug crudo si falta la etiqueta', () => {
    expect(cancelCategoriaLabel('duplicado')).toBe('Duplicado');
    expect(cancelCategoriaLabel('inventado_xyz')).toBe('inventado_xyz');
  });
});

describe('pureza', () => {
  it('dos llamadas con el mismo texto dan objetos equivalentes e independientes', () => {
    const a = classifyCancel('muy caro');
    const b = classifyCancel('muy caro');
    expect(a).toEqual(b);
    a.categoria = 'mutado';
    expect(classifyCancel('muy caro').categoria).toBe('precio_flete');
  });

  it('mutar el catch-all de una llamada no contamina la siguiente', () => {
    const a = classifyCancel('');
    a.tipo = 'ahorro';
    expect(classifyCancel('').tipo).toBe('desconocido');
  });
});

// ── GUARDIÁN ──────────────────────────────────────────────────────────
// "Cancelado fuera del CRM" era UN bucket para tres hechos distintos: la
// canceló una persona en Dropi, la canceló el bot de WhatsApp, o **el pedido
// se rehizo**. Los dos primeros son ventas perdidas sin explicación; el
// tercero no es una pérdida en absoluto.
//
// Medido en agosto-EC: 19 de 187 cancelados sin motivo volvieron a entrar con
// otro número en menos de 48 h, mismo cliente y mismo producto. Contarlos como
// pérdida cuenta la misma plata dos veces — una como cancelada y otra como
// venta nueva.
describe('GUARDIÁN: un pedido rehecho no es una venta perdida', () => {
  it('recreado gana sobre el origen y sale del denominador', () => {
    const c = classifyCancelRow({ motivo: null, origen: 'externo', recreado: true });
    expect(c.categoria).toBe('recreado_externo');
    expect(c.tipo).toBe('ahorro');
    expect(c.cuentaEnTasa).toBe(false);
  });

  it('recreado gana incluso con motivo escrito por una asesora', () => {
    // Si el pedido volvió a entrar, volvió a entrar. Da igual qué se anotó.
    const c = classifyCancelRow({ motivo: 'Se arrepintió', origen: 'guardian', recreado: true });
    expect(c.categoria).toBe('recreado_externo');
    expect(c.cuentaEnTasa).toBe(false);
  });

  it('sin la marca, la conducta de antes NO cambia', () => {
    // La migración puede no estar aplicada: `recreado` llega undefined y todo
    // tiene que seguir clasificando igual que ayer.
    expect(classifyCancelRow({ motivo: null, origen: 'externo' }).categoria).toBe('externo_dropi');
    expect(classifyCancelRow({ motivo: null, origen: 'guardian' }).categoria).toBe('sin_motivo');
    expect(classifyCancelRow({ motivo: 'Se arrepintió', origen: 'guardian' }).categoria).toBe('arrepentido');
    expect(classifyCancelRow({ motivo: null, origen: 'externo', recreado: false }).categoria).toBe('externo_dropi');
  });

  it('la categoría nueva tiene etiqueta legible', () => {
    // Sin etiqueta, la pantalla imprimiría el slug crudo al dueño.
    expect(cancelCategoriaLabel('recreado_externo')).not.toBe('recreado_externo');
  });
});
