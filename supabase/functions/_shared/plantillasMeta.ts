// plantillasMeta — las plantillas de WhatsApp aprobadas por Meta, entendidas.
//
// ── Por qué existe esto ────────────────────────────────────────────────────
// Pasadas 24 h del último mensaje del cliente, WhatsApp NO entrega texto libre
// (ver `ventanaWhatsapp.ts`). El único camino que queda es una **plantilla
// aprobada por Meta**. La cuenta ya tiene 31 aprobadas —medidas el 25-ago-2026
// contra `whatsapp_managment/obtenerTemplatesWhatsapp`— y hasta hoy Guardian no
// las usaba: cuando la ventana vencía, la pantalla decía "llamalo" y se acabó.
//
// ── Lo que Meta manda y lo que hace falta ──────────────────────────────────
// Una plantilla llega con el cuerpo lleno de huecos POSICIONALES: `{{1}}`,
// `{{2}}`… sin nombre. Meta no dice qué significa cada uno; solo trae un
// `example.body_text` con valores de muestra. Mandar una plantilla es rellenar
// esos huecos en el orden correcto, y equivocarse ahí le llega al cliente:
// "tu pedido está en 7" en vez de "en Servientrega Guayaquil".
//
// Por eso este archivo hace DOS cosas separadas y no las mezcla:
//   1. **Leer** la plantilla: qué huecos tiene, qué etiqueta los precede en el
//      texto ("Agencia: {{2}}" ⇒ el hueco 2 se llama Agencia) y qué ejemplo
//      trae Meta. Esto es un HECHO, sale del texto.
//   2. **Sugerir** con qué llenarlos desde los datos del pedido. Esto es una
//      SUGERENCIA y así se trata: lo que no se puede deducir queda VACÍO —
//      nunca se inventa un número de días ni una agencia— y la asesora ve el
//      texto final exacto antes de que salga.
//
// Puro y sin dependencias: lo comparten la edge function que envía y la
// pantalla que lo dibuja, así que no pueden discrepar sobre qué se va a mandar.

/** Un hueco `{{n}}` del cuerpo, con todo lo que se sabe de él. */
export interface VariablePlantilla {
  /** El número del hueco, 1-based, tal como aparece en `{{n}}`. */
  indice: number;
  /** Lo que el texto pone justo antes del hueco ("Agencia", "Guía"). null si
   *  el cuerpo no lo etiqueta — y entonces NO se inventa uno. */
  etiqueta: string | null;
  /** El valor de muestra que Meta guarda con la plantilla. */
  ejemplo: string | null;
}

export interface PlantillaMeta {
  nombre: string;
  /** UTILITY (logística, la barata) · MARKETING (promoción, cuesta más y Meta
   *  la restringe más) · AUTHENTICATION. Se muestra: no es lo mismo avisar de
   *  una entrega que mandarle publicidad a alguien que no escribió. */
  categoria: string;
  idioma: string;
  cuerpo: string;
  variables: VariablePlantilla[];
  botones: string[];
  /**
   * Por qué ESTA plantilla no se puede mandar desde Guardian, o null si sí.
   *
   * Medido el 25-ago-2026 sobre las 31 aprobadas: 8 llevan imagen o video en
   * la cabecera y 2 llevan un botón cuyo enlace tiene un hueco (el token del
   * carrito, el PDF de la guía). Guardian no tiene ni el archivo ni esos
   * tokens. Mandarlas igual no daría error: Meta las rechazaría, o peor,
   * llegarían rotas al cliente.
   *
   * ⚠️ Se listan igual, con el motivo a la vista. Esconderlas haría creer que
   * la plantilla no existe, y la asesora la buscaría en ImporChat sin saber
   * que ahí sí funciona.
   */
  noSoportada: string | null;
}

/** Datos del pedido con los que se intenta rellenar. Todos opcionales: lo que
 *  no venga deja el hueco vacío en vez de poner algo parecido. */
