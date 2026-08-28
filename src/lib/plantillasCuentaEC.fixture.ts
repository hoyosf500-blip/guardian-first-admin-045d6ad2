import type { PlantillaMeta } from './plantillasMeta';

/**
 * Las plantillas OPERATIVAS reales de la cuenta de Ecuador, leídas de Meta el
 * 28-ago-2026 (`importchat-plantillas` → `accion: 'listar'`, 43 aprobadas).
 *
 * ── Por qué una copia real y no ejemplos inventados ─────────────────────────
 * Los dos errores que llegaron a clientes salieron de detalles que nadie
 * inventaría a mano al escribir un test:
 *
 *   - `guia_generada_v1` tiene un hueco de LINK sin etiqueta, cuyo ejemplo de
 *     Meta es una URL que contiene la palabra "tracking" → se llenaba con el
 *     NÚMERO de guía y al cliente le llegaba
 *     *"seguí tu envío aquí 👉 V123456789"*.
 *   - `retiro_agencia_v1` saluda "Estimado/**a** {{1}}" y dice "su {{2}}", y por
 *     esas dos formas concretas quedaba imposible de completar — así que ganaba
 *     `retiro_agencia_k1`, que le escribe al cliente
 *     *"retirado en agencia: SERVIENTREGA"*.
 *
 * Un fixture "razonable" habría pasado en verde con los dos bugs vivos.
 *
 * ── Qué NO está acá ─────────────────────────────────────────────────────────
 * Las 19 restantes (remarketing, carritos abandonados, agradecimiento, las dos
 * de prueba) no matchean NINGÚN patrón de `ACCION_POR_FASE`, así que no cambian
 * nada de lo que este fixture prueba. Se dejan fuera para que el archivo se
 * pueda leer.
 */
