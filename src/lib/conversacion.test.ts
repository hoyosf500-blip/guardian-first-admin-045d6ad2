import { describe, it, expect } from 'vitest';
import { normalizarConversacion, ultimoEntranteMs, ultimoSaliente, ultimoAutorNegocio, type MensajeIC, urlDeArchivo } from './conversacion';

/**
 * El hilo de WhatsApp que ve la asesora dentro de Guardian.
 *
 * Lo que se protege acá no es el formato: es que la pantalla no AFIRME cosas
 * que el dato no dice. Un mensaje sin `responsable` no es "del bot", un mensaje
 * sin fecha no se puede reordenar, y ningún mensaje puede desaparecer.
 */

const msg = (m: Partial<MensajeIC>): MensajeIC => ({ id: Math.random(), ...m });
const enT = (min: number) => new Date(Date.UTC(2026, 7, 24, 12, min, 0)).toISOString();

describe('normalizarConversacion — de qué lado vino cada mensaje', () => {
  it('rol 0 es el cliente, rol 1 el negocio, rol 3 el sistema', () => {
    const r = normalizarConversacion([
      msg({ id: 1, rol_mensaje: 0, texto_mensaje: 'hola', created_at: enT(1) }),
      msg({ id: 2, rol_mensaje: 1, texto_mensaje: 'buenas', created_at: enT(2) }),
      msg({ id: 3, rol_mensaje: 3, texto_mensaje: 'Te has asignado este chat', created_at: enT(3) }),
    ]);
    expect(r.map((x) => x.de)).toEqual(['cliente', 'negocio', 'sistema']);
  });

  // Un borrado o una notificación interna NO son conversación aunque vengan con
  // rol de negocio: si se mostraran como un mensaje al cliente, la asesora
  // creería que alguien le escribió.
  it('un revoke o una notificación son sistema aunque el rol diga negocio', () => {
    const r = normalizarConversacion([
      msg({ id: 1, rol_mensaje: 1, tipo_mensaje: 'revoke', created_at: enT(1) }),
      msg({ id: 2, rol_mensaje: 1, tipo_mensaje: 'notificacion', texto_mensaje: 'x', created_at: enT(2) }),
    ]);
    expect(r.map((x) => x.de)).toEqual(['sistema', 'sistema']);
  });

  it('un rol desconocido NO se descarta: se muestra como sistema', () => {
    const r = normalizarConversacion([msg({ id: 1, rol_mensaje: 99, texto_mensaje: 'raro', created_at: enT(1) })]);
    expect(r).toHaveLength(1);
    expect(r[0].de).toBe('sistema');
    expect(r[0].texto).toBe('raro');
  });
});

describe('normalizarConversacion — quién escribió (la pregunta del dueño)', () => {
  it('el autor es el responsable CRUDO, sin traducir', () => {
    const r = normalizarConversacion([
      msg({ id: 1, rol_mensaje: 1, responsable: 'Shopify Confirmación', texto_mensaje: 'a', created_at: enT(1) }),
      msg({ id: 2, rol_mensaje: 1, responsable: 'Estefano Moreno', texto_mensaje: 'b', created_at: enT(2) }),
    ]);
    expect(r.map((x) => x.autor)).toEqual(['Shopify Confirmación', 'Estefano Moreno']);
  });

  // ⛔ La regla de la casa. Sin `responsable` no se sabe quién fue, y "bot" es
  // una afirmación. El mismo motivo por el que chat_saliente_at en NULL nunca
  // significa "no le escribieron".
  it('sin responsable el autor es null, JAMÁS "bot"', () => {
    const r = normalizarConversacion([
      msg({ id: 1, rol_mensaje: 1, texto_mensaje: 'a', created_at: enT(1) }),
      msg({ id: 2, rol_mensaje: 1, responsable: '   ', texto_mensaje: 'b', created_at: enT(2) }),
      msg({ id: 3, rol_mensaje: 1, responsable: null, texto_mensaje: 'c', created_at: enT(3) }),
    ]);
    expect(r.map((x) => x.autor)).toEqual([null, null, null]);
    expect(JSON.stringify(r)).not.toMatch(/bot/i);
  });
});

