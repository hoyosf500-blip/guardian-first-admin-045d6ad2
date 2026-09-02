import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * PRUEBA GUARDIANA — a qué canal le habla cada tienda.
 *
 * Ecuador atiende por ImporChat y las dos de Colombia por Chatea Pro. Las
 * pantallas son las mismas; lo único que cambia es la edge function.
 *
 * Lo que se está protegiendo, en orden de cuánto costaría:
 *
 *  1. **Que el mensaje salga por el canal equivocado.** Mandar el chat de un
 *     cliente colombiano a la función de ImporChat no da un error limpio: da
 *     "esta tienda no tiene ImporChat configurado" sobre una conversación que
 *     sí existe, y la asesora concluye que el CRM está roto.
 *  2. **Que la consulta de `stores` de StoreContext crezca.** Esa consulta
 *     sostiene la app entera: si le agregan `canal_chat` y la migración no se
 *     aplicó, el SELECT muere con «column does not exist» y NADIE entra. Es el
 *     accidente que CLAUDE.md documenta con `ORDER_COLUMNS`.
 *  3. **Que se pierda alguna de las tres reglas del envío** (ventana de 24 h,
 *     verificar que salió, dejar autor). Se escribieron para ImporChat después
 *     de que un mensaje "enviado" nunca llegara; el canal nuevo nace con ellas.
 */

