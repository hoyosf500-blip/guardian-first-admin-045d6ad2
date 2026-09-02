import type { PlantillaMeta } from './plantillasMeta';

/**
 * Las plantillas OPERATIVAS reales de la cuenta de Colombia (Chatea Pro,
 * workspace 225189), leídas el 2-sep-2026 con `POST /whatsapp-template/list`
 * y pasadas por `parsearPlantillas`, igual que en producción.
 *
 * ── Por qué hace falta una copia real, y no ejemplos ────────────────────────
 * Todo lo que rompía en Colombia sale de detalles que nadie inventaría a mano:
 *
 *   - **Chatea Pro no manda los `example` de Meta.** Los que llegan son
 *     literalmente `"w"` y `"qw"`. La cadena de `sugerirValores` termina en "el
 *     ejemplo que guardó Meta", y acá ese último recurso no existe.
 *   - **Las plantillas hablan en prosa, no con etiquetas.** "tu envío con guía
 *     {{2}}", "oficina de {{3}}", "a la dirección {{3}}". `etiquetaDe` exige
 *     dos puntos y no encontraba ninguno.
 *   - **`novedad_reclamo_oficina_1_utilidad` se llama "oficina" y NO es de
 *     oficina**: dice "se registra una novedad". Ganaba el patrón genérico de
 *     la fase `oficina`, no se podía completar, y el botón se apagaba entero.
 *   - **Las tres de guía traen un botón URL con hueco**
 *     (`cloudfront.net/{{1}}`), así que `parsearPlantillas` las bloquea. Esa
 *     fase no tiene con qué en Colombia, y eso es un hecho de la cuenta, no un
 *     bug del código.
 *
 * ── Qué NO está acá ─────────────────────────────────────────────────────────
 * Las 6 de marketing puro (carritos, remarketing) no matchean ningún patrón de
 * `ACCION_POR_FASE`, así que no cambian nada de lo que este fixture prueba.
 */
