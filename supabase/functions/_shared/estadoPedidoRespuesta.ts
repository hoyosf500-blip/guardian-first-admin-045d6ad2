// estadoPedidoRespuesta — el "cerebro" del bot NO CIEGO.
//
// Pedido del dueño (27-ago-2026): "hagamos el bot inteligente de nuestro lado".
// Guardian YA tiene el estado del pedido en `orders` (guía, transportadora,
// estado, días) porque lo sincroniza de Dropi. Lo único que faltaba era, cuando
// el cliente pregunta por su envío, RESPONDERLE con ese dato en vez de escalar a
// un asesor que no llega — que es lo que dispara las cancelaciones.
//
// Este módulo es la lógica PURA de dos preguntas, sin red y sin estado:
//   1. `esConsultaEstado(texto)`  → ¿el cliente está preguntando por su envío?
//   2. `componerEstadoPedido(o)`  → el mensaje que se le manda, según el estado.
//
// Vive en `_shared/` (lo importa la edge function Deno) y se prueba desde
// `src/lib/estadoPedidoRespuesta.test.ts` cruzando el límite — el patrón de la
// casa, porque `npm test` no corre las pruebas que viven en `supabase/functions/`.
//
// ⛔ REGLA DE ORO — NO INVENTAR. Si un dato no está (no hay guía todavía, el
// estado es desconocido), el mensaje lo dice con honestidad o se DERIVA a un
// humano (`derivarAHumano`). Nunca se fabrica una guía ni una fecha. Es la misma
// regla que hizo que el bot no alucine con productos: mejor "déjeme verificar"
// que un dato inventado.
//
// Copy en USTED cálido ecuatoriano (memoria copy_bot_ecuador_usted): NADA de
// voseo ("tenés/podés" suena caleño/argentino). El número es de Ecuador.

/** Fase del pedido de cara al cliente. Es un bucket propio, NO el estado crudo. */
export type FasePedido =
  | "por_confirmar" // creado, todavía SIN confirmar: no se le dice que se está preparando
  | "preparando"   // confirmado pero sin guía en ruta todavía
  | "en_camino"    // despachado, viajando
  | "en_oficina"   // llegó a agencia, el cliente lo retira
  | "novedad"      // hubo un problema en la entrega
  | "entregado"    // ya se entregó
  | "devolucion"   // volviendo al remitente
  | "cancelado"    // cancelado
  | "desconocido"; // no se pudo clasificar → derivar a humano

export type EstadoPedidoInput = {
  nombre?: string | null;
  estado?: string | null;
  guia?: string | null;
  transportadora?: string | null;
  /** Días hábiles transcurridos desde el despacho (para estimar lo que falta). */
  diasHabiles?: number | null;
  /** URL de rastreo ya armada por el caller con getTrackingUrl (opcional). */
  trackingUrl?: string | null;
  pais?: string; // 'EC' | 'CO' | 'GT' — solo afecta detalles menores de copy.
};

export type EstadoPedidoRespuesta = {
  fase: FasePedido;
  /** El mensaje para el cliente, en usted. "" si derivarAHumano. */
  texto: string;
  /** true si NO se debe auto-responder: falta el dato o es un caso delicado. */
  derivarAHumano: boolean;
  incluyeGuia: boolean;
};

// ── 1. ¿Está preguntando por su envío? ──────────────────────────────────────
//
// Detector de intención por regex sobre el texto normalizado (minúsculas, sin
// tildes). Cubre cómo la gente pregunta de verdad en EC/CO, no el diccionario:
// "ya lo enviaron?", "cuando me llega", "donde va mi pedido", "mi guia", "el
// numero de rastreo", "cuanto falta". Es a propósito GENEROSO en reconocer pero
// el que RESPONDE (componer) es honesto: si detecta pero no hay dato, deriva.

const NORM = (s: string) =>
  (s || "")
    .toLowerCase()
    // Tildes fuera SIN el rango de diacríticos combinantes (chars invisibles y
    // frágiles en el fuente): mapeo directo de vocales precompuestas.
    .replace(/[áàä]/g, "a")
    .replace(/[éèë]/g, "e")
    .replace(/[íìï]/g, "i")
    .replace(/[óòö]/g, "o")
    .replace(/[úùü]/g, "u")
    .replace(/ñ/g, "n")
    .replace(/\s+/g, " ")
    .trim();

