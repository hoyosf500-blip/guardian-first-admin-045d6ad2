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
const cpSync = sinComentarios(leer('supabase/functions/chateapro-sync/index.ts'));

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

  /**
   * El badge de salud del sync vigila EL SYNC DE SU TIENDA.
   *
   * Primero decía «ImporChat sin correr» en Colombia —la alarma de la app de
   * otro país— y se lo escondió ahí. Esconderlo resultó peor: si el sync de
   * Colombia se cuelga, la bandeja «Escribieron» se queda quieta y la pantalla
   * se ve tan tranquila como si de verdad no hubiera nadie esperando. Ese
   * silencio es justo lo que dejó 39 clientes sin contestar (22 por más de un
   * día), medido el 2-sep-2026. Ahora se dibuja en las dos, con el nombre y el
   * `source` que corresponden.
   */
  it('el badge mira el sync de SU canal, no uno fijo', () => {
    expect(/nombreCanal\(/.test(badge), 'el texto visible debe salir de nombreCanal()').toBe(true);
    expect(
      /'chateapro-sync'/.test(badge) && /'importchat-sync'/.test(badge),
      'tiene que elegir el source por canal: en Colombia vigila chateapro-sync',
    ).toBe(true);
    expect(
      /ImporChat/.test(badge),
      'ningún texto del badge puede clavar el nombre de un canal',
    ).toBe(false);
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


/**
 * El sync que hace que la bandeja «Escribieron» funcione en Colombia.
 *
 * Nació de una medición, no de una idea: el 2-sep-2026 había 39 clientes que
 * habían escrito y nadie contestó —22 hacía más de un día, el más viejo 97 h—
 * y Guardian mostraba «todos los que escribieron ya fueron atendidos 🎉».
 * Colombia tenía 0 de 589 pedidos con `chat_entrante_at`; Ecuador, 2.196 de
 * 3.426. Lo que faltaba era exactamente este cron.
 */
describe('chateapro-sync: escribe poco y deja rastro', () => {
  it('dice qué versión está corriendo', () => {
    expect(/respuestaPing\(/.test(cpSync)).toBe(true);
    expect(/const VERSION = "chateapro-sync /.test(cpSync)).toBe(true);
  });

  it('⛔ NO pasa por upsert_orders_from_dropi (REGLA #1)', () => {
    // Esa función es la que mezcló Ecuador con Colombia durante 2h30. Un sync
    // de chat no tiene por qué tocarla.
    expect(/upsert_orders_from_dropi/.test(cpSync)).toBe(false);
  });

  it('solo escribe columnas de chat: nada de estado, valor ni guía', () => {
    const update = cpSync.slice(cpSync.indexOf('.from("orders").update('));
    const cuerpo = update.slice(0, update.indexOf('.eq("store_id"'));
    for (const prohibida of ['estado:', 'valor:', 'guia:', 'transportadora:', 'nombre:']) {
      expect(cuerpo.includes(prohibida), `el sync de chat no manda sobre ${prohibida}`).toBe(false);
    }
    expect(/chat_entrante_at|chat_saliente_at/.test(cuerpo)).toBe(true);
  });

  it('el UPDATE va dirigido por (store_id, external_id)', () => {
    // `external_id` es único POR TIENDA desde la migración de agosto: sin el
    // store_id al lado, un mismo número de pedido pisa la fila de otro país.
    expect(/\.eq\("store_id", sid\)\.eq\("external_id"/.test(cpSync)).toBe(true);
  });

  it('deja rastro en sync_logs aunque la plataforma lo mate', () => {
    expect(/from\("sync_logs"\)/.test(cpSync)).toBe(true);
    expect(/"running"/.test(cpSync), 'abre la fila al arrancar para que un cuelgue deje señal').toBe(true);
    expect(/SOURCE = "chateapro-sync"/.test(cpSync)).toBe(true);
  });

  it('una tienda que falla no deja a las demás sin sincronizar', () => {
    expect(/continue;/.test(cpSync)).toBe(true);
    expect(/huboError/.test(cpSync), 'y la corrida no puede cerrar en success tapando el fallo').toBe(true);
  });

  it('respeta un presupuesto de reloj para poder cerrar el log', () => {
    expect(/BUDGET_MS/.test(cpSync)).toBe(true);
  });

  it('la página de contactos no pasa de 100 (la API devuelve 400)', () => {
    expect(/const PAGINA = 100;/.test(cpSync)).toBe(true);
    expect(/Math\.min\(100/.test(cpApi), 'listarSuscriptores tiene que topearlo también').toBe(true);
  });
});

/**
 * ⛔ Un cero que nadie midió NO es una buena noticia.
 *
 * La bandeja decía «Nadie esperando respuesta — todos los que escribieron ya
 * fueron atendidos 🎉» sobre una tienda donde NINGÚN pedido tenía dato de chat.
 * Es la misma familia de error que el estado vacío que no mira `loading`.
 */
describe('la bandeja no puede afirmar un cero sobre datos que no existen', () => {
  const hook = sinComentarios(leer('src/hooks/useInboxEsperando.ts'));
  const pagina = sinComentarios(leer('src/pages/InboxPage.tsx'));

  it('sin una sola fila con dato de chat, el estado es `sin_medir`, no `ok`', () => {
    expect(/'sin_medir'/.test(hook)).toBe(true);
    expect(
      /filas\.length === 0 \? 'sin_medir' : 'ok'/.test(hook),
      'el `ok` final tiene que depender de que haya llegado alguna fila',
    ).toBe(true);
  });

  it('y la pantalla lo dice en vez de celebrar', () => {
    expect(/status === 'sin_medir'/.test(pagina)).toBe(true);
    const i = pagina.indexOf("status === 'sin_medir'");
    const bloque = pagina.slice(i, i + 700);
    expect(/No quiere decir que no haya nadie/.test(bloque)).toBe(true);
    expect(/🎉/.test(bloque), 'el estado sin medir no puede felicitar a nadie').toBe(false);
  });
});


/**
 * La señal del botón CONFIRMAR PEDIDO, ahora también en Colombia.
 *
 * Separa 10,4% de cancelación contra 57,7% (Ecuador, 765 pedidos resueltos de
 * agosto-2026). Su modo de falla es SILENCIOSO: entre el 27 y el 29 de agosto
 * se cambió la plantilla en el panel, el botón pasó a decir otra cosa, y la
 * señal cayó de 58% a 0% sin un solo error en ningún log — con la asesora dos
 * días llamando a gente que ya había confirmado. Todo lo de acá defiende ese
 * flanco.
 */
describe('la señal de confirmación no puede quedarse ciega en silencio', () => {
  const senal = sinComentarios(leer('supabase/functions/_shared/chateaproSenal.ts'));

  it('las plantillas que confirman se DESCUBREN, no se escriben a mano', () => {
    expect(/export function plantillasQueConfirman/.test(senal)).toBe(true);
    expect(/listarPlantillas/.test(cpSync), 'el sync tiene que preguntarlas cada corrida').toBe(true);
    // Lo que importa NO es que estén en la misma línea, sino que lo que se le
    // pasa a `plantillasQueConfirman` salga de la lista VIVA de la cuenta. Se
    // comprueba que la lista se pida y que ese resultado —y no otra cosa— sea
    // lo que se clasifica: una lista fija de nombres es exactamente lo que
    // apagó la señal en agosto.
    const dePlantillasVivas = /const (\w+) = await listarPlantillas\([^)]*\);[\s\S]{0,400}?plantillasQueConfirman\(\1\)/.test(cpSync)
      || /plantillasQueConfirman\(await listarPlantillas/.test(cpSync);
    expect(dePlantillasVivas, 'las confirmadoras tienen que salir de `listarPlantillas`, no de un literal').toBe(true);
  });

  /**
   * ⛔ La alarma de "botón que no sé leer" tiene que seguir significando algo.
   *
   * Nació para agarrar el modo de falla de agosto (una plantilla nueva y nadie
   * se entera). Pero la lista de botones conocidos estaba escrita a mano con
   * tres textos, y la cuenta de Colombia declara además "Coordinar entrega" —
   * el botón de las tres plantillas de novedad. Cada cliente que hacía lo
   * normal dejaba la corrida en `warn`. Una alarma que suena todos los días no
   * la mira nadie, y entonces tampoco suena el día que importa.
   */
  it('los botones conocidos también se DESCUBREN de las plantillas de la cuenta', () => {
    expect(/export function botonesDeclarados/.test(senal)).toBe(true);
    expect(
      /senalDeHilo\([^)]*declarados/.test(cpSync),
      'el sync tiene que pasarle los botones declarados, o la alarma vuelve a sonar por «Coordinar entrega»',
    ).toBe(true);
  });

  it('reusa `esBotonConfirmar` y `clasificar`, no una segunda copia', () => {
    // Dos definiciones del mismo hecho es la trampa que este repo ya pagó
    // varias veces. La escalera de riesgo vive en senalConfirmacion.ts.
    expect(/from "\.\/senalConfirmacion\.ts"/.test(senal)).toBe(true);
    expect(/esBotonConfirmar/.test(senal) && /clasificar/.test(senal)).toBe(true);
  });

  it('⛔ traduce `postback` a `button`', () => {
    // En Chatea Pro apretar un botón llega como `postback`. Sin la traducción,
    // esBotonConfirmar da false para TODOS y la señal queda en cero sin error.
    expect(/postback["'] \? ["']button/.test(senal)).toBe(true);
  });

  it('un botón que no sabemos leer se reporta en sync_logs', () => {
    expect(/botonesDesconocidos/.test(senal)).toBe(true);
    expect(/BOTONES QUE NO S/.test(cpSync), 'tiene que salir al log de la corrida, no solo a la consola').toBe(true);
    expect(/huboError = true/.test(cpSync)).toBe(true);
  });

  it('si NINGUNA plantilla ofrece el botón, la corrida lo grita', () => {
    // Cero plantillas confirmadoras = la señal daría 0% para todo el mundo.
    // Eso es indistinguible de "nadie confirma" si no se avisa.
    expect(/confirmadoras\.size === 0/.test(cpSync)).toBe(true);
  });

  it('leer hilos tiene tope y reserva de tiempo', () => {
    // La pregunta no es "¿queda algo de tiempo?" sino "¿queda suficiente?".
    expect(/RESERVA_HILOS_MS/.test(cpSync)).toBe(true);
    expect(/HILOS_POR_CORRIDA/.test(cpSync)).toBe(true);
    expect(/BUDGET_MS - RESERVA_HILOS_MS/.test(cpSync)).toBe(true);
  });

  /**
   * ⛔ Los pedidos de HOY primero. La primera versión los dejaba últimos.
   *
   * Estaba `fecha ascending`, copiando la idea de "reanudable" del sync de
   * Ecuador. Verificado en producción el 2-sep-2026: la corrida escribió 30
   * señales y los DOS pedidos que se habían medido a mano —88110734 CANDIDA
   * VILORIA, que apretó el botón, y 88111168 DEYANIR BARRERA, que no— quedaron
   * los dos en `null`. Son de hoy, y con más de 30 pedidos en la ventana los de
   * hoy nunca llegaban al cupo. Justo los que importan: la mediana del apretón
   * es 0,0 h y esta señal existe para ordenar la cola de Confirmar de HOY.
   */
  it('⛔ los pedidos de HOY se miran primero, no últimos', () => {
    expect(
      /ascending: true/.test(cpSync),
      'ordenar por el más viejo deja los pedidos de hoy fuera del cupo para siempre',
    ).toBe(false);
    expect(/\.is\("chat_riesgo", null\)/.test(cpSync), 'primero los que no tienen señal').toBe(true);
    expect(/ascending: false/.test(cpSync)).toBe(true);
  });

  it('los que ya tienen señal se refrescan, salvo los confirmados', () => {
    // Alguien puede apretar el botón dos horas después; sin refresco quedaría
    // marcado "mudo" para siempre. Y `confirmado` no se deshace: releerlo
    // gastaría el cupo que necesitan los que todavía no.
    expect(/neq\("chat_riesgo", "confirmado"\)/.test(cpSync)).toBe(true);
  });

  it('se reporta a cuántos se les llegó a OFRECER el botón', () => {
    // La tasa que hace valiosa la señal (10% vs 58%) se midió sobre pedidos que
    // SÍ recibieron la plantilla. Si en esta tienda casi nadie la recibe, la
    // mayoría de los "tibio" no significan "no confirmó" sino "nunca se le
    // preguntó" — y eso tiene que verse en el log.
    expect(/recibieron_plantilla_confirmacion/.test(cpSync)).toBe(true);
  });

  it('un pedido sin contacto NO se marca como "no confirmó"', () => {
    // No poder mirar no es haber mirado. Si no hay suscriptor, se salta y el
    // pedido queda sin señal (sin_dato), nunca clasificado por omisión.
    expect(/if \(!sus\) continue;/.test(cpSync)).toBe(true);
  });

  it('un hilo que no se pudo leer es `sin_dato`', () => {
    expect(/if \(!hilo\)/.test(senal) && /"sin_dato"/.test(senal)).toBe(true);
  });
});
