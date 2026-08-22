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

describe('el que nunca usó el WhatsApp deja de ser "no sé"', () => {
  // Agosto-EC: 157 pedidos, 66,2% de cancelación, $3.219 — la mitad de todo lo
  // perdido en el mes — caían en el bucket ciego. La señal viene del botón de
  // confirmación de ImporChat (`orders.chat_riesgo`), no de texto.

  it('sin motivo escrito, "mudo" le pone nombre a la cancelación', () => {
    const c = classifyCancelRow({ motivo: null, origen: 'externo', riesgoChat: 'mudo' });
    expect(c.categoria).toBe('sin_whatsapp');
    expect(c.culpa).toBe('trafico');
    expect(c.esGenerica).toBe(false);
  });

  it('NO se declara evitable, aunque tiente', () => {
    // De los 96 que nunca se confirmaron por teléfono, 63 fueron llamados hasta
    // SEIS veces sin que nadie atendiera. Llamar más no los salvaba. Marcarlos
    // evitables sería un reclamo injusto al equipo.
    const c = classifyCancelRow({ motivo: null, origen: 'externo', riesgoChat: 'mudo' });
    expect(c.tipo).toBe('desconocido');
    expect(c.tipo).not.toBe('perdida_evitable');
  });

  it('sigue contando en la tasa: la venta se perdió igual', () => {
    expect(classifyCancelRow({ motivo: null, origen: 'externo', riesgoChat: 'mudo' }).cuentaEnTasa)
      .toBe(true);
  });

  it('la palabra de la asesora manda sobre la señal automática', () => {
    // Si alguien se tomó el trabajo de anotar por qué, esa razón vale más que
    // una inferencia — aunque el cliente además nunca haya usado el chat.
    const c = classifyCancelRow({
      motivo: 'el cliente dijo que estaba muy caro el flete',
      origen: 'guardian',
      riesgoChat: 'mudo',
    });
    expect(c.categoria).not.toBe('sin_whatsapp');
    expect(c.culpa).toBe('precio_oferta');
  });

  it('un motivo que es puro ruido NO le gana a la señal', () => {
    // "ok", "x", "-" no son un motivo: son una casilla llenada por llenar.
    const c = classifyCancelRow({ motivo: 'ok', origen: 'guardian', riesgoChat: 'mudo' });
    expect(c.categoria).toBe('sin_whatsapp');
  });

  it('un pedido recreado sigue ganando: no se perdió ninguna venta', () => {
    const c = classifyCancelRow({
      motivo: null, origen: 'externo', recreado: true, riesgoChat: 'mudo',
    });
    expect(c.categoria).toBe('recreado_externo');
    expect(c.cuentaEnTasa).toBe(false);
  });

  it('los otros niveles de la señal NO clasifican nada', () => {
    // Solo `mudo` afirma algo sobre el cliente. Que alguien no haya apretado el
    // botón no explica por qué canceló, y usarlo como motivo sería inventar.
    for (const r of ['confirmado', 'tibio', 'frio', 'sin_dato', null, undefined]) {
      const c = classifyCancelRow({ motivo: null, origen: 'externo', riesgoChat: r as string });
      expect(c.categoria, `${r} no debería clasificar`).toBe('externo_dropi');
    }
  });

  it('tiene etiqueta legible', () => {
    expect(cancelCategoriaLabel('sin_whatsapp')).not.toBe('sin_whatsapp');
    expect(cancelCategoriaLabel('sin_whatsapp').toLowerCase()).toContain('whatsapp');
  });
});