const PATRONES_ESTADO: RegExp[] = [
  /\bgu[ií]a\b/,
  /\bguia\b/,
  /\brastre|\brastreo|\btracking\b/,
  /\bseguimiento\b/,
  /\bnumero de (env[ií]o|rastreo|gu[ií]a)\b/,
  /\b(cu[aá]ndo|cuando).*(llega|entregan|env[ií]|recib)/,
  /\b(d[oó]nde|donde).*(pedido|env[ií]o|paquete|producto|orden)\b/,
  /\b(ya|cuando).*(enviaron|despach|manda|sali[oó])/,
  /\b(mi|el|est[eé]|ese) (pedido|env[ií]o|paquete|orden)\b.*(llega|estado|va|viene|donde|cuando)/,
  /\bcu[aá]nto (falta|demora|tarda)/,
  /\bestado (de mi|del) (pedido|env[ií]o|orden|compra)/,
  /\b(en cu[aá]nto|en cuanto).*(llega|entregan|recib)/,
  /\btransportadora\b/,
];

/** ¿El texto del cliente pregunta por el estado/ubicación de su envío? */
export function esConsultaEstado(texto: string): boolean {
  const t = NORM(texto);
  if (!t || t.length < 3) return false;
  return PATRONES_ESTADO.some((re) => re.test(t));
}

// ── 2. El estado crudo → fase de cara al cliente ────────────────────────────
//
// Buckets sobre `orders.estado` (mayúsculas). Cubre CO y EC. Lo que no matchea
// cae en 'desconocido' A PROPÓSITO → se deriva a un humano en vez de adivinar.

export function faseDePedido(estado?: string | null): FasePedido {
  const s = (estado || "").toUpperCase().trim();
  if (!s) return "desconocido";

  // Terminales primero (son inequívocos).
  if (s.includes("ENTREGADO")) return "entregado";
  if (s.includes("DEVOL")) return "devolucion"; // DEVOLUCION, DEVOLUCION EN TRANSITO
  if (s.includes("CANCELAD") || s.includes("ARCHIVAD")) return "cancelado";

  // Novedad / intento fallido (delicado: el cliente ya tuvo una mala experiencia).
  if (s === "NOVEDAD" || s.includes("NOVEDAD") || s.includes("INTENTO DE ENTREGA"))
    return "novedad";

  // En oficina / para retirar.
  if (s.includes("RECLAME") || s.includes("OFICINA") || s.includes("AGENCIA"))
    return "en_oficina";

  // En movimiento hacia el cliente.
  if (
    s.includes("TRANSITO") ||
    s.includes("REPARTO") ||
    s.includes("EN CAMINO") ||
    s.includes("EN RUTA") ||
    s.includes("DISTRIBUCION") ||
    s.includes("RECOGIDO") ||
    s.includes("DESPACH")
  )
    return "en_camino";

  // ⛔ Todavía NO está confirmado. Va ANTES del bucket "preparando" porque
  // "PENDIENTE CONFIRMACION" contiene "PENDIENTE": el 4-sep-2026 el responder
  // le dijo "su pedido está en preparación, ya lo estamos preparando" a un
  // cliente cuyo pedido nadie había confirmado todavía (#6851563). Mentira
  // chica, pero mentira — y le pisa el trabajo a quien lo va a llamar a confirmar.
  if (s.includes("PENDIENTE CONFIRMACION") || s.includes("POR CONFIRMAR") || s.includes("SIN CONFIRMAR"))
    return "por_confirmar";

  // Confirmado / preparándose (todavía en bodega o guía recién generada).
  if (
    s.includes("PENDIENTE") ||
    s.includes("CONFIRMAD") ||
    s.includes("ALISTAMIENTO") ||
    s.includes("PROCESAMIENTO") ||
    s.includes("BODEGA") ||
    s.includes("GUIA GENERADA") ||
    s.includes("GENERADA")
  )
    return "preparando";

  return "desconocido";
}

// ── El mensaje, según la fase ───────────────────────────────────────────────

const saludo = (nombre?: string | null) => {
  const n = (nombre || "").trim().split(/\s+/)[0]; // solo el primer nombre
  return n ? `¡Hola ${n}! ` : "¡Hola! ";
};

const conTransportadora = (t?: string | null) => {
  const tt = (t || "").trim();
  return tt ? ` con ${tt}` : "";
};

/**
 * Arma la respuesta al cliente a partir del pedido.
 *
 * `derivarAHumano=true` significa "NO auto-respondas esto": o falta el dato, o
 * es un caso que un mensaje enlatado no debe cerrar (cancelado, desconocido).
 * El caller (botón de la asesora o worker autónomo) decide qué hacer con eso:
 * el botón lo muestra igual para que la persona lo edite; el worker lo escala.
 */