export interface DatosPedido {
  nombre?: string | null;
  guia?: string | null;
  transportadora?: string | null;
  ciudad?: string | null;
  /** La dirección de entrega. La piden las plantillas de Colombia, que la
   *  nombran en prosa ("a la dirección {{3}}") en vez de con una etiqueta. */
  direccion?: string | null;
  producto?: string | null;
  valor?: string | null;
  /** El link de rastreo YA ARMADO (`getTrackingUrl` en `orderUtils.ts`, que sabe
   *  la URL de cada transportadora por país). Va aparte de `guia` a propósito:
   *  son dos cosas distintas y confundirlas fue un bug real — ver `esUrl`. */
  rastreoUrl?: string | null;
}

const texto = (v: unknown) => String(v ?? "").trim();

/** Primer nombre, con mayúscula inicial: "MARIA JOSE PEREZ" -> "Maria". */
export function primerNombre(nombre?: string | null): string {
  const limpio = texto(nombre).split(/\s+/)[0] || "";
  return limpio ? limpio.charAt(0).toUpperCase() + limpio.slice(1).toLowerCase() : "";
}

/**
 * La etiqueta de un hueco: el texto que lo precede EN SU MISMA LÍNEA, y solo
 * si termina en dos puntos.
 *
 * El corte por `:` es a propósito. En "Agencia: {{2}}" el cuerpo está diciendo
 * qué va ahí. En "Hola {{1}}, tu pedido…" no: "Hola" no es el nombre del
 * hueco, es un saludo. Tomar cualquier palabra previa daría etiquetas falsas,
 * y una etiqueta falsa es peor que ninguna — la asesora la creería.
 */
export function etiquetaDe(cuerpo: string, indice: number): string | null {
  const pos = cuerpo.indexOf(`{{${indice}}}`);
  if (pos < 0) return null;
  const linea = cuerpo.slice(0, pos).split("\n").pop() ?? "";
  const m = linea.match(/([\p{L}\p{N} ]{2,40}):\s*$/u);
  if (!m) return null;
  const et = m[1].trim();
  return et.length >= 2 ? et : null;
}

