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
  producto?: string | null;
  valor?: string | null;
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
    const header = componentes.find((x) => texto(x?.type).toUpperCase() === "HEADER");
    const formatoHeader = texto(header?.format).toUpperCase();
    let noSoportada: string | null = null;
    if (["IMAGE", "VIDEO", "DOCUMENT"].includes(formatoHeader)) {
      noSoportada = `Lleva ${formatoHeader === "IMAGE" ? "una imagen" : formatoHeader === "VIDEO" ? "un video" : "un archivo"} adjunto. Esta se manda desde ImporChat.`;
    } else if (formatoHeader === "TEXT" && /\{\{\d+\}\}/.test(texto(header?.text))) {
      noSoportada = "Su título lleva un dato variable que Guardian todavía no llena. Esta se manda desde ImporChat.";
    } else if (crudosBotones.some((b) => /\{\{\d+\}\}/.test(texto(b?.url)))) {
      noSoportada = "Tiene un botón con un enlace personalizado (guía o carrito) que Guardian no arma. Esta se manda desde ImporChat.";
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

interface Regla { prueba: RegExp; campo: (d: DatosPedido) => string }

const REGLAS: Regla[] = [
  { prueba: /agencia|oficina|sucursal|transportadora|courier/, campo: (d) => texto(d.transportadora) },
  { prueba: /guia|tracking|rastreo|numero de orden|num de orden|orden/, campo: (d) => texto(d.guia) },
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
export function sugerirValores(p: PlantillaMeta, d: DatosPedido): Record<number, string> {
  const out: Record<number, string> = {};
  for (const v of p.variables) {
    // Caso especial y muy común: el primer hueco de un saludo ("Hola {{1}},")
    // es el nombre. No lleva dos puntos, así que ninguna etiqueta lo cubre.
    if (v.indice === 1 && !v.etiqueta && /(hola|estimad|buen[oa]s?)\s*\{\{1\}\}/i.test(sinTildes(p.cuerpo))) {
      const n = primerNombre(d.nombre);
      if (n) out[1] = n;
      continue;
    }
    const contra = sinTildes(v.etiqueta || v.ejemplo || "");
    if (!contra) continue;
    for (const r of REGLAS) {
      if (r.prueba.test(contra)) {
        const val = r.campo(d);
        if (val) out[v.indice] = val;
        break;
      }
    }
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
// Pasó con `pendiente` (arreglado 27-ago-2026): no es una fase — un
// `PENDIENTE CONFIRMACION` clasifica como `procesamiento`, y lo que no encaja
// en ninguna cae en `otros`. Durante meses las plantillas de confirmación y
// remarketing nunca se subieron por fase, y nadie se enteró porque la lista
// igual se mostraba entera, solo que mal ordenada.
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
