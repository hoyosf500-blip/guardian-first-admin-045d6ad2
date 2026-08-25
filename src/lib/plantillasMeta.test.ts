import { describe, it, expect } from 'vitest';
import {
  parsearPlantillas, renderizar, faltantes, sugerirValores,
  ordenarParaFase, etiquetaDe, indicesDe, primerNombre, construirPayloadMeta,
} from './plantillasMeta';

// Plantillas REALES de la cuenta, copiadas tal cual las devuelve
// `whatsapp_managment/obtenerTemplatesWhatsapp` el 25-ago-2026. Si ImporChat
// cambia la forma de la respuesta, estas pruebas se ponen rojas antes de que
// una asesora mande un mensaje con los huecos cruzados.
const RETIRO_AGENCIA = {
  name: 'retiro_agencia_disponible_k1',
  status: 'APPROVED',
  category: 'UTILITY',
  language: 'es',
  components: [{
    type: 'BODY',
    text: 'Hola {{1}}, tu pedido ya llegó y está listo para que lo retires 🎉\n\n📍Agencia: {{2}}\n🔖Guía: {{3}}\n🗓️Plazo para retirar: {{4}} días\n\nSolo acércate con tu cédula y el número de guía 😊',
    example: { body_text: [['Daniel', 'Servientrega Guayaquil Centro', 'V123456789', '7']] },
  }],
};

const NOVEDAD_K2 = {
  name: 'novedad_k2',
  status: 'APPROVED',
  category: 'UTILITY',
  language: 'es',
  components: [
    { type: 'BODY', text: 'Estimado cliente, le recordamos que al seleccionar pago contraentrega, usted se comprometió a recibir y pagar el pedido.' },
    { type: 'BUTTONS', buttons: [{ text: 'Confirmo recepción' }, { text: 'Reprogramar entrega' }] },
  ],
};

const EN_REVISION = {
  name: 'todavia_no_aprobada',
  status: 'PENDING',
  category: 'UTILITY',
  language: 'es',
  components: [{ type: 'BODY', text: 'Hola {{1}}' }],
};

describe('parsearPlantillas', () => {
  it('lee huecos, etiquetas, ejemplos y botones de una plantilla real', () => {
    const [p] = parsearPlantillas([RETIRO_AGENCIA]);
    expect(p.nombre).toBe('retiro_agencia_disponible_k1');
    expect(p.categoria).toBe('UTILITY');
    expect(p.variables.map((v) => v.indice)).toEqual([1, 2, 3, 4]);
    expect(p.variables[1].etiqueta).toBe('Agencia');
    expect(p.variables[2].etiqueta).toBe('Guía');
    expect(p.variables[3].etiqueta).toBe('Plazo para retirar');
    expect(p.variables[0].ejemplo).toBe('Daniel');
    expect(p.variables[1].ejemplo).toBe('Servientrega Guayaquil Centro');
  });

  it('trae los botones que el cliente va a ver', () => {
    const [p] = parsearPlantillas([NOVEDAD_K2]);
    expect(p.botones).toEqual(['Confirmo recepción', 'Reprogramar entrega']);
    expect(p.variables).toEqual([]);
  });

  // ⛔ Una plantilla sin aprobar NO se entrega. Ofrecerla sería el mismo error
  // que la ventana de 24 h ya evita: un mensaje que se pierde en silencio y una
  // asesora convencida de que avisó.
  it('descarta todo lo que Meta no aprobó', () => {
    expect(parsearPlantillas([EN_REVISION])).toEqual([]);
    expect(parsearPlantillas([{ ...EN_REVISION, status: 'REJECTED' }])).toEqual([]);
  });

  it('no explota con basura', () => {
    expect(parsearPlantillas(null)).toEqual([]);
    expect(parsearPlantillas([null, 'texto', 42, {}])).toEqual([]);
    expect(parsearPlantillas([{ name: 'x', status: 'APPROVED', components: [] }])).toEqual([]);
  });
});

describe('etiquetaDe — solo cuando el cuerpo REALMENTE etiqueta el hueco', () => {
  it('toma lo que está antes de los dos puntos, en la misma línea', () => {
    expect(etiquetaDe('📍Agencia: {{2}}', 2)).toBe('Agencia');
    expect(etiquetaDe('linea previa\nGuía: {{3}}', 3)).toBe('Guía');
  });

  // "Hola" no es el nombre del hueco, es un saludo. Una etiqueta inventada es
  // peor que ninguna: la asesora la creería.
  it('un saludo NO es una etiqueta', () => {
    expect(etiquetaDe('Hola {{1}}, tu pedido llegó', 1)).toBeNull();
    expect(etiquetaDe('Tu orden {{2}} ya salió', 2)).toBeNull();
  });

  it('no cruza de línea', () => {
    expect(etiquetaDe('Agencia:\n{{2}}', 2)).toBeNull();
  });

  it('hueco inexistente devuelve null', () => {
    expect(etiquetaDe('Hola {{1}}', 9)).toBeNull();
  });
});