const raiz = process.cwd();
const leer = (p: string) => readFileSync(join(raiz, p), 'utf8');
/** Quita comentarios de línea sin confundir el `//` de `https://`. */
const sinComentarios = (t: string) =>
  t.replace(/(?<!:)\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const canal = sinComentarios(leer('src/lib/canalChat.ts'));
const conversacion = sinComentarios(leer('src/hooks/useConversacion.ts'));
const enviar = sinComentarios(leer('src/hooks/useEnviarWhatsapp.ts'));
const plantillas = sinComentarios(leer('src/hooks/usePlantillasMeta.ts'));
const storeCtx = sinComentarios(leer('src/contexts/StoreContext.tsx'));

const cpChat = sinComentarios(leer('supabase/functions/chateapro-chat/index.ts'));
const cpSend = sinComentarios(leer('supabase/functions/chateapro-send/index.ts'));
const cpPlant = sinComentarios(leer('supabase/functions/chateapro-plantillas/index.ts'));
const cpApi = sinComentarios(leer('supabase/functions/_shared/chateaproApi.ts'));

describe('canal de chat por tienda', () => {
  it('ningún hook vuelve a clavar el nombre de la función de ImporChat', () => {
    for (const [nombre, src] of [
      ['useConversacion', conversacion],
      ['useEnviarWhatsapp', enviar],
      ['usePlantillasMeta', plantillas],
    ] as const) {
      expect(
        /invoke\(\s*'importchat-/.test(src),
        `${nombre} llama a ImporChat de forma fija: la asesora de Colombia queda sin canal`,
      ).toBe(false);
      expect(
        /fnCanal\(/.test(src),
        `${nombre} debe resolver el canal con fnCanal antes de invocar`,
      ).toBe(true);
    }
  });

  it('resolver el canal NUNCA lanza ni deja a la tienda sin canal', () => {
    expect(/catch/.test(canal), 'sin catch, una columna que falta apaga el botón de escribir').toBe(true);
    expect(/country_code/.test(canal), 'debe haber respaldo por país si no está la columna').toBe(true);
  });

  it('la consulta de stores de StoreContext no se toca', () => {
    const sel = storeCtx.match(/from\('stores'\)\s*\.select\('([^']*)'\)/);
    expect(sel, 'no se encontró el SELECT de stores').not.toBeNull();
    expect(
      /canal_chat/.test(sel![1]),
      'si esa columna entra acá y la migración no está aplicada, el SELECT muere y NADIE puede entrar a la app',
    ).toBe(false);
  });
});

describe('las funciones de Chatea Pro nacen con las reglas puestas', () => {
  const funcs = [
    ['chateapro-chat', cpChat],
    ['chateapro-send', cpSend],
    ['chateapro-plantillas', cpPlant],
  ] as const;

  it('todas exigen ser miembro de la tienda', () => {
    for (const [nombre, src] of funcs) {
      expect(/store_members/.test(src), `${nombre} no valida la membresía de la tienda`).toBe(true);
      expect(/auth\.getUser/.test(src), `${nombre} no valida el usuario`).toBe(true);
    }
  });

  it('todas pueden decir qué versión están corriendo', () => {
    for (const [nombre, src] of funcs) {
      expect(
        /respuestaPing\(req, VERSION/.test(src),
        `${nombre} sin ping: Lovable no redespliega edge functions y no habría forma de saber cuál está viva`,
      ).toBe(true);
    }
  });

  it('todas revisan la credencial ANTES de tocar el pedido', () => {
    for (const [nombre, src] of funcs) {
      const iCfg = src.indexOf('cargarConfigChateapro');
      expect(iCfg, `${nombre} no carga la config de Chatea Pro`).toBeGreaterThan(-1);
      const iPedido = src.indexOf("from(\"orders\")");
      if (iPedido > -1) {
        expect(
          iCfg < iPedido,
          `${nombre}: al revés, una tienda sin Chatea Pro recibe un mensaje que promete algo que nunca va a pasar`,
        ).toBe(true);
      }
      expect(/sin_config: true/.test(src), `${nombre} debe responder sin_config`).toBe(true);
    }
  });

  it('escribir respeta las 24 h y verifica que el mensaje salió', () => {
    expect(
      /ventanaWhatsapp\(/.test(cpSend),
      'sin la ventana, el mensaje no se entrega y la asesora queda convencida de que avisó',
    ).toBe(true);
    expect(/ventana_vencida: true/.test(cpSend)).toBe(true);
    expect(
      /apareceEnHilo\(/.test(cpSend),
      'hay que releer el hilo y confirmar: un "listo" sin confirmar es peor que un error',
    ).toBe(true);
  });

  it('el cruce por teléfono confirma los últimos 9 dígitos', () => {
    expect(
      /last9\(s\.phone\) === clave/.test(cpApi),
      'un match flojo por teléfono le muestra a la asesora la conversación de OTRO cliente',
    ).toBe(true);
  });

  it('la plantilla no se manda con huecos vacíos y suelta el candado si falla', () => {
    expect(/faltantes\(/.test(cpPlant)).toBe(true);
    expect(
      /importchat_envios"\)\s*\.delete\(\)/.test(cpPlant) || /\.delete\(\)/.test(cpPlant),
      'si el envío falla y el candado queda puesto, el reintento choca con "ya se mandó hoy" sobre un mensaje que nunca salió',
    ).toBe(true);
    expect(/ya_enviado: true/.test(cpPlant)).toBe(true);
  });

  it('se reusa el parser de plantillas, no se escribe un segundo', () => {
    expect(
      /parsearPlantillas/.test(cpPlant),
      'dos definiciones del mismo hecho es la trampa que este repo ya pagó',
    ).toBe(true);
  });

  it('la API key nunca baja al navegador', () => {
    const mig = leer('supabase/migrations/20260902180000_chateapro_canal_por_tienda.sql');
    expect(/REVOKE ALL ON TABLE public\.store_chateapro_config/.test(mig)).toBe(true);
    expect(
      /store_chateapro_config/.test(canal + conversacion + enviar + plantillas),
      'ningún archivo del cliente puede leer la tabla de credenciales',
    ).toBe(false);
  });
});

/**
 * Lo que la API de Chatea Pro devuelve DE VERDAD.
 *
 * ⛔ Medido el 2-sep-2026 contra la cuenta real, después de escribir el cliente
 * leyendo la especificación. Tres de mis suposiciones estaban mal, y las tres
 * fallaban EN SILENCIO: el hilo salía con todos los mensajes en blanco y el
 * cruce por teléfono no encontraba a nadie. Estos casos existen para que nadie
 * "limpie" estos nombres de campo pensando que son arbitrarios.
 */
describe('los campos que Chatea Pro devuelve de verdad', () => {
  it('el texto del mensaje sale de `content`, no de `text`', () => {
    expect(/m\.content/.test(cpApi)).toBe(true);
    expect(
      /m\.text|m\.message/.test(cpApi),
      '`text`/`message` NO existen en la respuesta: con ellos el hilo sale vacío',
    ).toBe(false);
  });

  it('la fecha sale de `ts` (unix en segundos)', () => {
    expect(/m\.ts/.test(cpApi)).toBe(true);
    expect(/m\.timestamp/.test(cpApi), '`timestamp` no existe; el campo es `ts`').toBe(false);
  });

  it('el adjunto sale de `payload.url`', () => {
    expect(/payload\?\.url/.test(cpApi)).toBe(true);
    expect(/m\.file_url/.test(cpApi), '`file_url` no existe; la URL vive en `payload`').toBe(false);
  });

  it('una nota interna NO se pinta como mensaje al cliente', () => {
    expect(
      /"note"/.test(cpApi) && /"sistema"/.test(cpApi),
      'type "note" es una nota del equipo: mostrarla como mensaje hace creer que al cliente se le dijo algo que nunca se le dijo',
    ).toBe(true);
  });

  it('el nombre de una plantilla no se muestra como si fuera el mensaje', () => {
    expect(
      /esPlantilla/.test(cpApi),
      'en un wa_template, `content` es el NOMBRE de la plantilla, no lo que leyó el cliente',
    ).toBe(true);
  });

  it('el cruce por teléfono prueba el formato NACIONAL', () => {
    expect(
      /slice\(-10\)/.test(cpApi),
      'la búsqueda de Chatea Pro no es por subcadena: +57… y los últimos 9 dan CERO resultados; el que funciona es el de 10 dígitos',
    ).toBe(true);
  });

  it('la plantilla se manda con los botones que ya tenía', () => {
    expect(
      /default_values\?\.params/.test(cpPlant),
      'sin los QUICK_REPLY del panel, la plantilla sale con los botones rotos — y "CONFIRMAR PEDIDO" es la señal que más predice una cancelación',
    ).toBe(true);
  });
});

/**
 * Ninguna pantalla puede nombrar un canal que esa tienda NO usa.
 *
 * ⛔ Visto en producción el 2-sep-2026 con una tienda de Colombia abierta: el
 * encabezado decía «ImporChat sin correr» y el cuadro de escribir, «este pedido
 * no tiene conversación en ImporChat». ImporChat es el canal de ECUADOR. A la
 * asesora colombiana se la mandaba a la app de otro país, a buscar un chat que
 * ahí no existe.
 */
describe('ninguna pantalla nombra el canal del otro país', () => {
  const dialogo = sinComentarios(leer('src/components/seguimiento/EscribirWhatsappDialog.tsx'));
  const badge = sinComentarios(leer('src/components/chat/ImporchatSyncBadge.tsx'));
  const motivos = sinComentarios(leer('supabase/functions/_shared/plantillasMeta.ts'));

  it('el cuadro de escribir nombra el canal de la tienda, no uno fijo', () => {
    expect(/nombreCanal\(/.test(dialogo), 'debe usar nombreCanal(canalChat)').toBe(true);
    expect(
      /ImporChat/.test(dialogo),
      'el texto visible no puede clavar "ImporChat": en Colombia es Chatea Pro',
    ).toBe(false);
  });

  it('el badge de ImporChat no se dibuja en tiendas que no lo usan', () => {
    expect(
      /canal !== 'importchat'/.test(badge),
      'sin el guard, Colombia ve una alarma de un sync que no le corresponde',
    ).toBe(true);
    // El guard va DESPUÉS de los hooks: un return antes tumba la pantalla.
    const iHooks = badge.lastIndexOf('useMinuteTick()');
    const iGuard = badge.indexOf("canal !== 'importchat'");
    expect(
      iHooks < iGuard,
      'un early-return arriba de los hooks rompe el orden de hooks (React #300/#308)',
    ).toBe(true);
  });

  /**
   * ⛔ Verificado EN PRODUCCIÓN el 2-sep-2026, con Rushmira (Colombia) abierta
   * y el pedido 87992083 de PATRICIA MURILLO: mientras cargaba, el hilo decía
   * «Leyendo la conversación en ImporChat…». ImporChat es la app de ECUADOR.
   *
   * Los tres archivos de acá son los que la asesora colombiana tiene delante
   * todo el turno: el hilo, el `title` de la rayita de actividad del tablero y
   * la bandeja de "Escribieron". Ninguno puede escribir el nombre de un canal a
   * mano — se pregunta con `nombreCanal(useCanalChat())`.
   */
  it('el hilo, el tablero y la bandeja preguntan el canal en vez de clavarlo', () => {
    const pantallas: [string, string][] = [
      ['el hilo de la conversación', 'src/components/seguimiento/ConversacionChat.tsx'],
      ['el tablero de Seguimiento', 'src/components/seguimiento/SegBoard.tsx'],
      ['la bandeja de Escribieron', 'src/pages/InboxPage.tsx'],
    ];
    for (const [que, ruta] of pantallas) {
      const src = sinComentarios(leer(ruta));
      expect(/nombreCanal\(/.test(src), `${que} debe usar nombreCanal(useCanalChat())`).toBe(true);
      expect(
        /ImporChat/.test(src),
        `${que} clava "ImporChat" en un texto visible: en Colombia el canal es Chatea Pro`,
      ).toBe(false);
    }
  });

  it('el motivo de una plantilla bloqueada no nombra un canal', () => {
    expect(/panel de chat/.test(motivos)).toBe(true);
    expect(
      /ImporChat/.test(motivos),
      'esta función ahora sirve a los dos países: el motivo no puede nombrar el canal de uno',
    ).toBe(false);
  });
});

/**
 * La nota de voz se escucha Y se lee.
 *
 * Medido sobre 18 conversaciones reales de Ecuador: 14 traían audio — el
 * cliente responde hablando mucho más de lo que escribe. Chatea Pro transcribe
 * solo (`payload.transcribed_text`), así que la transcripción es gratis y no
 * hay excusa para que la asesora tenga que escuchar audio por audio.
 */
describe('audio, foto y video del cliente', () => {
  const chat = sinComentarios(leer('src/components/seguimiento/ConversacionChat.tsx'));

  it('la transcripción del audio viaja desde Chatea Pro', () => {
    expect(/transcribed_text/.test(cpApi), 'el campo real se llama payload.transcribed_text').toBe(true);
    expect(/transcripcion/.test(cpApi)).toBe(true);
  });

  it('la transcripción se pinta debajo del reproductor', () => {
    expect(/transcripcion/.test(chat)).toBe(true);
    const i = chat.indexOf('<audio');
    const j = chat.indexOf('transcripcion &&');
    expect(i > -1 && j > i, 'la transcripción va DESPUÉS del audio, no en vez de él').toBe(true);
  });

  it('el video se ve en el hilo, no como "abrir archivo"', () => {
    expect(/<video/.test(chat), 'abrir una pestaña por mensaje no es trabajar una cola').toBe(true);
  });

  it('nunca se inventa un texto cuando no hay transcripción', () => {
    expect(
      /transcripcion &&/.test(chat),
      'sin transcripción queda solo el reproductor: un texto inventado sobre lo que dijo un cliente es peor que nada',
    ).toBe(true);
  });
});

/**
 * ¿Lo escribió el bot o una persona?
 *
 * Es la pregunta con la que empezó todo el módulo de chat. Medido con un envío
 * REAL el 2-sep-2026: cuando escribe una persona, Chatea Pro devuelve
 * `type:"agent"`, `agent_id:<id>`, `username:"Fabián"` **y `sender_id:"bot"`**.
 * Preguntar primero por `sender_id` firma todo como "Bot" y borra el nombre de
 * la asesora.
 */
describe('el autor del mensaje y el cuerpo de la plantilla', () => {
  it('una persona gana sobre el "bot" del sender_id', () => {
    const i = cpApi.indexOf('m.agent_id ?? 0) > 0');
    const j = cpApi.indexOf('m.sender_id === "bot"');
    expect(i > -1 && j > -1, 'no se encontró el cálculo del autor').toBe(true);
    expect(
      i < j,
      'preguntar por sender_id primero borra el nombre de quien escribió: todo sale firmado "Bot"',
    ).toBe(true);
  });

  it('la plantilla muestra lo que el cliente LEYÓ, no el nombre del archivo', () => {
    expect(
      /payload\?\.body/.test(cpApi),
      '`content` en un wa_template es un código; `payload.body` es el mensaje armado',
    ).toBe(true);
  });
});

/**
 * La plantilla al cliente que NUNCA escribió.
 *
 * ⛔ Probado con un envío real el 2-sep-2026: `send-whatsapp-template` exige un
 * contacto que ya existe. Un cliente que compró y jamás escribió por WhatsApp
 * NO es contacto — y son justo los que hay que rescatar (el pedido de la prueba
 * llevaba 12 días sin retirar en oficina, con la devolución casi segura).
 */
describe('alcanzar al cliente que nunca escribió', () => {
  it('hay un camino por teléfono que crea el contacto', () => {
    expect(/enviarPlantillaPorTelefono/.test(cpPlant)).toBe(true);
    expect(/create_if_not_found/.test(cpApi)).toBe(true);
  });

  it('el camino por teléfono es el RESPALDO, no el principal', () => {
    // Con contacto existente se manda por user_ns: así el mensaje queda en el
    // hilo de siempre y no abre una conversación paralela.
    expect(/if \(sus\) \{/.test(cpPlant)).toBe(true);
  });

  it('el buscador prueba también la forma internacional', () => {
    expect(
      /"\+" \+ conIndicativo/.test(cpApi),
      'un contacto creado por la API queda como +57XXXXXXXXXX: sin esa forma, el chat recién abierto sale como "nunca escribió"',
    ).toBe(true);
  });
});