describe('normalizarConversacion — nada se pierde ni se reordena mal', () => {
  it('deduplica por id quedándose con el primero', () => {
    const r = normalizarConversacion([
      msg({ id: 7, rol_mensaje: 0, texto_mensaje: 'original', created_at: enT(1) }),
      msg({ id: 7, rol_mensaje: 0, texto_mensaje: 'repetido', created_at: enT(1) }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].texto).toBe('original');
  });

  it('ordena cronológicamente aunque el socket los entregue desordenados', () => {
    const r = normalizarConversacion([
      msg({ id: 1, rol_mensaje: 0, texto_mensaje: 'tercero', created_at: enT(30) }),
      msg({ id: 2, rol_mensaje: 0, texto_mensaje: 'primero', created_at: enT(10) }),
      msg({ id: 3, rol_mensaje: 0, texto_mensaje: 'segundo', created_at: enT(20) }),
    ]);
    expect(r.map((x) => x.texto)).toEqual(['primero', 'segundo', 'tercero']);
  });

  // Mandar un mensaje sin fecha al borde reordenaría la conversación entera y
  // haría parecer que la asesora contestó antes de que preguntaran.
  it('un mensaje sin fecha se queda pegado al anterior, no salta al borde', () => {
    const r = normalizarConversacion([
      msg({ id: 1, rol_mensaje: 0, texto_mensaje: 'viejo', created_at: enT(10) }),
      msg({ id: 2, rol_mensaje: 1, texto_mensaje: 'sin fecha' }),
      msg({ id: 3, rol_mensaje: 0, texto_mensaje: 'nuevo', created_at: enT(40) }),
    ]);
    expect(r.map((x) => x.texto)).toEqual(['viejo', 'sin fecha', 'nuevo']);
  });

  it('un mensaje sin fecha al principio sigue al principio', () => {
    const r = normalizarConversacion([
      msg({ id: 1, rol_mensaje: 1, texto_mensaje: 'sin fecha' }),
      msg({ id: 2, rol_mensaje: 0, texto_mensaje: 'con fecha', created_at: enT(10) }),
    ]);
    expect(r.map((x) => x.texto)).toEqual(['sin fecha', 'con fecha']);
  });

  it('sin mensajes devuelve lista vacía sin explotar', () => {
    expect(normalizarConversacion(null)).toEqual([]);
    expect(normalizarConversacion(undefined)).toEqual([]);
    expect(normalizarConversacion([])).toEqual([]);
  });
});

describe('normalizarConversacion — mensajes sin texto', () => {
  it('una nota de voz o una foto se muestran, no se descartan', () => {
    const r = normalizarConversacion([
      msg({ id: 1, rol_mensaje: 0, tipo_mensaje: 'audio', ruta_archivo: 'x.ogg', created_at: enT(1) }),
      msg({ id: 2, rol_mensaje: 0, tipo_mensaje: 'image', ruta_archivo: 'y.jpg', created_at: enT(2) }),
    ]);
    expect(r).toHaveLength(2);
    expect(r[0].texto).toMatch(/voz/i);
    expect(r[1].texto).toMatch(/imagen/i);
    expect(r.every((x) => x.esMarcador)).toBe(true);
  });

  it('el texto real gana sobre el marcador', () => {
    const r = normalizarConversacion([
      msg({ id: 1, rol_mensaje: 0, tipo_mensaje: 'button', texto_mensaje: 'CONFIRMAR PEDIDO', created_at: enT(1) }),
    ]);
    expect(r[0].texto).toBe('CONFIRMAR PEDIDO');
    expect(r[0].esMarcador).toBe(false);
  });

  it('un adjunto de tipo desconocido igual se muestra', () => {
    const r = normalizarConversacion([
      msg({ id: 1, rol_mensaje: 0, tipo_mensaje: 'algo_nuevo', ruta_archivo: 'z.bin', created_at: enT(1) }),
    ]);
    expect(r[0].texto).toBe('📎 Adjunto');
  });
});

describe('ultimoEntranteMs — lo que abre la ventana de 24 h', () => {
  it('toma el último mensaje DEL CLIENTE, no el del negocio', () => {
    const r = normalizarConversacion([
      msg({ id: 1, rol_mensaje: 0, texto_mensaje: 'cliente viejo', created_at: enT(10) }),
      msg({ id: 2, rol_mensaje: 0, texto_mensaje: 'cliente nuevo', created_at: enT(20) }),
      msg({ id: 3, rol_mensaje: 1, texto_mensaje: 'negocio', created_at: enT(30) }),
    ]);
    expect(ultimoEntranteMs(r)).toBe(Date.parse(enT(20)));
  });

  it('sin mensajes del cliente devuelve null (no cero)', () => {
    const r = normalizarConversacion([msg({ id: 1, rol_mensaje: 1, texto_mensaje: 'solo negocio', created_at: enT(1) })]);
    expect(ultimoEntranteMs(r)).toBeNull();
  });
});

describe('ultimoSaliente — para refrescar el pedido con lo recién leído', () => {
  it('una plantilla se marca plantilla y un texto directo, directo', () => {
    const plantilla = normalizarConversacion([
      msg({ id: 1, rol_mensaje: 1, tipo_mensaje: 'template', texto_mensaje: 'hola', created_at: enT(5) }),
    ]);
    expect(ultimoSaliente(plantilla)).toEqual({ fechaMs: Date.parse(enT(5)), tipo: 'plantilla' });

    const directo = normalizarConversacion([
      msg({ id: 2, rol_mensaje: 1, tipo_mensaje: 'text', texto_mensaje: 'hola', created_at: enT(6) }),
    ]);
    expect(ultimoSaliente(directo)?.tipo).toBe('directo');
  });

  it('ignora al cliente y devuelve null si el negocio nunca escribió', () => {
    const r = normalizarConversacion([msg({ id: 1, rol_mensaje: 0, texto_mensaje: 'hola', created_at: enT(1) })]);
    expect(ultimoSaliente(r)).toBeNull();
  });
});

// ⛔ "¿el bot le envió la automatización?" — pedido del dueño para Confirmar.
// La respuesta honesta es el NOMBRE de quien escribió, no una etiqueta.
describe('ultimoAutorNegocio', () => {
  it('devuelve el nombre crudo del último mensaje del negocio', () => {
    const r = normalizarConversacion([
      msg({ id: 1, rol_mensaje: 1, texto_mensaje: 'a', responsable: 'Shopify Confirmación', created_at: enT(1) }),
      msg({ id: 2, rol_mensaje: 0, texto_mensaje: 'ok', created_at: enT(2) }),
      msg({ id: 3, rol_mensaje: 1, texto_mensaje: 'b', responsable: 'Dropi Status', created_at: enT(3) }),
    ]);
    expect(ultimoAutorNegocio(r)?.autor).toBe('Dropi Status');
  });

  it('el nombre de una persona sale igual de crudo: no se clasifica nada', () => {
    const r = normalizarConversacion([
      msg({ id: 1, rol_mensaje: 1, texto_mensaje: 'a', responsable: 'Estefano Moreno', created_at: enT(1) }),
    ]);
    const a = ultimoAutorNegocio(r);
    expect(a?.autor).toBe('Estefano Moreno');
    expect(JSON.stringify(a)).not.toMatch(/bot|asesora|autom/i);
  });

  // Guardian no puede saber quién es un robot; un `responsable` vacío se
  // queda sin autor, jamás con un rótulo puesto por nosotros.
  it('sin responsable NO inventa un autor', () => {
    const r = normalizarConversacion([
      msg({ id: 1, rol_mensaje: 1, texto_mensaje: 'a', created_at: enT(1) }),
    ]);
    expect(ultimoAutorNegocio(r)).toBeNull();
  });

  it('el cliente no cuenta como autor del negocio', () => {
    const r = normalizarConversacion([
      msg({ id: 1, rol_mensaje: 0, texto_mensaje: 'hola', responsable: 'Pamela', created_at: enT(1) }),
    ]);
    expect(ultimoAutorNegocio(r)).toBeNull();
  });

  it('hilo vacío devuelve null', () => {
    expect(ultimoAutorNegocio([])).toBeNull();
  });
});

describe('adjuntos: la foto del cliente llega a la pantalla', () => {
  // ⛔ 28-ago-2026, reportado por el dueño: "los chats no cargan las imágenes".
  // No fallaban: ImporChat SIEMPRE mandó `ruta_archivo` y `normalizarConversacion`
  // la tiraba — solo la miraba para elegir el marcador "🖼️ Imagen". El
  // comprobante de pago que manda un cliente por WhatsApp es, muchas veces, la
  // conversación entera.
  it('la ruta del adjunto viaja en el mensaje', () => {
    const [m] = normalizarConversacion([
      { id: 1, rol_mensaje: 0, tipo_mensaje: 'image', ruta_archivo: '/uploads/comprobante.jpg', created_at: '2026-08-28T10:00:00Z' },
    ]);
    expect(m.archivoUrl).toBe('https://chat.imporfactory.app/uploads/comprobante.jpg');
    // El marcador NO se pierde: si la imagen no carga, queda el texto.
    expect(m.texto).toContain('Imagen');
  });

  it('un mensaje sin adjunto no inventa una URL', () => {
    const [m] = normalizarConversacion([
      { id: 2, rol_mensaje: 0, texto_mensaje: 'hola', created_at: '2026-08-28T10:00:00Z' },
    ]);
    expect(m.archivoUrl).toBeNull();
  });

  it('urlDeArchivo acepta absoluta, relativa y protocolo implícito', () => {
    expect(urlDeArchivo('https://cdn.otro.com/a.png')).toBe('https://cdn.otro.com/a.png');
    expect(urlDeArchivo('//cdn.otro.com/a.png')).toBe('https://cdn.otro.com/a.png');
    expect(urlDeArchivo('uploads/a.png')).toBe('https://chat.imporfactory.app/uploads/a.png');
    expect(urlDeArchivo('///uploads/a.png')).toBe('https://chat.imporfactory.app/uploads/a.png');
  });

  it('vacío o nulo → null, nunca una URL rota', () => {
    expect(urlDeArchivo(null)).toBeNull();
    expect(urlDeArchivo(undefined)).toBeNull();
    expect(urlDeArchivo('   ')).toBeNull();
  });
});

describe('⛔ ruta_archivo NO siempre es un archivo (casos REALES de producción)', () => {
  // Medido el 28-ago-2026 con la cuenta de Ecuador, 18 conversaciones seguidas.
  // De 98 valores de `ruta_archivo`: 68 eran un JSON con los datos del pedido
  // (mensajes `template` y `text`), no una ruta. Tratarlos como ruta armaba un
  // enlace roto Y metía el nombre, la dirección y el celular del cliente dentro
  // de una URL. Los adjuntos de verdad vienen absolutos y limpios.
  const JSON_DE_PLANTILLA = '{"nombre":"Javier Ordóñez","direccion":"Av. Los molinos","celular":"593985474905"}';

  it('un JSON de datos del pedido NO es un adjunto', () => {
    expect(urlDeArchivo(JSON_DE_PLANTILLA)).toBeNull();
    expect(urlDeArchivo('[{"a":1}]')).toBeNull();
  });

  it('nada con espacios o comillas se convierte en URL', () => {
    expect(urlDeArchivo('Av. Los molinos')).toBeNull();
    expect(urlDeArchivo('archivo con espacio.png')).toBeNull();
  });

  it('el mensaje de plantilla queda SIN adjunto, con su marcador', () => {
    const [m] = normalizarConversacion([
      { id: 9, rol_mensaje: 1, tipo_mensaje: 'template', ruta_archivo: JSON_DE_PLANTILLA, created_at: '2026-08-28T10:00:00Z' },
    ]);
    expect(m.archivoUrl).toBeNull();
  });

  // Los tres formatos que SÍ manda ImporChat, copiados tal cual de producción.
  it('la imagen de CloudFront pasa entera', () => {
    const u = 'https://d39ru7awumhhs2.cloudfront.net/ecuador/products/134062/1773678992PORTADA%20PRODUCTOS%20%20(62).png';
    expect(urlDeArchivo(u)).toBe(u);
  });

  it('el audio y el video de ImporChat pasan enteros', () => {
    const a = 'https://chat.imporfactory.app/uploads/webhook_whatsapp/recibidos/audios/1516786623553726.ogg';
    const v = 'https://chat.imporfactory.app/uploads/webhook_whatsapp/recibidos/videos/1565733068581714.mp4';
    expect(urlDeArchivo(a)).toBe(a);
    expect(urlDeArchivo(v)).toBe(v);
  });
});