describe('indicesDe', () => {
  it('ordena, deduplica e ignora lo que no es hueco', () => {
    expect(indicesDe('{{3}} y {{1}} y {{3}} otra vez {{2}}')).toEqual([1, 2, 3]);
    expect(indicesDe('sin huecos')).toEqual([]);
    expect(indicesDe('{{0}} no cuenta')).toEqual([]);
  });
});

describe('renderizar — la vista previa es lo que le llega al cliente', () => {
  it('reemplaza cada hueco por su valor', () => {
    expect(renderizar('Hola {{1}}, tu guía es {{2}}', { 1: 'Ana', 2: 'V123' }))
      .toBe('Hola Ana, tu guía es V123');
  });

  // Un hueco vacío no se borra: se VE. Si se borrara, el mensaje llegaría con
  // un espacio raro y pareciendo un error del negocio, y nadie lo habría visto
  // antes de mandarlo.
  it('un hueco sin llenar queda a la vista', () => {
    expect(renderizar('Agencia: {{2}}', {})).toBe('Agencia: [falta 2]');
    expect(renderizar('Agencia: {{2}}', { 2: '   ' })).toBe('Agencia: [falta 2]');
  });
});

describe('faltantes — el freno antes de enviar', () => {
  it('lista los huecos vacíos y se vacía cuando está completo', () => {
    const [p] = parsearPlantillas([RETIRO_AGENCIA]);
    expect(faltantes(p, {})).toEqual([1, 2, 3, 4]);
    expect(faltantes(p, { 1: 'Ana', 2: 'Servientrega', 3: 'V1' })).toEqual([4]);
    expect(faltantes(p, { 1: 'Ana', 2: 'Servientrega', 3: 'V1', 4: '7' })).toEqual([]);
  });

  it('una plantilla sin huecos nunca frena', () => {
    const [p] = parsearPlantillas([NOVEDAD_K2]);
    expect(faltantes(p, {})).toEqual([]);
  });
});

describe('sugerirValores — sugiere, no inventa', () => {
  const [p] = parsearPlantillas([RETIRO_AGENCIA]);

  it('llena el saludo con el primer nombre y las etiquetas con el dato del pedido', () => {
    const v = sugerirValores(p, {
      nombre: 'MARIA JOSE PEREZ', transportadora: 'SERVIENTREGA', guia: '6689105',
    });
    expect(v[1]).toBe('Maria');
    expect(v[2]).toBe('SERVIENTREGA');
    expect(v[3]).toBe('6689105');
  });

  // ⛔ La prueba que da sentido al módulo. El ejemplo de Meta para el hueco 4
  // dice "7", y copiarlo sería inventarle un plazo a un cliente real: ese
  // número depende de la transportadora y Guardian no lo sabe.
  it('NO inventa el plazo en días, aunque Meta traiga un ejemplo', () => {
    const v = sugerirValores(p, { nombre: 'Ana', transportadora: 'LAAR', guia: 'V1' });
    expect(v[4]).toBeUndefined();
    expect(faltantes(p, v)).toEqual([4]);
  });

  it('un dato que el pedido no tiene deja el hueco vacío, no un texto parecido', () => {
    const v = sugerirValores(p, { nombre: 'Ana' });
    expect(v[2]).toBeUndefined();
    expect(v[3]).toBeUndefined();
    expect(JSON.stringify(v)).not.toMatch(/null|undefined|—/);
  });

  it('sin ningún dato del pedido no sugiere nada', () => {
    expect(sugerirValores(p, {})).toEqual({});
  });
});

describe('ordenarParaFase', () => {
  const crudas = [
    { name: 'plantilla_de_prueba', status: 'APPROVED', category: 'MARKETING', language: 'es', components: [{ type: 'BODY', text: 'prueba' }] },
    { name: 'remarketing_k1', status: 'APPROVED', category: 'MARKETING', language: 'es', components: [{ type: 'BODY', text: 'texto' }] },
    { name: 'novedad_k1', status: 'APPROVED', category: 'UTILITY', language: 'es', components: [{ type: 'BODY', text: 'texto' }] },
    RETIRO_AGENCIA,
  ];
  const todas = parsearPlantillas(crudas);

  it('sube la que habla de dónde está el paquete', () => {
    expect(ordenarParaFase(todas, 'oficina')[0].nombre).toBe('retiro_agencia_disponible_k1');
    expect(ordenarParaFase(todas, 'novedad')[0].nombre).toBe('novedad_k1');
  });

  it('las de prueba van al fondo', () => {
    const o = ordenarParaFase(todas, 'oficina');
    expect(o[o.length - 1].nombre).toBe('plantilla_de_prueba');
  });

  // No esconde ninguna: decidir por la asesora con una regexp sería quitarle
  // la plantilla que justo necesitaba para un caso que no previmos.
  it('nunca pierde una plantilla, con fase o sin fase', () => {
    expect(ordenarParaFase(todas, 'oficina')).toHaveLength(todas.length);
    expect(ordenarParaFase(todas, null)).toHaveLength(todas.length);
    expect(ordenarParaFase(todas, 'fase_que_no_existe')).toHaveLength(todas.length);
  });
});