export const PLANTILLAS_EC: readonly PlantillaMeta[] = [
  {
    nombre: 'antes_generar_guia_k1', categoria: 'UTILITY', idioma: 'es', botones: [], noSoportada: null,
    variables: [],
    cuerpo: 'Perfecto, en este momento procedemos con su despacho, en un momento le comparto su guía de envío. 😊\nCualquier duda que tenga estoy para ayudarle 📦',
  },
  {
    nombre: 'confirmacion_datos_v1', categoria: 'UTILITY', idioma: 'es',
    botones: ['Sí, está correcto', 'Corregir un dato'], noSoportada: null,
    variables: [
      { indice: 1, etiqueta: null, ejemplo: 'María' },
      { indice: 2, etiqueta: 'Producto', ejemplo: 'Gafas Inteligentes G58' },
      { indice: 3, etiqueta: 'Ciudad', ejemplo: 'Quito' },
      { indice: 4, etiqueta: null, ejemplo: 'Pichincha' },
      { indice: 5, etiqueta: 'Dirección', ejemplo: 'Av. Amazonas N34 y Naciones Unidas, edificio azul' },
    ],
    cuerpo: '¡Hola, estimado/a {{1}}! 👋 Recibimos su pedido con pago contra entrega. Por favor revise que sus datos estén correctos para despacharlo hoy mismo:\n\n📦 Producto: {{2}}\n📍 Ciudad: {{3}}, {{4}}\n🏡 Dirección: {{5}}\n\n¿Está todo correcto? 🙌',
  },
  {
    nombre: 'confirmacion_pedido_k1', categoria: 'UTILITY', idioma: 'es',
    botones: ['CONFIRMAR PEDIDO', 'ACTUALIZAR INFORMACIÓN'], noSoportada: null,
    variables: [
      { indice: 1, etiqueta: null, ejemplo: 'Daniel' },
      { indice: 2, etiqueta: null, ejemplo: '35.00' },
      { indice: 3, etiqueta: 'Producto', ejemplo: 'Audífonos Bluetooth' },
      { indice: 4, etiqueta: 'Nombre', ejemplo: 'Daniel Bonilla' },
      { indice: 5, etiqueta: 'Teléfono', ejemplo: '0987654321' },
      { indice: 6, etiqueta: 'Dirección', ejemplo: 'Av. Simón Bolívar y Mariscal Sucre' },
      { indice: 7, etiqueta: 'Ciudad', ejemplo: 'Quito' },
    ],
    cuerpo: 'Hola {{1}}, Acabo de recibir tu pedido de compra por el valor de ${{2}}\nQuiero confirmar tus datos de envío:\n\n✅Producto: {{3}}\n👤Nombre: {{4}}\n📱Teléfono: {{5}}\n📍Dirección: {{6}}\n🏙️Ciudad: {{7}}\n\nPor favor, selecciona *CONFIRMAR PEDIDO* si tus datos son correctos ✅, o *ACTUALIZAR INFORMACIÓN* para corregirlos antes de proceder con el envío de tu producto. 🚚',
  },
  {
    nombre: 'en_camino_hoy_v1', categoria: 'UTILITY', idioma: 'es', botones: [], noSoportada: null,
    variables: [{ indice: 1, etiqueta: null, ejemplo: 'María' }, { indice: 2, etiqueta: null, ejemplo: 'Gafas Inteligentes G58' }],
    cuerpo: 'Estimado/a {{1}}, ¡hoy es el día! 🚚 Su {{2}} sale a entrega y llega a su dirección en el transcurso del día.\n\nPor favor manténgase atento/a a la llamada del transportista y tenga listo el pago en efectivo. Si en este momento no va a estar en casa, escríbanos y coordinamos para que no se le pase.',
  },
  {
    nombre: 'en_camino_hoy_v2', categoria: 'UTILITY', idioma: 'es',
    botones: ['Sí, estaré pendiente', 'Coordinar otra hora'], noSoportada: null,
    variables: [{ indice: 1, etiqueta: null, ejemplo: 'María' }, { indice: 2, etiqueta: null, ejemplo: 'Gafas Bluetooth' }],
    cuerpo: 'Estimado/a {{1}}, ¡hoy es el día! 🚚 Su {{2}} sale a entrega y llega a su dirección en el transcurso del día. Manténgase atento/a a la llamada del transportista y tenga listo el pago. ¿Estará disponible hoy para recibirlo?',
  },
  {
    nombre: 'en_transito_v2', categoria: 'UTILITY', idioma: 'es', botones: ['Perfecto'], noSoportada: null,
    variables: [
      { indice: 1, etiqueta: null, ejemplo: 'Michael' },
      { indice: 2, etiqueta: null, ejemplo: '1231321' },
      { indice: 3, etiqueta: null, ejemplo: 'Quito' },
    ],
    cuerpo: 'Hola {{1}}, te cuento que tu orden {{2}} esta en {{3}}, mantente atento !!!',
  },
  {
    nombre: 'guia_generada_k1', categoria: 'UTILITY', idioma: 'es',
    botones: ['Descargar Guía', 'Seguimiento del pedido'],
    noSoportada: 'Tiene un botón con un enlace personalizado (guía o carrito) que Guardian no arma. Esta se manda desde ImporChat.',
    variables: [],
    cuerpo: 'La guía de envío de tu pedido ha sido generada. El tiempo estimado de entrega es de 2 a 3 días hábiles.',
  },
  {
    nombre: 'guia_generada_v1', categoria: 'UTILITY', idioma: 'es', botones: [], noSoportada: null,
    variables: [
      { indice: 1, etiqueta: null, ejemplo: 'María' },
      { indice: 2, etiqueta: null, ejemplo: 'Gafas Inteligentes G58' },
      { indice: 3, etiqueta: null, ejemplo: 'https://www.servientrega.com.ec/Tracking/?tipo=GUIA&amp;guia=A12345678' },
    ],
    cuerpo: '¡Buenas noticias, estimado/a {{1}}! 🎉 Su {{2}} ya tiene guía y salió de bodega rumbo a su ciudad.\n\nPuede seguir su envío en todo momento aquí 👉 {{3}}\n\nEn los próximos días la transportadora coordinará la entrega. Tenga a la mano el valor a pagar al recibir. ¡Gracias por confiar en nosotros!',
  },
  {
    nombre: 'novedad_k1', categoria: 'UTILITY', idioma: 'es', botones: [], noSoportada: null,
    variables: [],
    cuerpo: 'Te comento que se ha gestionado un nuevo intento de entrega con la transportadora. Por favor, estar atento para que puedas recibir tu pedido sin inconvenientes.',
  },
  {
    nombre: 'novedad_k2', categoria: 'UTILITY', idioma: 'es',
    botones: ['Confirmo recepción', 'Reprogramar entrega'], noSoportada: null,
    variables: [{ indice: 1, etiqueta: null, ejemplo: '15 de Abril' }],
    cuerpo: 'Estimado cliente, le recordamos que al seleccionar pago contraentrega, usted se comprometió a recibir y pagar el pedido, conforme a la ley 67 del 2022 de Comercio Electrónico.\n\nEl costo del envío ya fue asumido por nuestra empresa.\nSe ha programado un nuevo intento de entrega para el día {{1}}.\n\nEs importante contar con su disponibilidad para evitar cancelación del pedido y posibles restricciones en futuras compras.',
  },
  {
    nombre: 'novedad_reprogramar_v1', categoria: 'UTILITY', idioma: 'es',
    botones: ['Reprogramar entrega'], noSoportada: null,
    variables: [{ indice: 1, etiqueta: null, ejemplo: 'María' }, { indice: 2, etiqueta: null, ejemplo: 'Gafas Inteligentes G58' }],
    cuerpo: 'Hola, estimado/a {{1}} 👋 Su {{2}} ya llegó a su ciudad y el transportista fue a entregárselo, pero no logró ubicarlo 📦\n\nSabemos la ilusión con la que lo espera y no queremos que se quede sin él. Su pedido sigue apartado a su nombre, pero solo por poco tiempo antes de que regrese a bodega.\n\nCoordinemos juntos un nuevo intento para que lo reciba muy pronto 🙌',
  },
  {
    nombre: 'novedadk2', categoria: 'UTILITY', idioma: 'es',
    botones: ['Confirmo recepción', 'Reprogramar entrega'], noSoportada: null,
    variables: [],
    cuerpo: 'Estimado cliente, le recordamos que al seleccionar pago contraentrega, usted se comprometió a recibir y pagar el pedido, conforme a la ley 67 del 2022 de Comercio Electrónico.\n\nEl costo del envío ya fue asumido por nuestra empresa.\nNecesitamos programar un nuevo intento de entrega lo antes posible por favor.\n\nEs importante contar con su disponibilidad para evitar cancelación del pedido y posibles restricciones en futuras compras.',
  },
  {
    nombre: 'recordatorio_confirmacion_k1', categoria: 'UTILITY', idioma: 'es',
    botones: ['Sí, confirmar', 'Cancelar pedido'], noSoportada: null,
    variables: [],
    cuerpo: 'Hola 👋 Tenemos tu pedido listo para ser despachado, pero aún está pendiente de confirmación. ¿Nos confirmas que deseas recibirlo? Respóndenos por aquí y lo procesamos de inmediato.',
  },
  {
    nombre: 'retiro_agencia_disponible_k1', categoria: 'UTILITY', idioma: 'es', botones: [], noSoportada: null,
    variables: [
      { indice: 1, etiqueta: null, ejemplo: 'Daniel' },
      { indice: 2, etiqueta: 'Agencia', ejemplo: 'Servientrega Guayaquil Centro' },
      { indice: 3, etiqueta: 'Guía', ejemplo: 'V123456789' },
      { indice: 4, etiqueta: 'Plazo para retirar', ejemplo: '7' },
    ],
    cuerpo: 'Hola {{1}}, tu pedido ya llegó y está listo para que lo retires 🎉\n\n📍Agencia: {{2}}\n🔖Guía: {{3}}\n🗓️Plazo para retirar: {{4}} días\n\nSolo acércate con tu cédula y el número de guía 😊\nSi ya lo retiraste, respóndenos y actualizamos tu pedido.',
  },
  {
    nombre: 'retiro_agencia_k1', categoria: 'UTILITY', idioma: 'es', botones: [], noSoportada: null,
    variables: [{ indice: 1, etiqueta: 'esta listo para ser retirado en agencia', ejemplo: 'Agencia Norte Quito' }],
    cuerpo: 'Estimado Cliente:\nServientrega le notifica que su pedido esta listo para ser retirado en agencia: {{1}}\nPor favor acercarse lo más pronto posible.',
  },
  {
    nombre: 'retiro_agencia_recordatorio_k2', categoria: 'UTILITY', idioma: 'es', botones: [], noSoportada: null,
    variables: [
      { indice: 1, etiqueta: null, ejemplo: 'Daniel' },
      { indice: 2, etiqueta: 'Agencia', ejemplo: 'Servientrega Guayaquil Centro' },
      { indice: 3, etiqueta: 'Guía', ejemplo: 'V123456789' },
      { indice: 4, etiqueta: null, ejemplo: '7' },
    ],
    cuerpo: 'Hola {{1}}, tu pedido sigue esperándote en la agencia 📦\n\n📍Agencia: {{2}}\n🔖Guía: {{3}}\n\n⏳Te recordamos que la agencia guarda los envíos {{4}} días; cumplido ese plazo el paquete regresa al remitente.\n\n¿Podrás acercarte a retirarlo? Cuéntanos y te ayudamos 😊',
  },
  {
    nombre: 'retiro_agencia_recordatorio_k3', categoria: 'UTILITY', idioma: 'es', botones: [], noSoportada: null,
    variables: [
      { indice: 1, etiqueta: null, ejemplo: 'Daniel' },
      { indice: 2, etiqueta: 'Agencia', ejemplo: 'Servientrega Guayaquil Centro' },
      { indice: 3, etiqueta: 'Guía', ejemplo: 'V123456789' },
      { indice: 4, etiqueta: null, ejemplo: '7' },
    ],
    cuerpo: 'Hola {{1}}, no queremos que pierdas tu pedido 💙\n\n📍Agencia: {{2}}\n🔖Guía: {{3}}\n\n⚠️El plazo de {{4}} días está por cumplirse y después el envío regresa al remitente.\n\nSi no puedes acercarte, respóndenos y buscamos una alternativa contigo 🤝',
  },
  {
    nombre: 'ultima_oportunidad_v1', categoria: 'UTILITY', idioma: 'es',
    botones: ['Sí, quiero recibirlo'], noSoportada: null,
    variables: [{ indice: 1, etiqueta: null, ejemplo: 'María' }, { indice: 2, etiqueta: null, ejemplo: 'Gafas Inteligentes G58' }],
    cuerpo: 'Estimado/a {{1}}, no queremos que se quede sin su {{2}} 😔 Su pedido está a punto de regresar a bodega por no haberse podido entregar.\n\nTodavía estamos a tiempo de darle una última oportunidad para que lo reciba. ¿Coordinamos hoy mismo un nuevo intento? Solo respóndanos y nos encargamos del resto.',
  },
  {
    nombre: 'zona_entrega_k1', categoria: 'UTILITY', idioma: 'es', botones: [], noSoportada: null,
    variables: [
      { indice: 1, etiqueta: null, ejemplo: 'Quito' },
      { indice: 2, etiqueta: null, ejemplo: 'Av. Amazonas 123' },
      { indice: 3, etiqueta: null, ejemplo: '$20.00' },
      { indice: 4, etiqueta: null, ejemplo: 'https://fenixoper.laarcourier.com/Tracking/Guiacompleta.aspx?guia=LC123' },
    ],
    cuerpo: 'Hoy tu pedido ha llegado 📦✅ a {{1}} y está próximo a ser entregado en {{2}}, en el horario de 9 am a 6 pm. ¡Te recordamos tener el valor total de {{3}} en efectivo! Agradecemos estar atento a las llamadas del courier 🚚 Revisa el estado de tu guía aquí {{4}} 😊.',
  },
  {
    nombre: 'direccion_incompleta', categoria: 'MARKETING', idioma: 'es', botones: [], noSoportada: null,
    variables: [],
    cuerpo: 'Como le va 😊 por favor me ayuda con la calle principal y secundaria para completar el pedido 📦\nO me indica si desea retirar en agencia de Servientrega 🚚',
  },
  {
    nombre: 'reconfirmacion', categoria: 'MARKETING', idioma: 'es', botones: [], noSoportada: null,
    variables: [],
    cuerpo: 'Como le va 😊 su pedido está listo. \nSolo necesito su *OK* para enviarlo 🚚',
  },
  {
    nombre: 'rescate_devolucion_v1', categoria: 'MARKETING', idioma: 'es',
    botones: ['Sí, reenvíenmelo'], noSoportada: null,
    variables: [{ indice: 1, etiqueta: null, ejemplo: 'María' }, { indice: 2, etiqueta: null, ejemplo: 'Gafas Bluetooth' }],
    cuerpo: 'Estimado/a {{1}}, su {{2}} tuvo que regresar a bodega porque no se pudo completar la entrega 😔 Pero tiene una segunda oportunidad: podemos volver a enviárselo y usted sigue pagando solo al recibir, sin ningún riesgo. ¿Le reactivamos el envío?',
  },
  {
    nombre: 'retiro_agencia_v1', categoria: 'MARKETING', idioma: 'es',
    botones: ['Sí, necesito los datos'], noSoportada: null,
    variables: [{ indice: 1, etiqueta: null, ejemplo: 'María' }, { indice: 2, etiqueta: null, ejemplo: 'Gafas Inteligentes G58' }],
    cuerpo: 'Estimado/a {{1}}, su {{2}} ya está esperándolo/a en la agencia para que lo retire 📦\n\nEstá apartado a su nombre, pero la agencia solo lo guarda unos días antes de devolverlo a bodega. No deje que se le pase después de lo que esperó por él.\n\nEscríbanos y le confirmamos la dirección y el horario de la agencia para que pase a recogerlo. 🙌',
  },
  {
    nombre: 'seguimiento_reactivar_v1', categoria: 'MARKETING', idioma: 'es',
    botones: ['Sí, continuar', 'Ya no me interesa'], noSoportada: null,
    variables: [{ indice: 1, etiqueta: null, ejemplo: 'María' }, { indice: 2, etiqueta: null, ejemplo: 'Gafas Bluetooth' }],
    cuerpo: 'Estimado/a {{1}}, hemos intentado comunicarnos por su pedido de {{2}} y no lo hemos logrado 📞 Su pedido sigue reservado a su nombre y queremos asegurarnos de que le llegue bien. ¿Seguimos adelante con la entrega?',
  },
];