/** Los huecos que usa un cuerpo, en orden y sin repetir. */
export function indicesDe(cuerpo: string): number[] {
  const encontrados = [...cuerpo.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return [...new Set(encontrados)].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
}

/**
 * Traduce lo que devuelve ImporChat a algo con lo que se pueda trabajar.
 *
 * Solo pasan las **APPROVED**: una plantilla en revisión o rechazada por Meta
 * no se entrega, y ofrecerla sería prometerle a la asesora un mensaje que se
 * pierde en silencio — exactamente lo que la ventana de 24 h ya evita.
 */
export function parsearPlantillas(crudas: unknown): PlantillaMeta[] {
  if (!Array.isArray(crudas)) return [];
  const out: PlantillaMeta[] = [];
  for (const c of crudas as Array<Record<string, unknown>>) {
    if (!c || typeof c !== "object") continue;
    if (texto(c.status).toUpperCase() !== "APPROVED") continue;
    const componentes = Array.isArray(c.components) ? c.components as Array<Record<string, unknown>> : [];
    const body = componentes.find((x) => texto(x?.type).toUpperCase() === "BODY");
    const cuerpo = texto(body?.text);
    if (!cuerpo) continue;

    const ejemplos = (() => {
      const ex = body?.example as Record<string, unknown> | undefined;
      const bt = ex?.body_text;
      return Array.isArray(bt) && Array.isArray(bt[0]) ? (bt[0] as unknown[]).map(texto) : [];
    })();

    const variables: VariablePlantilla[] = indicesDe(cuerpo).map((indice) => ({
      indice,
      etiqueta: etiquetaDe(cuerpo, indice),
      ejemplo: ejemplos[indice - 1] || null,
    }));

    const crudosBotones = componentes
      .filter((x) => texto(x?.type).toUpperCase() === "BUTTONS")
      .flatMap((x) => (Array.isArray(x.buttons) ? x.buttons as Array<Record<string, unknown>> : []));
    const botones = crudosBotones.map((b) => texto(b?.text)).filter(Boolean);

    // ── Qué NO se puede mandar desde acá, y por qué ────────────────────────
    //
    // ⛔ La pregunta correcta NO es "¿lleva una imagen?" sino "¿TENEMOS con qué
    // llenarla?". Medido el 2-sep-2026 sobre las 30 plantillas de Colombia: de
    // las 7 que quedaban bloqueadas, una —`remarketing_neuroestres`— trae la
    // imagen como URL FIJA de la propia plantilla
    // (`https://media.chateapro.app/…/banner.jpg`). Esa se puede mandar tal
    // cual y estaba prohibida por nada.
    //
    // Las otras seis siguen bloqueadas, y con razón: su `HEADER_IMAGE` o su
    // `URL_1` apuntan a una VARIABLE del contacto en Chatea Pro
    // (`{{f209801v8628885}}`), que Guardian no controla. En las tres de guía,
    // ese valor es el nombre del PDF en CloudFront: mandarlo a ciegas puede
    // llevarle al cliente la guía de OTRA persona, o un 404. Y `remarketing_tenis`
    // directamente no tiene imagen guardada — Meta la rechazaría.
    //
    // `valorFijo` es esa pregunta: hay dato, y es literal (no un `{{…}}`).
    // ⚠️ ImporChat no manda `default_values`, así que allá todo esto es
    // `undefined` y el comportamiento queda EXACTAMENTE como estaba.
    const defaults = (() => {
      let dv = c.default_values as unknown;
      if (typeof dv === "string") { try { dv = JSON.parse(dv); } catch { dv = null; } }
      const params = (dv as { params?: Record<string, unknown> } | null)?.params;
      return params && typeof params === "object" ? params as Record<string, unknown> : {};
    })();
    const valorFijo = (clave: string): boolean => {
      const v = texto(defaults[clave]);
      return !!v && !/\{\{.*\}\}/.test(v);
    };

    const header = componentes.find((x) => texto(x?.type).toUpperCase() === "HEADER");
    const formatoHeader = texto(header?.format).toUpperCase();
    let noSoportada: string | null = null;
    if (["IMAGE", "VIDEO", "DOCUMENT"].includes(formatoHeader) && valorFijo(`HEADER_${formatoHeader}`)) {
      // El adjunto es fijo y ya lo trae la plantilla: sale igual que cualquier
      // otra. `paramsChateapro` lo conserva porque parte de `default_values`.
      noSoportada = null;
    } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(formatoHeader)) {
      // ⛔ El texto NO puede nombrar a ImporChat. Desde el 2-sep-2026 esta misma
      // función sirve a Colombia, que atiende por Chatea Pro: mandar a una
      // asesora colombiana a ImporChat la manda a la app de OTRO PAÍS. "El panel
      // de chat" es cierto en los dos lados.
      noSoportada = `Lleva ${formatoHeader === "IMAGE" ? "una imagen" : formatoHeader === "VIDEO" ? "un video" : "un archivo"} adjunto. Esta hay que mandarla desde el panel de chat.`;
    } else if (formatoHeader === "TEXT" && /\{\{\d+\}\}/.test(texto(header?.text))) {
      noSoportada = "Su título lleva un dato variable que Guardian todavía no llena. Esta hay que mandarla desde el panel de chat.";
    } else if (crudosBotones.some((b) => /\{\{\d+\}\}/.test(texto(b?.url))) && !valorFijo("URL_1")) {
      noSoportada = "Tiene un botón con un enlace personalizado (guía o carrito) que Guardian no arma. Esta hay que mandarla desde el panel de chat.";
    }

    out.push({
      nombre: texto(c.name),
      categoria: texto(c.category).toUpperCase() || "UTILITY",
      idioma: texto(c.language) || "es",
      cuerpo, variables, botones, noSoportada,
    });
  }
  return out;
}

/**
 * El texto EXACTO que va a leer el cliente.
 *
 * Un hueco sin llenar NO se borra: queda visible como `[falta n]` para que en
 * la vista previa se vea el agujero. Un mensaje con un hueco vacío llega con
 * un espacio raro y parece un error del negocio; verlo antes es justamente el
 * punto de la vista previa.
 */
export function renderizar(cuerpo: string, valores: Record<number, string>): string {
  return cuerpo.replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const v = texto(valores[Number(n)]);
    return v || `[falta ${n}]`;
  });
}