export const PLANTILLAS_CO: readonly PlantillaMeta[] = [
  {
    nombre: "confirmacion_con_imagen_1_utilidad", categoria: "UTILITY", idioma: "es",
    botones: ["CONFIRMAR PEDIDO","Modificar Datos"], noSoportada: "Lleva una imagen adjunto. Esta hay que mandarla desde el panel de chat.",
    cuerpo: "Hola, {{1}}\n\nQueremos confirmar los detalles de tu pedido y la dirección en donde sera entregado:\n\nProducto: {{2}}\nValor: ${{3}}\nDirección: {{4}}\n\nSi toda la información es correcta, pulsa en Confirmar Pedido para continuar con el\nenvío",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"q"},{"indice":2,"etiqueta":"Producto","ejemplo":"q"},{"indice":3,"etiqueta":null,"ejemplo":"q"},{"indice":4,"etiqueta":"Dirección","ejemplo":"q"}],
  },
  {
    nombre: "confirmacion_con_imagen_v2", categoria: "UTILITY", idioma: "es",
    botones: ["CONFIRMAR PEDIDO","Modificar Datos"], noSoportada: "Lleva una imagen adjunto. Esta hay que mandarla desde el panel de chat.",
    cuerpo: "Hola, {{1}}\n\nQueremos confirmar los detalles de tu pedido y la dirección en donde sera entregado:\n✔️ Producto: {{2}}\n✔️ Valor: ${{3}}\n📍 Dirección: {{4}}\n\nSi toda la información es correcta, pulsa en Confirmar Pedido para continuar con el envío 👇🏼",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"q"},{"indice":2,"etiqueta":"Producto","ejemplo":"q"},{"indice":3,"etiqueta":null,"ejemplo":"qq"},{"indice":4,"etiqueta":"Dirección","ejemplo":"q"}],
  },
  {
    nombre: "confirmacion_recordatorio_1_v2_utilidad", categoria: "UTILITY", idioma: "es",
    botones: ["CONFIRMAR PEDIDO","Modificar Datos"], noSoportada: null,
    cuerpo: "Hola {{1}}, tu pedido se encuentra actualmente en bodega. Requerimos tu validación final de los datos para autorizar la salida y asegurar la entrega a tiempo.\n\nProducto: {{2}}\nValor: ${{3}}\nDirección: {{4}}\n\nEl proceso continuará con base en la información actualmente registrada.\n\nSi necesitas revisar o actualizar los datos, puedes hacerlo desde este mensaje.",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"q"},{"indice":2,"etiqueta":"Producto","ejemplo":"q"},{"indice":3,"etiqueta":null,"ejemplo":"q"},{"indice":4,"etiqueta":"Dirección","ejemplo":"q"}],
  },
  {
    nombre: "confirmacion_recordatorio_2_v2_utilidad", categoria: "UTILITY", idioma: "es",
    botones: ["CONFIRMAR PEDIDO","Modificar Datos"], noSoportada: null,
    cuerpo: "Hola {{1}}. Tu pedido continúa registrado en el sistema con la siguiente información:\n\nProducto: {{2}}\nValor: ${{3}}\nDirección: {{4}}\n\nMientras no se realicen modificaciones, el pedido permanecerá con estos datos.\n\nSi deseas validar o actualizar la información, puedes comunicarte por este medio.",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"q"},{"indice":2,"etiqueta":"Producto","ejemplo":"q"},{"indice":3,"etiqueta":null,"ejemplo":"q"},{"indice":4,"etiqueta":"Dirección","ejemplo":"q"}],
  },
  {
    nombre: "confirmacion_sin_imagen_v2", categoria: "UTILITY", idioma: "es",
    botones: ["CONFIRMAR PEDIDO","Modificar Datos"], noSoportada: null,
    cuerpo: "Hola, {{1}}\n\nQueremos confirmar los detalles de tu pedido y la dirección en donde sera entregado:\n✔️ Producto: {{2}}\n✔️ Valor: ${{3}}\n📍 Dirección: {{4}}\n\nSi toda la información es correcta, pulsa en Confirmar Pedido para continuar con el envío 👇🏼",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"q"},{"indice":2,"etiqueta":"Producto","ejemplo":"q"},{"indice":3,"etiqueta":null,"ejemplo":"q"},{"indice":4,"etiqueta":"Dirección","ejemplo":"q"}],
  },
  {
    nombre: "confirmacion_sin_imagen_v2_utilidad", categoria: "UTILITY", idioma: "es",
    botones: ["CONFIRMAR PEDIDO","Modificar Datos"], noSoportada: null,
    cuerpo: "Hola, {{1}}.\n\nQueremos confirmar los detalles de tu pedido y la dirección en donde sera entregado:\n\nProducto: {{2}}\nValor: ${{3}}\nDirección: {{4}}\n\nA continuación encontrarás opciones disponibles para revisar o actualizar la información.",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"q"},{"indice":2,"etiqueta":"Producto","ejemplo":"q"},{"indice":3,"etiqueta":null,"ejemplo":"q"},{"indice":4,"etiqueta":"Dirección","ejemplo":"q"}],
  },
  {
    nombre: "confirmaciones_recordatorio_1_v2", categoria: "UTILITY", idioma: "es",
    botones: ["CONFIRMAR PEDIDO","Modificar Datos"], noSoportada: null,
    cuerpo: "Estimado/a {{1}},\n\nTu pedido aún se encuentra en bodega 🏬\n\n🚚 Estamos listos para enviártelo, pero necesitamos tu confirmación para asegurarnos de que llegue a tiempo.\n\nPor favor, haz clic en el botón Confirmar Pedido para que podamos despachar tu producto: {{2}} 😊📦",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"q"},{"indice":2,"etiqueta":"o para que podamos despachar tu producto","ejemplo":"q"}],
  },
  {
    nombre: "confirmaciones_recordatorio_2_v2", categoria: "MARKETING", idioma: "es",
    botones: ["CONFIRMAR PEDIDO","Modificar Datos"], noSoportada: null,
    cuerpo: "Hey {{1}}!\n\nAún no hemos recibido tu confirmación de envío 😢\n\nRecuerda que solo podremos despachar tu pedido si verificas tus datos.\n\n🚨 Actualmente quedan solo {{2}} unidades disponibles, por lo que estamos dando prioridad a los pedidos confirmados.\n\nPara asegurarte de recibir tu producto, haz clic en el botón Confirmar Pedido 👇🏻",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"q"},{"indice":2,"etiqueta":null,"ejemplo":"q"}],
  },
  {
    nombre: "interrapidisimo_bucle", categoria: "UTILITY", idioma: "es",
    botones: ["YA LE RECOGI"], noSoportada: null,
    cuerpo: "📢 Este es un mensaje automático\n\nHola {{1}}👋\n\nTu pedido ya está disponible para ser recogido en:\n\n📍 Oficina de:{{2}}\n🔢 Número de guía:{{3}}\n\n🔹 Ciudad:{{4}}\n🔹 Departamento:{{5}}\n\n📦 Producto:{{6}}\n💰 Valor a pagar:{{7}}\n\nEs importante que lo reclames pronto para evitar su devolución.\n\nQue tengas un excelente día",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"Kevin"},{"indice":2,"etiqueta":"Oficina de","ejemplo":"calle 13#23-45"},{"indice":3,"etiqueta":"Número de guía","ejemplo":"123456789"},{"indice":4,"etiqueta":"Ciudad","ejemplo":"cali"},{"indice":5,"etiqueta":"Departamento","ejemplo":"valle"},{"indice":6,"etiqueta":"Producto","ejemplo":"pedal de carro"},{"indice":7,"etiqueta":"Valor a pagar","ejemplo":"79900"}],
  },
  {
    nombre: "novedad_general_v2_utilidad", categoria: "UTILITY", idioma: "es",
    botones: ["Coordinar entrega"], noSoportada: null,
    cuerpo: "Se ha registrado una novedad en la entrega de tu pedido con {{1}} en la dirección: {{2}}.\n\n📌 Motivo: {{3}}\n\nPara completar la gestión, se requiere validar la siguiente información: {{4}}\n\nUna vez recibidos los datos, el sistema programará la entrega de inmediato",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"qw"},{"indice":2,"etiqueta":"en la dirección","ejemplo":"q"},{"indice":3,"etiqueta":"Motivo","ejemplo":"q"},{"indice":4,"etiqueta":"equiere validar la siguiente información","ejemplo":"q"}],
  },
  {
    nombre: "novedad_generica_v2", categoria: "UTILITY", idioma: "es",
    botones: ["Coordinar entrega"], noSoportada: null,
    cuerpo: "Hola {{1}}. La transportadora {{2}} nos informó que intentó entregar tu pedido de {{3}} en la dirección {{4}} ,pero no fue posible. 🚚\n\n📌 Motivo: {{5}}\n\n👉 Para solucionarlo, indícanos: {{6}}\n\nEn cuanto tengamos tu respuesta gestionaremos la entrega de inmediato.",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"Miguel"},{"indice":2,"etiqueta":null,"ejemplo":"Envia"},{"indice":3,"etiqueta":null,"ejemplo":"1 oso de peluche"},{"indice":4,"etiqueta":null,"ejemplo":"calle 90"},{"indice":5,"etiqueta":"Motivo","ejemplo":"No se encontró nadie en casa"},{"indice":6,"etiqueta":"indícanos","ejemplo":"cuándo podemos volver a pasar de nuevo"}],
  },
  {
    nombre: "novedad_reclamo_oficina_1_utilidad", categoria: "UTILITY", idioma: "es",
    botones: ["Coordinar entrega"], noSoportada: null,
    cuerpo: "Se registra una novedad en el proceso de entrega de tu envío operado por {{1}} en\n{{2}}.\n\nNúmero de guía: {{3}}\n\nPuedes responder este chat para recibir asistencia.",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"w"},{"indice":2,"etiqueta":null,"ejemplo":"qw"},{"indice":3,"etiqueta":"Número de guía","ejemplo":"w"}],
  },
  {
    nombre: "novedad_recordatorio_v2", categoria: "UTILITY", idioma: "es",
    botones: [], noSoportada: null,
    cuerpo: "Solo queremos recordarte que tu pedido de {{1}} aún está pendiente debido a un inconveniente con la entrega. 📦\n\nEstamos aquí para ayudarte a recibir tu producto cuanto antes, así que no dudes en contactarnos si necesitas cualquier asistencia. 🙌",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"q"}],
  },
  {
    nombre: "novedad_recordatorio_v2_utilidad", categoria: "UTILITY", idioma: "es",
    botones: [], noSoportada: null,
    cuerpo: "Hola. Tu pedido {{1}} está pendiente debido a un inconveniente con la entrega.\n\nPara poder hacerte llegar el pedido lo más pronto posible, requerimos tu asistencia. *Por favor, responde a este mensaje* para resolver la incidencia y proceder con el despacho inmediato.",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"s"}],
  },
  {
    nombre: "seguimiento_en_oficina_v2", categoria: "MARKETING", idioma: "es",
    botones: [], noSoportada: null,
    cuerpo: "¡Hola!\n\nTienes un pedido pendiente para reclamar, dirígete a {{1}} ciudad {{2}}. Recuerda llevar tu cédula original y tener tu número de guía {{3}} a la mano para facilitar la entrega.\n\n¡Gracias! por confiar en nosotros disfruta de tu pedido.",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"q"},{"indice":2,"etiqueta":null,"ejemplo":"q"},{"indice":3,"etiqueta":null,"ejemplo":"q"}],
  },
  {
    nombre: "seguimiento_en_reparto_v2", categoria: "UTILITY", idioma: "es",
    botones: [], noSoportada: null,
    cuerpo: "Hola {{1}},\n\nTu pedido de {{2}} ya está en reparto y llegará muy pronto a la dirección {{3}} 🚛.\n\nTe recomendamos estar atento, ya que el valor a pagar es ${{4}} (si ya has realizado el pago, por favor haz caso omiso a esta parte).",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"q"},{"indice":2,"etiqueta":null,"ejemplo":"q"},{"indice":3,"etiqueta":null,"ejemplo":"q"},{"indice":4,"etiqueta":null,"ejemplo":"q"}],
  },
  {
    nombre: "seguimiento_en_reparto_v2_utilidad", categoria: "UTILITY", idioma: "es",
    botones: [], noSoportada: null,
    cuerpo: "Hola {{1}}\n\nTe informamos que tu pedido de {{2}} se encuentra actualmente en *proceso de reparto* por parte de la transportadora.\n\nLa entrega está siendo gestionada conforme a la ruta operativa del día para la dirección registrada: {{3}}\n\nValor: ${{4}}\n\nCualquier novedad relacionada con la entrega será informada por este mismo chat.",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"q"},{"indice":2,"etiqueta":null,"ejemplo":"q"},{"indice":3,"etiqueta":"iva del día para la dirección registrada","ejemplo":"q"},{"indice":4,"etiqueta":null,"ejemplo":"q"}],
  },
  {
    nombre: "seguimiento_entregado_v2", categoria: "MARKETING", idioma: "es",
    botones: [], noSoportada: null,
    cuerpo: "¡Nos cuentan que ya recibiste tu pedido {{1}}! 🙌\n\n{{2}}\n\nEstamos aquí para asegurarnos de que tengas la mejor experiencia posible. Si tienes alguna pregunta o necesitas asistencia adicional, no dudes en contactarnos.\n\n¡Disfruta de tu nuevo producto y que tengas un día increíble! 😊",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"q"},{"indice":2,"etiqueta":null,"ejemplo":"q"}],
  },
  {
    nombre: "seguimiento_entregado_v2_utilidad", categoria: "UTILITY", idioma: "es",
    botones: [], noSoportada: null,
    cuerpo: "Hola {{1}}, te informamos que tu pedido {{2}} ha sido entregado exitosamente en la dirección registrada📍\n\nSi no has recibido el paquete o tienes alguna duda con el estado de la entrega, por favor comunícate con nosotros respondiendo a este mensaje.",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"q"},{"indice":2,"etiqueta":null,"ejemplo":"q"}],
  },
  {
    nombre: "seguimiento_guia_generada_gt_utilidad", categoria: "UTILITY", idioma: "es",
    botones: ["Ver guia"], noSoportada: "Tiene un botón con un enlace personalizado (guía o carrito) que Guardian no arma. Esta hay que mandarla desde el panel de chat.",
    cuerpo: "Hola {{1}},\n\nTu guía de envío ha sido generada: #{{2}} 🚚\n\nPuedes hacer el seguimiento de tu pedido en la página de la transportadora {{3}}, donde podrás ver su ubicación y el tiempo estimado de entrega.\n\nEn caso de requerir consultar el detalle del envío, puedes utilizar el botón disponible en este mensaje.",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"q"},{"indice":2,"etiqueta":null,"ejemplo":"q"},{"indice":3,"etiqueta":null,"ejemplo":"q"}],
  },
  {
    nombre: "seguimiento_guia_generada_pdf_v2", categoria: "UTILITY", idioma: "es",
    botones: ["Ver guia"], noSoportada: "Tiene un botón con un enlace personalizado (guía o carrito) que Guardian no arma. Esta hay que mandarla desde el panel de chat.",
    cuerpo: "Hola {{1}},\n\nTu guía de envío ha sido generada: #{{2}} 🚚\n\nPuedes hacer el seguimiento de tu pedido en la página de la transportadora {{3}}, donde podrás ver su ubicación y el tiempo estimado de entrega.\n\nPara ver todo el detaller de tu guia, presiona el boton “Ver guia”👇",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"q"},{"indice":2,"etiqueta":null,"ejemplo":"q"},{"indice":3,"etiqueta":null,"ejemplo":"q"}],
  },
  {
    nombre: "seguimiento_guia_generada_v2_utilidad", categoria: "UTILITY", idioma: "es",
    botones: ["Ver guia"], noSoportada: "Tiene un botón con un enlace personalizado (guía o carrito) que Guardian no arma. Esta hay que mandarla desde el panel de chat.",
    cuerpo: "Hola {{1}},\n\nTu guía de envío ha sido generada: #{{2}} 🚚\n\nPuedes hacer el seguimiento de tu pedido en la página de la transportadora {{3}}, donde podrás ver su ubicación y el tiempo estimado de entrega.\n\nEn caso de requerir consultar el detalle del envío, puedes utilizar el botón disponible en este mensaje.",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"q"},{"indice":2,"etiqueta":null,"ejemplo":"q"},{"indice":3,"etiqueta":null,"ejemplo":"q"}],
  },
  {
    nombre: "seguimiento_reclamo_oficina_1_utilidad", categoria: "UTILITY", idioma: "es",
    botones: [], noSoportada: null,
    cuerpo: "Hola {{1}}\n\nTe informamos que tu envío con guía {{2}} ya está disponible para retiro en nuestra\noficina de {{3}}.\n\nTransportadora: {{4}}.\n\nSi ya recibiste tu pedido, puedes ignorar este mensaje.",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"w"},{"indice":2,"etiqueta":null,"ejemplo":"w"},{"indice":3,"etiqueta":null,"ejemplo":"w"},{"indice":4,"etiqueta":"Transportadora","ejemplo":"w"}],
  },
  {
    nombre: "seguimiento_recordatorio_1_utilidad", categoria: "UTILITY", idioma: "es",
    botones: [], noSoportada: null,
    cuerpo: "Hola {{1}}\n\nQueremos recordarte que tu envío gestionado con {{2}} aún está disponible para\nretiro en nuestra oficina.\n\nSi ya retiraste el paquete, puedes ignorar este mensaje.",
    variables: [{"indice":1,"etiqueta":null,"ejemplo":"q"},{"indice":2,"etiqueta":null,"ejemplo":"q"}],
  },];