// Las 3 formas reales que Guardian NO puede armar, copiadas de la cuenta.
const CON_VIDEO = {
  name: 'remarketing_k1', status: 'APPROVED', category: 'MARKETING', language: 'es',
  components: [
    { type: 'HEADER', format: 'VIDEO', example: { header_handle: ['https://scontent.whatsapp.net/x.mp4'] } },
    { type: 'BODY', text: 'Tu pedido ya está listo para salir.' },
  ],
};
const CON_BOTON_LINK = {
  name: 'guia_generada_k1', status: 'APPROVED', category: 'UTILITY', language: 'es',
  components: [
    { type: 'BODY', text: 'La guía de envío de tu pedido ha sido generada.' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Descargar Guía', url: 'https://cdn/{{1}}' }] },
  ],
};
const CON_HEADER_TEXTO = {
  name: 'zona_entrega_k1', status: 'APPROVED', category: 'UTILITY', language: 'es',
  components: [
    { type: 'HEADER', format: 'TEXT', text: 'Llego el día de entrega' },
    { type: 'BODY', text: 'Hoy tu pedido ha llegado a {{1}}.' },
  ],
};

describe('noSoportada — decir por qué, en vez de mandar algo roto', () => {
  it('marca la que lleva video y explica dónde mandarla', () => {
    const [p] = parsearPlantillas([CON_VIDEO]);
    expect(p.noSoportada).toMatch(/video/i);
    expect(p.noSoportada).toMatch(/ImporChat/);
  });

  it('marca la que tiene un botón con enlace variable', () => {
    const [p] = parsearPlantillas([CON_BOTON_LINK]);
    expect(p.noSoportada).toMatch(/enlace/i);
  });

  // Un título de TEXTO fijo no es un impedimento: viaja solo con la plantilla.
  it('un título de texto fijo NO bloquea nada', () => {
    const [p] = parsearPlantillas([CON_HEADER_TEXTO]);
    expect(p.noSoportada).toBeNull();
  });

  it('las de logística que la asesora usa a diario sí se pueden mandar', () => {
    for (const cruda of [RETIRO_AGENCIA, NOVEDAD_K2]) {
      expect(parsearPlantillas([cruda])[0].noSoportada, cruda.name).toBeNull();
    }
  });

  // ⚠️ Se listan igual: esconderlas haría creer que no existen.
  it('las bloqueadas siguen apareciendo en la lista', () => {
    expect(parsearPlantillas([CON_VIDEO, CON_BOTON_LINK])).toHaveLength(2);
  });
});

describe('construirPayloadMeta — donde un error NO se ve', () => {
  const [p] = parsearPlantillas([RETIRO_AGENCIA]);

  it('arma el payload que Meta espera', () => {
    const payload = construirPayloadMeta(p, { 1: 'Ana', 2: 'Servientrega', 3: 'V1', 4: '7' }, '593987871223');
    expect(payload).toEqual({
      messaging_product: 'whatsapp',
      to: '593987871223',
      type: 'template',
      template: {
        name: 'retiro_agencia_disponible_k1',
        language: { code: 'es' },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: 'Ana' },
            { type: 'text', text: 'Servientrega' },
            { type: 'text', text: 'V1' },
            { type: 'text', text: '7' },
          ],
        }],
      },
    });
  });

  // Los huecos son POSICIONALES: si los parámetros salen en otro orden, Meta
  // NO da error — al cliente le llega "tu pedido está en 7". Por eso el orden
  // se fija por el índice del hueco, nunca por el orden del objeto.
  it('ordena por el número del hueco, no por cómo se cargó el objeto', () => {
    const desordenado = { 4: '7', 2: 'Servientrega', 1: 'Ana', 3: 'V1' };
    const params = (construirPayloadMeta(p, desordenado, '1') as never as {
      template: { components: Array<{ parameters: Array<{ text: string }> }> };
    }).template.components[0].parameters.map((x) => x.text);
    expect(params).toEqual(['Ana', 'Servientrega', 'V1', '7']);
  });

  it('una plantilla sin huecos va sin componentes', () => {
    const [sinHuecos] = parsearPlantillas([NOVEDAD_K2]);
    const payload = construirPayloadMeta(sinHuecos, {}, '1') as never as {
      template: { components: unknown[] };
    };
    expect(payload.template.components).toEqual([]);
  });
});

describe('primerNombre', () => {
  it('normaliza como lo espera el cliente que lo lee', () => {
    expect(primerNombre('MARIA JOSE')).toBe('Maria');
    expect(primerNombre('  ana  ')).toBe('Ana');
    expect(primerNombre('')).toBe('');
    expect(primerNombre(null)).toBe('');
  });
});