/** Los huecos todavía vacíos. Vacío ⇒ se puede mandar. */
export function faltantes(p: PlantillaMeta, valores: Record<number, string>): number[] {
  return p.variables.filter((v) => !texto(valores[v.indice])).map((v) => v.indice);
}

/**
 * El payload EXACTO que va a recibir Meta.
 *
 * Vive acá, puro y probado, porque es la pieza donde un error no se ve: los
 * huecos son POSICIONALES, así que mandar los parámetros en el orden
 * equivocado no falla — le llega al cliente "tu pedido está en 7" en vez de
 * "en Servientrega Guayaquil", y nadie se entera. Por eso el orden se fija por
 * `v.indice` y no por el orden en que la pantalla armó el objeto.
 *
 * Solo se incluye el componente `body`, y solo si la plantilla tiene huecos:
 * es lo que Meta pide. Las partes fijas (título de texto, botones de respuesta
 * rápida) viajan solas con la plantilla y no llevan parámetros.
 */
export function construirPayloadMeta(
  p: PlantillaMeta,
  valores: Record<number, string>,
  destino: string,
): Record<string, unknown> {
  const componentes: Array<Record<string, unknown>> = [];
  if (p.variables.length > 0) {
    componentes.push({
      type: "body",
      parameters: [...p.variables]
        .sort((a, b) => a.indice - b.indice)
        .map((v) => ({ type: "text", text: texto(valores[v.indice]) })),
    });
  }
  return {
    messaging_product: "whatsapp",
    to: destino,
    type: "template",
    template: {
      name: p.nombre,
      language: { code: p.idioma || "es" },
      components: componentes,
    },
  };
}

// ── Sugerencia de relleno ───────────────────────────────────────────────────
// Reglas en tabla y en ORDEN (primera que matchea gana), mismo molde que
// `cancelTaxonomy.ts` y `novedadTaxonomy.ts`. Se prueba contra la ETIQUETA; si
// el cuerpo no etiquetó el hueco, se prueba contra el EJEMPLO de Meta.
//
// ⛔ No hay regla para "días"/"plazo" a propósito: ese número depende de la
// transportadora y del acuerdo, Guardian no lo sabe, y ponerle un 7 porque el
// ejemplo de Meta dice 7 sería inventarle un plazo a un cliente real.

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * ¿El ejemplo de Meta para este hueco es una URL? Entonces el hueco ES un link.
 *
 * ⛔ Esto NO es una precaución: es la reproducción de un bug que estuvo saliendo
 * a clientes reales (medido el 28-ago-2026 sobre la cuenta de Ecuador).
 * `guia_generada_v1` dice *"Puede seguir su envío en todo momento aquí 👉 {{3}}"*.
 * Ese hueco no lleva etiqueta (el texto no termina en dos puntos), así que la
 * sugerencia caía al EJEMPLO — que es
 * `https://www.servientrega.com.ec/Tracking/?...` — y esa URL **contiene la
 * palabra `tracking`**, que matchea la regla de guía. Al cliente le llegaba:
 *
 *     Puede seguir su envío en todo momento aquí 👉 V123456789
 *
 * Un número donde va un link. `zona_entrega_k1` era peor: en su hueco de link
 * ponía el NOMBRE DE LA TRANSPORTADORA (su URL de ejemplo trae "laarcourier",
 * que matchea la regla de agencia/courier).
 *
 * Se decide por el EJEMPLO, que es un hecho del dato, y no por la etiqueta
 * "tracking"/"rastreo"/"seguimiento": esas palabras sirven igual para el número
 * de guía, y adivinar cuál de las dos quiere el hueco es justo lo que rompió.
 */
const esUrl = (s: string) => /^https?:\/\//i.test(texto(s));