export function componerEstadoPedido(o: EstadoPedidoInput): EstadoPedidoRespuesta {
  const fase = faseDePedido(o.estado);
  const hola = saludo(o.nombre);
  const guia = (o.guia || "").trim();
  const track = (o.trackingUrl || "").trim();
  const transp = conTransportadora(o.transportadora);

  switch (fase) {
    case "en_camino": {
      // Si por lo que sea no hay guía, NO se inventa: se da el estado sin número.
      const lineaGuia = guia ? `, guía *${guia}*` : "";
      const lineaTrack = track ? `\n\nPuede rastrearlo aquí: ${track}` : "";
      return {
        fase,
        incluyeGuia: !!guia,
        derivarAHumano: false,
        texto:
          `${hola}📦 Su pedido ya va en camino${transp}${lineaGuia}.` +
          lineaTrack +
          `\n\nRecuerde tener listo el valor para el pago contra entrega. ` +
          `Cualquier cosa, aquí estoy para ayudarle 😊`,
      };
    }

    case "en_oficina": {
      const lineaGuia = guia ? ` Su guía es *${guia}*.` : "";
      const lineaTrack = track ? `\n\nRastreo: ${track}` : "";
      return {
        fase,
        incluyeGuia: !!guia,
        derivarAHumano: false,
        texto:
          `${hola}📍 Su pedido ya llegó a la oficina${transp} para que lo retire.` +
          lineaGuia +
          lineaTrack +
          `\n\nLe recomiendo pasar a recogerlo pronto para que no se devuelva. ` +
          `Si necesita la dirección exacta de la oficina, con gusto se la busco 😊`,
      };
    }

    case "novedad": {
      // Caso delicado: el cliente ya tuvo un tropiezo. Tono cálido + acción
      // concreta (reprogramar), sin echar culpas ni asustar.
      const lineaGuia = guia ? ` (guía *${guia}*${transp})` : "";
      return {
        fase,
        incluyeGuia: !!guia,
        derivarAHumano: false,
        texto:
          `${hola}😊 Estuve revisando su pedido${lineaGuia} y veo que hubo una novedad ` +
          `con la entrega. No se preocupe, lo solucionamos.\n\n` +
          `¿Quiere que reprogramemos la entrega? Dígame el mejor día y una dirección ` +
          `o referencia clara y lo coordino enseguida para que le llegue 📦`,
      };
    }

    case "por_confirmar":
      // Registrado pero sin confirmar: se le dice eso, no que se está preparando.
      return {
        fase,
        incluyeGuia: false,
        derivarAHumano: false,
        texto:
          `${hola}😊 Su pedido ya quedó registrado y está en proceso de confirmación. ` +
          `En cuanto quede confirmado y salga a ruta, le comparto por aquí el número de guía para que lo siga.` +
          `\n\n¿Le ayudo con algo más?`,
      };

    case "preparando": {
      // Confirmado pero sin guía en ruta: honesto, sin inventar número.
      const lineaGuia = guia
        ? `Su guía es *${guia}* y en breve sale a ruta.`
        : `Ya lo estamos preparando y en cuanto salga a ruta le comparto el número de guía para que lo siga.`;
      return {
        fase,
        incluyeGuia: !!guia,
        derivarAHumano: false,
        texto:
          `${hola}😊 Su pedido está en preparación. ${lineaGuia}` +
          `\n\nEn poquitos días lo tiene en sus manos. ¿Le ayudo con algo más?`,
      };
    }

    case "entregado":
      return {
        fase,
        incluyeGuia: false,
        derivarAHumano: false,
        texto:
          `${hola}✅ Según nuestro sistema su pedido ya fue entregado. ` +
          `¡Esperamos que lo disfrute! Si tuvo algún inconveniente, cuénteme y le ayudo enseguida 😊`,
      };

    case "devolucion":
      // No cerramos la venta: ofrecemos reenviar (rescate).
      return {
        fase,
        incluyeGuia: false,
        derivarAHumano: false,
        texto:
          `${hola}😊 Veo que su pedido inició un proceso de devolución. ` +
          `Si todavía lo quiere, dígame y coordino un nuevo envío enseguida, sin ningún problema 📦`,
      };

    case "cancelado":
      // Delicado: no confirmamos un "cancelado" con un enlatado. Se deriva para
      // que una persona entienda por qué y lo recupere si se puede.
      return {
        fase,
        incluyeGuia: false,
        derivarAHumano: true,
        texto: "",
      };

    default:
      // 'desconocido': no adivinamos. Se deriva a un humano.
      return {
        fase: "desconocido",
        incluyeGuia: false,
        derivarAHumano: true,
        texto: "",
      };
  }
}