describe('los falsos positivos que inflaban las categorías equivocadas', () => {
  // Todos estos casos se midieron ejecutando el código real antes de arreglarlo:
  // no son hipótesis, son lo que la taxonomía devolvía.

  describe('"CARO" dentro de los verbos en -caron', () => {
    // `'CARO'` como subcadena matcheaba dentro de equivoCAROn, expliCAROn,
    // coloCAROn, busCAROn. Cuatro fallas NUESTRAS se reportaban como "el precio
    // está caro" — y `precio_flete` es la categoría que manda a cambiar el
    // anuncio. Ahora va por palabra completa (`anyWord`).
    for (const t of [
      'se equivocaron de pedido',
      'me explicaron mal el producto',
      'colocaron mal la direccion',
      'nunca lo buscaron en la oficina',
      'ya lo sacaron de la bodega',
    ]) {
      it(`"${t}" NO es un problema de precio`, () => {
        expect(classifyCancel(t).categoria).not.toBe('precio_flete');
      });
    }

    it('pero "caro" de verdad sigue clasificando', () => {
      // El caso que el comentario de MIN_LEN defiende: 'CARO' a secas es un
      // motivo legítimo. Si esto se rompe, el arreglo se pasó de largo.
      expect(classifyCancel('CARO').categoria).toBe('precio_flete');
      expect(classifyCancel('esta caro.').categoria).toBe('precio_flete');
      expect(classifyCancel('muy caro el flete').categoria).toBe('precio_flete');
      expect(classifyCancel('me parece costoso').categoria).toBe('precio_flete');
    });

    it('`any` y `anyWord` son alternativas, no dos condiciones que se suman', () => {
      // Con AND, una regla que tuviera las dos listas exigiría un token de cada
      // una y 'CARO' solo dejaría de matchear.
      expect(classifyCancel('CARO').categoria).toBe('precio_flete');       // solo anyWord
      expect(classifyCancel('el precio').categoria).toBe('precio_flete');  // solo any
    });
  });

  describe('el "no quiere" con el que arranca la frase tapaba la causa real', () => {
    // `arrepentido` iba ANTES de familiar/fuerza_mayor/cobertura y se los comía.
    // Siempre para el mismo lado: de inevitable a EVITABLE, o sea reclamándole
    // al equipo algo que no podía evitar.
    it('"no quiere porque el esposo no la autoriza" → no lo autorizan en la casa', () => {
      const c = classifyCancel('no quiere porque el esposo no la autoriza');
      expect(c.categoria).toBe('familiar_no_autoriza');
      expect(c.tipo).toBe('perdida_inevitable');
    });

    it('"cancela el pedido porque no llega a su zona" → transportadora', () => {
      const c = classifyCancel('cancela el pedido porque no llega a su zona');
      expect(c.culpa).toBe('transportadora');
      expect(c.tipo).toBe('perdida_inevitable');
    });

    it('"cancela el pedido, esta de viaje" → fuerza mayor', () => {
      expect(classifyCancel('el cliente cancela el pedido, esta de viaje').categoria)
        .toBe('fuerza_mayor');
    });

    it('un arrepentimiento sin otra causa SIGUE siendo arrepentimiento', () => {
      expect(classifyCancel('se arrepintio').categoria).toBe('arrepentido');
      expect(classifyCancel('cambio de opinion').categoria).toBe('arrepentido');
    });
  });

  it('"adelanto" suelto movía plata de pérdida a AHORRO', () => {
    // "el cliente adelantó el viaje" caía en sin_anticipo → filtro_interno →
    // tipo 'ahorro', o sea la columna que dice que estuvo bien cancelar.
    expect(classifyCancel('el cliente adelanto el viaje').tipo).not.toBe('ahorro');
    // Y el anticipo de verdad sigue funcionando.
    expect(classifyCancel('no dio el adelanto').categoria).toBe('sin_anticipo');
    expect(classifyCancel('no pago el anticipo').categoria).toBe('sin_anticipo');
  });

  it('un dato FALSO es plata de pauta, no una falla de carga nuestra', () => {
    // Vivían en `datos_malos` (operacion/evitable): le cobraban a la operación
    // una pérdida que nunca fue suya.
    for (const t of ['datos falsos', 'direccion falsa']) {
      const c = classifyCancel(t);
      expect(c.culpa, t).toBe('trafico');
      expect(c.tipo, t).toBe('perdida_inevitable');
    }
    // Un dato mal CARGADO sigue siendo nuestro.
    expect(classifyCancel('telefono errado').culpa).toBe('operacion');
  });
});

describe('lo que las asesoras escriben y caía en "sin clasificar"', () => {
  // De los 12 textos reales de agosto-EC que caían en `otro`, 8 pertenecían a
  // categorías que YA existían. No era vocabulario exótico: eran reglas
  // demasiado literales y una categoría sin regla de texto.

  it('"NO TIENE WHATSAPP" tiene regla de texto, no solo señal automática', () => {
    // La categoría existía desde el 22-ago pero SOLO se alcanzaba por
    // `riesgoChat==='mudo'`. La asesora escribía el motivo que existe y el
    // reporte lo mandaba a "Otro".
    for (const t of ['NO TIENE WHATSAPP', 'NO TIENE WHATSAPP EL NUMERO', 'NO TIENE WHASTAPP']) {
      expect(classifyCancel(t).categoria, t).toBe('sin_whatsapp');
    }
  });

  it('el texto y la señal automática coinciden en culpa', () => {
    // Si el mismo hecho cayera en dos culpas distintas según quién lo detectó,
    // la portada "¿de qué lado está el problema?" sería ilegible.
    const porTexto = classifyCancel('no tiene whatsapp');
    const porSenal = classifyCancelRow({ motivo: null, origen: 'externo', riesgoChat: 'mudo' });
    expect(porTexto.categoria).toBe(porSenal.categoria);
    expect(porTexto.culpa).toBe(porSenal.culpa);
  });

  it('"la publicidad era otro modelo" apunta al anuncio', () => {
    // `promesa_no_cumplida` es la ÚNICA categoría que manda a revisar el
    // creativo, y era la que nunca corría: exigía la frase exacta
    // 'EL ANUNCIO DECIA'. Cuatro de los 12 `otro` de agosto son esto.
    for (const t of [
      'Cancela por el modelo, en la publicidad era otro modelo',
      'CANCELA, QUIERE EL MODELO DE LA PUBLICIDAD',
      'no le gusta el diseno, queria las gafas del anuncio',
      'ya habian pedido pero que no eran lo que estaba en la publicidad',
    ]) {
      const c = classifyCancel(t);
      expect(c.categoria, t).toBe('promesa_no_cumplida');
      expect(c.culpa, t).toBe('precio_oferta');
    }
  });

  it('el PLURAL "no eran lo que" también matchea', () => {
    // Fallaba por una sola letra contra 'NO ERA LO QUE'.
    expect(classifyCancel('no eran lo que pedi').categoria).toBe('promesa_no_cumplida');
    expect(classifyCancel('no era lo que pedi').categoria).toBe('promesa_no_cumplida');
  });

  it('"NUMERO INCORRECTO" es un dato malo', () => {
    // El texto libre más repetido de la muestra real, y caía en `otro` aunque
    // estaban ERRADO, EQUIVOCADO, ERRONEO e INVALIDO.
    expect(classifyCancel('NUMERO INCORRECTO').categoria).toBe('datos_malos');
  });

  it('"un viaje a Peru" es fuerza mayor aunque no diga "de viaje"', () => {
    expect(classifyCancel('Cliente cancela por un viaje a Peru, vuelve en 2 meses').categoria)
      .toBe('fuerza_mayor');
  });
});