/**
 * Lo que el CUERPO dice justo antes del hueco, cuando no hay etiqueta.
 *
 * ── Por qué hizo falta (28-ago-2026) ────────────────────────────────────────
 * Medido sobre la cuenta de Ecuador: `retiro_agencia_v1` —la buena, la que
 * nombra al cliente y su producto y avisa que la agencia lo devuelve— **no se
 * podía mandar NUNCA**. Sus dos huecos salían vacíos:
 *
 *   "Estimado/a {{1}}, su {{2}} ya está esperándolo/a en la agencia…"
 *
 * `{{1}}` no lo agarraba el caso especial del saludo porque estaba escrito
 * `\{\{1\}\}` justo después de "Estimado/**a** " y la expresión pedía el hueco
 * pegado al saludo. Y `{{2}}` se probaba contra el EJEMPLO de Meta —"Gafas
 * Inteligentes G58"—, que es el VALOR de un producto y no la palabra
 * "producto", así que no matcheaba la regla de producto.
 *
 * Consecuencia: quedaba la única completable, `retiro_agencia_k1`, que le
 * escribe *"Estimado Cliente… retirado en agencia: SERVIENTREGA"* — sin nombre,
 * sin producto y sin decir a qué agencia ir. El desempate que se agregó el 27
 * de agosto para preferir la buena nunca llegó a aplicarse: sólo compite entre
 * las que se pueden completar, y la buena no lo era.
 *
 * ── Qué lee, y por qué no es adivinar ───────────────────────────────────────
 * Dos construcciones del español, sobre el texto REAL de la plantilla — la
 * misma idea que `etiquetaDe`, que lee lo que precede al hueco:
 *   - saludo + hueco  ("Hola {{1}}", "Estimado/a {{1}}")   → es el nombre
 *   - posesivo + hueco ("su {{2}}", "tu pedido de {{2}}")   → es el producto
 *
 * Y lo que NO cubre es tan importante: "tu orden {{2}}" (`en_transito_v2`) no
 * matchea, porque ahí `{{2}}` es el número de orden interno. Si el texto no lo
 * dice, se deja vacío.
 */
type CampoPista = "nombre" | "producto" | "guia" | "direccion" | "ciudad" | "transportadora" | "valor";