// ── 3. Lo que necesita un RESPONDEDOR AUTOMÁTICO además de la intención ──────
//
// Agregado el 4-sep-2026 para `importchat-responder`. Caso real que lo motivó
// (chat de Ecuador): el bot pidió el número, el cliente mandó "0960915765", el
// bot dijo *"un momentito que lo verifico con el equipo y le confirmo por aquí"*
// … y se calló 13 horas. Guardian tiene el pedido y puede cumplir esa promesa.

/**
 * El cliente mandó SOLO un número: su teléfono o el número de pedido, con o
 * sin espacios/guiones/+. Es la respuesta típica a "¿me confirma con qué
 * número hizo el pedido?". Entre 6 y 13 dígitos; un "2" o un "ok 3" no cuentan.
 */
export function esNumeroSuelto(texto: string): boolean {
  const t = (texto || "").trim();
  if (!t) return false;
  const digitos = t.replace(/[\s\-+().]/g, "");
  if (!/^\d+$/.test(digitos)) return false;
  return digitos.length >= 6 && digitos.length <= 13;
}

const PATRONES_PROMESA: RegExp[] = [
  /\bverific/,                        // "lo verifico", "permítame verificar"
  /\bd[eé]j[ea]me (revisar|verificar|consultar|ver)\b/,
  /\bun momentito\b|\bun momento\b/,
  // "le confirmo por aquí", "el equipo lo confirma por aquí", "se lo confirmamos por este medio"
  /\b(le|lo|la|se lo|se la) confirm(o|a|an|amos|en) por (aqu[ií]|este medio)\b/,
  // "para que le confirmen la hora exacta y la guía en el transcurso del día"
  /\bconfirm(en|e|amos|an) .{0,40}\b(gu[ií]a|hora|env[ií]o)\b/,
  /\ble (aviso|escribo|confirmo) (por aqu[ií]|en un momento|enseguida|en el transcurso)\b/,
  /\bya (lo|la) busco\b/,
];

/**
 * El NEGOCIO (bot o asesora) dejó una promesa de verificar y ese es el ÚLTIMO
 * mensaje del chat: nadie volvió. Si el texto ya trae una guía (5+ dígitos
 * junto a la palabra guía) NO es una promesa pendiente: ya cumplió.
 */
export function esPromesaPendiente(texto: string): boolean {
  const t = NORM(texto);
  if (!t) return false;
  if (/\bgu[ií]a\b[^\n]{0,40}\b[a-z]{0,3}\d{5,}/.test(t)) return false;
  return PATRONES_PROMESA.some((re) => re.test(t));
}

export interface PedidoElegible {
  estado?: string | null;
  /** Último movimiento conocido (ms). `null` = no se sabe. */
  movidoMs?: number | null;
}

export type MotivoEleccion = "unico" | "sin_pedidos" | "sin_vivos" | "ambiguo";

/** Diez días: un entregado/devuelto más viejo que esto ya no es "el pedido" del que pregunta. */
const VIEJO_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * De todos los pedidos que cuelgan de un chat, ¿sobre CUÁL se responde?
 *
 * ⛔ Un mismo teléfono tiene varios pedidos (el reemplazado, el cancelado, el
 * vivo). Responder por el equivocado es peor que callarse: se le dice a alguien
 * que su pedido va en camino cuando ese es el que se canceló. Regla:
 *   - se descartan cancelados/archivados y los REEMPLAZADOS (no existen para el cliente);
 *   - un entregado o devuelto de hace más de 10 días tampoco cuenta;
 *   - queda UNO → se responde por ese; quedan dos o más → `ambiguo` y no se responde;
 *   - no queda ninguno → `sin_vivos` (que lo mire una persona).
 */
export function elegirPedidoParaResponder<T extends PedidoElegible>(
  pedidos: T[],
  ahoraMs: number,
): { pedido: T | null; motivo: MotivoEleccion } {
  if (!pedidos.length) return { pedido: null, motivo: "sin_pedidos" };
  const vivos = pedidos.filter((p) => {
    const s = (p.estado || "").toUpperCase();
    if (s.includes("REEMPLAZ")) return false;
    const fase = faseDePedido(p.estado);
    if (fase === "cancelado") return false;
    if ((fase === "entregado" || fase === "devolucion") && p.movidoMs != null && ahoraMs - p.movidoMs > VIEJO_MS) return false;
    return true;
  });
  if (vivos.length === 1) return { pedido: vivos[0], motivo: "unico" };
  if (vivos.length === 0) return { pedido: null, motivo: "sin_vivos" };
  return { pedido: null, motivo: "ambiguo" };
}