function pistaDelTexto(cuerpo: string, indice: number): CampoPista | null {
  const pos = cuerpo.indexOf(`{{${indice}}}`);
  if (pos < 0) return null;
  const antes = cuerpo.slice(Math.max(0, pos - 40), pos);
  if (/(hola|estimad[\p{L}/]*|apreciad[\p{L}/]*|buen[oa]s(\s+\p{L}+)?)[\s,¡!]*$/iu.test(antes)) return "nombre";
  if (/\b(su|tu|sus|tus)\s*$/iu.test(antes)) return "producto";
  if (/\b(pedido|orden|compra)\s+de\s*$/iu.test(antes)) return "producto";
  // ── Colombia habla en prosa, no con etiquetas (2-sep-2026) ────────────────
  // Las 28 plantillas aprobadas de la cuenta de Chatea Pro casi no usan la
  // forma "Etiqueta: {{n}}" que lee `etiquetaDe`, y Chatea Pro tampoco manda
  // los `example` de Meta: los que llegan son literalmente "w" y "qw". Con las
  // tres pistas de arriba solas, `sugerirValores` dejaba vacíos casi todos los
  // huecos y el botón de acción de Seguimiento se apagaba entero. Medido el
  // 2-sep-2026 sobre la cuenta real: de 11 fases, 8 sin ninguna plantilla que
  // Guardian pudiera completar.
  //
  // Estas cinco leen el SUSTANTIVO pegado al hueco — la misma idea de
  // `etiquetaDe`, sin exigir los dos puntos. Son deliberadamente literales:
  // cada una exige que el texto NOMBRE el dato, no que lo insinúe.
  //   "tu envío con guía {{2}}"                       → guía
  //   "en la dirección {{4}}" · "dirección registrada" → dirección
  //   "dirígete a X ciudad {{2}}"                      → ciudad
  //   "La transportadora {{2}}" · "oficina de {{3}}"   → transportadora
  //   "el valor a pagar es ${{4}}"                     → valor
  //
  // ⛔ Lo que NO cubren sigue siendo lo importante, y es la misma regla de
  // siempre: si el texto no lo dice, el hueco queda vacío y la plantilla se
  // salta. "tu orden {{2}}" no matchea nada (ahí va el número de orden
  // interno) y "indícanos: {{6}}" tampoco — eso es qué dato pedirle al
  // cliente, y depende de la novedad; inventarlo sería mandarle a un cliente
  // real una pregunta que nadie decidió.
  if (/\bgu[ií]a\s*#?\s*$/iu.test(antes)) return "guia";
  if (/\bdirecci[oó]n(\s+registrada)?\s*$/iu.test(antes)) return "direccion";
  if (/\bciudad\s*(de\s*)?$/iu.test(antes)) return "ciudad";
  if (/\b(transportadora|oficina\s+de)\s*$/iu.test(antes)) return "transportadora";
  if (/\$\s*$/.test(antes)) return "valor";
  return null;
}

/** Con qué dato del pedido se llena cada pista. */
const POR_PISTA: Record<CampoPista, (d: DatosPedido) => string> = {
  nombre: (d) => primerNombre(d.nombre),
  producto: (d) => texto(d.producto),
  guia: (d) => texto(d.guia),
  direccion: (d) => texto(d.direccion),
  ciudad: (d) => texto(d.ciudad),
  transportadora: (d) => texto(d.transportadora),
  valor: (d) => texto(d.valor),
};

interface Regla { prueba: RegExp; campo: (d: DatosPedido) => string }

const REGLAS: Regla[] = [
  { prueba: /agencia|oficina|sucursal|transportadora|courier/, campo: (d) => texto(d.transportadora) },
  { prueba: /guia|tracking|rastreo|numero de orden|num de orden|orden/, campo: (d) => texto(d.guia) },
  // "📍Dirección: {{6}}" (Ecuador) y "dirección registrada: {{3}}" (Colombia).
  { prueba: /direccion|domicilio/, campo: (d) => texto(d.direccion) },
  { prueba: /ciudad|destino|zona|provincia|canton/, campo: (d) => texto(d.ciudad) },
  { prueba: /valor|total|precio|monto|pagar|efectivo/, campo: (d) => texto(d.valor) },
  { prueba: /producto|articulo|pedido de/, campo: (d) => texto(d.producto) },
  { prueba: /nombre|cliente|estimad|hola/, campo: (d) => primerNombre(d.nombre) },
];

/**
 * Con qué llenar cada hueco, según los datos del pedido.
 *
 * Es una SUGERENCIA, no un veredicto: lo que no se puede deducir queda vacío y
 * la asesora lo escribe. Devuelve solo lo que pudo resolver.
 */
function porReglas(contra: string, d: DatosPedido): string {
  if (!contra) return "";
  for (const r of REGLAS) if (r.prueba.test(contra)) return r.campo(d);
  return "";
}

export function sugerirValores(p: PlantillaMeta, d: DatosPedido): Record<number, string> {
  const out: Record<number, string> = {};
  for (const v of p.variables) {
    // ── En orden de qué tan confiable es la señal ───────────────────────────
    // 1. Hueco de LINK: se llena con el link, o con nada. Va PRIMERO porque una
    //    URL de rastreo contiene "tracking" y "courier", y cualquiera de esas
    //    dos se lo roba. Sin link real queda vacío: la plantilla no se puede
    //    completar y el botón la salta — que es lo correcto. Mandar la guía
    //    suelta ahí es peor que no mandar el mensaje.
    if (esUrl(v.ejemplo || "") || /\b(link|enlace|url)\b/.test(sinTildes(v.etiqueta || ""))) {
      const u = texto(d.rastreoUrl);
      if (u) out[v.indice] = u;
      continue;
    }
    // 2. Etiqueta con dos puntos ("Agencia: {{2}}"): el cuerpo NOMBRA el hueco.
    //    Es lo más fuerte que hay, y por eso gana antes que cualquier pista.
    if (v.etiqueta) {
      const val = porReglas(sinTildes(v.etiqueta), d);
      if (val) out[v.indice] = val;
      continue;
    }
    // 3. Lo que dice el texto justo antes ("Hola {{1}}", "su {{2}}").
    const pista = pistaDelTexto(p.cuerpo, v.indice);
    if (pista) {
      const val = POR_PISTA[pista](d);
      if (val) out[v.indice] = val;
      continue;
    }
    // 4. Último recurso: el ejemplo que guardó Meta. Es el más débil —es un
    //    VALOR, no el nombre del campo— y por eso quedó al final.
    const val = porReglas(sinTildes(v.ejemplo || ""), d);
    if (val) out[v.indice] = val;
  }
  return out;
}

// ── Qué plantilla ofrecer primero ───────────────────────────────────────────
// La lista tiene 31 y la asesora tiene 40 pedidos: mostrarlas todas en el mismo
// orden que las devuelve Meta es lo mismo que no ordenarlas. Se suben las que
// hablan de la situación EN LA QUE ESTÁ el paquete.

// ⛔ Las claves son valores de `SegStatusKey` (src/lib/segStatus.ts). Una clave
// que no exista ahí NO falla: simplemente nunca dispara, en silencio.
//
// Pasó con `pendiente` (27-ago-2026): no es una fase. Ese arreglo cambió la
// clave muerta por `procesamiento` **dando por hecho** que ahí caía un
// `PENDIENTE CONFIRMACION` — y NO cae: `segStatus.ts` lo manda a `otros` a
// propósito (ver `OTROS_ESPERADOS`; no es una fase de Seguimiento, es la cola
// de Confirmar). Medido el 30-ago-2026 ejecutando la función:
//   classifySegEstado('PENDIENTE CONFIRMACION') === 'otros'
//   classifySegEstado('PENDIENTE')              === 'procesamiento'
// O sea: durante meses la pantalla de Confirmar ordenó las plantillas
// ALFABÉTICAMENTE, con `confirmacion` y `reconfirmacion` separadas por
// `en_transito` y `novedad` en el medio — lo que reportó el dueño.
//
// ⛔ NO se arregla agregando una clave `otros` acá: en `otros` cae TAMBIÉN
// cualquier estado que Dropi invente y nadie haya clasificado, y a ese no hay
// que ofrecerle plantillas de confirmación (podría estar en tránsito). La
// traducción se hace ANTES, en `faseParaPlantillas` (src/lib/accionSeguimiento),
// que reconoce la cola de Confirmar por su estado real y la manda a
// `procesamiento`, que es la fila de acá abajo con la regex correcta.
const POR_FASE: Record<string, RegExp> = {
  oficina: /retiro_agencia|retiro|agencia/,
  novedad: /novedad/,
  novedad_sol: /novedad/,
  reparto: /zona_entrega|en_transito|transito|reparto/,
  transito: /en_transito|transito|zona_entrega/,
  guia: /guia_generada|antes_generar_guia|ecommerce/,
  bodega_trans: /guia_generada|en_transito|transito/,
  procesamiento: /confirmacion|reconfirmacion|direccion_incompleta|antes_generar_guia/,
  rechazado: /rescate|ultima_oportunidad|novedad/,
  devolucion: /rescate|seguimiento_reactivar|remarketing|novedad/,
  devolucion_transito: /rescate|seguimiento_reactivar|remarketing|novedad/,
};

/**
 * Ordena las plantillas para ESTE pedido: primero las que pegan con su fase,
 * después el resto. No esconde ninguna — esconder una plantilla aprobada sería
 * decidir por la asesora con una regexp.
 */
export function ordenarParaFase(plantillas: PlantillaMeta[], fase?: string | null): PlantillaMeta[] {
  const re = POR_FASE[texto(fase)] ?? null;
  const puntaje = (p: PlantillaMeta) => {
    let n = 0;
    if (re && re.test(sinTildes(p.nombre))) n -= 100;
    // A igualdad, primero UTILITY: es la de logística, la más barata y la que
    // Meta menos restringe. MARKETING a un cliente que no escribió es otra cosa.
    if (p.categoria === "UTILITY") n -= 10;
    // Las de prueba al fondo: no le sirven a nadie y ensucian la lista.
    if (/prueba|test/.test(sinTildes(p.nombre))) n += 1000;
    return n;
  };
  return [...plantillas].sort((a, b) => puntaje(a) - puntaje(b) || a.nombre.localeCompare(b.nombre));
}
