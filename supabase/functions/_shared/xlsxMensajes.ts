// Lector del export de mensajes de ImporChat (XLSX) — la pieza que ya mató dos
// veces a `importchat-sync`.
//
// ── Por qué vive acá y no dentro de la edge function ────────────────────────
// `vitest.config.ts` solo mira `src/**`, así que las pruebas de las edge
// functions NUNCA corren. Este parser lleva dos incidentes encima y jamás tuvo
// una sola prueba. Ahora la lógica pura está acá y se testea desde
// `src/lib/xlsxMensajes.test.ts`, cruzando el límite — el mismo patrón de
// `autoPushSelect` y `walletCategoria`.
//
// ── Los dos incidentes ──────────────────────────────────────────────────────
// 1. (24-ago-2026) Se abría con SheetJS: `XLSX.read` + `sheet_to_json`
//    materializaba 48.000 objetos de 18 campos y la plataforma mataba la
//    función. 7 disparos, 7 muertes mudas, cero rastro en sync_logs.
// 2. (28-ago-2026) Medido sobre 197 corridas de 4 días: **82 colgadas (42%) y
//    CERO errores**. Todas murieron en el mismo punto —«fase 2: bajando y
//    leyendo el XLSX»— y sin `catch`, que es la firma de un límite de la
//    plataforma, no de una excepción. Repartidas PAREJO en las 24 horas: a las
//    3 de la mañana, con ImporChat vacío, se colgaba igual que a las 3 de la
//    tarde. O sea: no era ImporChat lento, era esta función pasándose de
//    presupuesto. Corrida a mano tarda 18 s; el límite se cruzaba por poco, y
//    el archivo crece todos los días.
//
// ── Qué se hizo, y por qué esto es lo que baja el costo ─────────────────────
// El export trae **18 columnas** y de acá se leen **6**. El parser anterior
// procesaba las 18 de las 48.000 filas: ~864.000 celdas, y a CADA una le
// corría `desescapar`, que son 6 `String.replace` con regex → más de 5 millones
// de regex por corrida, dos tercios de ellas para tirar el valor a la basura.
// Ahora:
//   · se leen SOLO las columnas necesarias (se saltea por letra, sin tocar la
//     celda: 12 de cada 18 mueren en un `Map.get`);
//   · `desescapar` corta en seco si no hay un `&` (la enorme mayoría);
//   · el texto se recorta ANTES de desescapar (los cuerpos de mensaje son lo
//     único largo del archivo);
//   · no se reconstruye un string `<c …>…</c>` por celda para volver a
//     parsearlo — eso eran ~864.000 strings al pedo.
//
// Y sobre todo: **ahora hay un vencimiento**. La lectura se corta y AVISA en
// vez de dejar que la plataforma la mate sin dejar rastro. Una fila `running`
// que nunca cierra es indistinguible de "no corrió".

import type { MensajeChat } from "./senalConfirmacion.ts";

/** Las ÚNICAS columnas que alguien lee. Todo lo demás del export se saltea. */
export const COLUMNAS_USADAS = [
  "ID Receptor",   // el cliente es SIEMPRE el receptor, incluso en sus propias filas
  "Fecha Mensaje",
  "Tipo Mensaje",
  "Texto Mensaje", // solo importa en los botones ("CONFIRMAR PEDIDO")
  "Rol",
  "Template",
] as const;

/** Los textos se recortan al guardarlos: lo único que se lee entero es el botón. */
export const MAX_TEXTO = 64;
/** Margen para recortar ANTES de desescapar sin partir una entidad (`&#128512;`
 *  son 9 caracteres que valen 1). 8× es holgado y acota el trabajo por celda. */
const MARGEN_ESCAPES = 8;

/** Se lanza cuando la lectura se pasó del presupuesto. Es un error EXPLÍCITO a
 *  propósito: muere con mensaje y queda en `sync_logs`, en vez de que la mate
 *  la plataforma y la corrida quede en `running` para siempre. */
export class LecturaVencida extends Error {
  constructor(public filasLeidas: number) {
    super(`Se acabó el tiempo leyendo el XLSX (${filasLeidas} filas leídas)`);
    this.name = "LecturaVencida";
  }
}

/** `<c …>` con contenido o auto-cerrada. Grupo 1 = atributos, grupo 2 = interior. */
const CELDA_RE = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
const FILA_RE = /<row[^>]*>([\s\S]*?)<\/row>/g;
const T_RE = /<t[^>]*>([\s\S]*?)<\/t>/g;
const V_RE = /<v[^>]*>([\s\S]*?)<\/v>/;

/** Desescapa XML. ⛔ El `indexOf` NO es una micro-optimización cosmética: sin él
 *  esto son 6 regex por celda sobre ~864.000 celdas. La enorme mayoría de los
 *  valores (fechas, ids, tipos) no tienen un solo `&`. */
export function desescapar(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** Recorta y desescapa, en ese orden. */
function texto(s: string, maxTexto: number): string {
  const crudo = s.length > maxTexto * MARGEN_ESCAPES ? s.slice(0, maxTexto * MARGEN_ESCAPES) : s;
  return desescapar(crudo).slice(0, maxTexto);
}

/** Letra de columna de `r="AB123"`, sin regex: se llama una vez por celda. */
export function letraDeRef(attrs: string): string {
  const i = attrs.indexOf('r="');
  if (i < 0) return "";
  let j = i + 3;
  let out = "";
  for (; j < attrs.length; j++) {
    const c = attrs.charCodeAt(j);
    if (c < 65 || c > 90) break; // no es A-Z → empiezan los dígitos de la fila
    out += attrs[j];
  }
  return out;
}

/** Valor del atributo `t` de una celda (`s` = tabla compartida, `inlineStr`, …). */
function tipoDeCelda(attrs: string): string {
  const i = attrs.indexOf('t="');
  if (i < 0) return "";
  const j = attrs.indexOf('"', i + 3);
  return j < 0 ? "" : attrs.slice(i + 3, j);
}

/**
 * Serial de Excel (días desde 1899-12-30) → Date UTC real. 25569 = días entre
 * esa época y 1970-01-01.
 *
 * ⚠️ Las fechas de este export son SERIALES EN UTC (verificado en vivo el
 * 24-ago-2026: 46258,8687 = 20:50 UTC = 15:50 local EC). Una versión anterior
 * les pasaba el serial numérico a un parser de TEXTO: devolvía null para todas
 * las filas, el historial quedaba vacío y cada pedido salía "sin_dato" sin un
 * solo error visible.
 */
export function serialAFecha(v: string): Date | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 20000 || n > 90000) return null;
  return new Date(Math.round((n - 25569) * 86400000));
}

/** Tabla de textos compartidos. Este export NO la usa (cada mensaje viaja en su
 *  celda), pero se soporta por si cambia el generador. */
export function parsearSharedStrings(raw: Uint8Array | undefined, maxTexto = MAX_TEXTO): string[] {
  if (!raw) return [];
  // Decoder propio: mezclar un `decode()` de una sola vez con los `decode(…,
  // {stream:true})` de la hoja sobre la MISMA instancia es un bug latente.
  const ss = new TextDecoder().decode(raw);
  const out: string[] = [];
  for (const si of ss.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) {
    if (si[1] === undefined) { out.push(""); continue; }
    let s = "";
    for (const t of si[1].matchAll(T_RE)) s += t[1];
    out.push(texto(s, maxTexto));
  }
  return out;
}

export interface ResultadoHoja {
  porChat: Map<string, MensajeChat[]>;
  /** Filas de datos leídas (sin contar el encabezado). */
  filas: number;
  /** Chats DISTINTOS que aparecieron en el archivo, se hayan guardado o no.
   *  Con `soloEstosChats` puesto, `porChat.size` es mucho menor que esto — y la
   *  diferencia es justamente lo que se dejó de cargar en memoria. */
  chatsVistos: number;
  /**
   * Se vieron celdas `t="s"` pero la tabla de textos compartidos llegó vacía:
   * el export cambió de formato y los valores saldrían en blanco EN SILENCIO.
   * Se reporta para que el llamador lo grite, no para adivinar.
   */
  sharedFaltante: boolean;
}

export interface OpcionesHoja {
  /** `Date.now()` a partir del cual se corta con `LecturaVencida`. */
  vencimiento?: number;
  maxTexto?: number;
  /** Tamaño del trozo de decodificación. Solo para las pruebas. */
  chunk?: number;
  /**
   * ⛔ Guardar SOLO los chats de esta lista. La palanca de memoria más grande
   * que hay acá (28-ago-2026).
   *
   * El export trae la historia COMPLETA de la cuenta —5.918 chats medidos en
   * Ecuador— pero el sync solo consulta `chats.get(p.chatId)` para los ~1.316
   * pedidos de su ventana. Los otros ~4.600 chats se cargaban enteros en
   * memoria para no leerlos NUNCA: 78% del mapa era peso muerto dentro de un
   * worker al que la plataforma ya le contestaba `WORKER_RESOURCE_LIMIT`.
   *
   * Sin la lista se guarda todo (es lo que hacen las pruebas y cualquier
   * llamador que quiera el archivo entero).
   */
  soloEstosChats?: ReadonlySet<string>;
}

/** Lector incremental: se le van empujando trozos de la hoja y al final devuelve
 *  lo acumulado. Ver `crearLectorHoja`. */
export interface LectorHoja {
  /** Un trozo de `sheet1.xml` (no hace falta que corte en un límite de fila ni
   *  de carácter UTF-8: el lector guarda la cola parcial). */
  empujar(trozo: Uint8Array): void;
  fin(): ResultadoHoja;
}

/**
 * Crea un lector al que se le empujan trozos de la hoja SIN tenerla entera en
 * memoria.
 *
 * ⛔ Ésta es la razón de ser del módulo (28-ago-2026). La plataforma responde
 * **HTTP 546 `WORKER_RESOURCE_LIMIT` — "not having enough compute resources"**
 * al correr esto: no es una inferencia, lo dice el error. La hoja
 * descomprimida son 55 MB y el zip otros 9; materializarlos dentro de un worker
 * chico es la mitad del problema (la otra mitad, el costo de CPU del parseo,
 * está resuelta más abajo leyendo solo 6 de las 18 columnas).
 *
 * Con este lector el zip se descomprime EN FLUJO y la memoria queda acotada por
 * el trozo, no por el archivo: lo único que crece es el mapa por chat.
 *
 * ⚠️ `shared` se guarda por REFERENCIA a propósito: en flujo, la tabla de textos
 * puede llegar después de crearse el lector. Llenar ese mismo array antes de
 * empujar la hoja alcanza.
 */
export function crearLectorHoja(shared: string[], opts: OpcionesHoja = {}): LectorHoja {
  const maxTexto = opts.maxTexto ?? MAX_TEXTO;
  const vencimiento = opts.vencimiento ?? Number.POSITIVE_INFINITY;
  const soloEstos = opts.soloEstosChats;

  const porChat = new Map<string, MensajeChat[]>();
  /** Chats distintos vistos, se guarden o no — para poder decir cuánto se descartó. */
  const vistos = new Set<string>();
  /** letra de columna → nombre, SOLO de las columnas que se usan. */
  let necesarias: Map<string, string> | null = null;
  let filas = 0;
  let sharedFaltante = false;

  const valorDeCelda = (attrs: string, interior: string | undefined): string => {
    if (interior === undefined) return "";
    const t = tipoDeCelda(attrs);
    if (t === "inlineStr") {
      let s = "";
      for (const x of interior.matchAll(T_RE)) s += x[1];
      return texto(s, maxTexto);
    }
    const m = V_RE.exec(interior);
    if (!m) return "";
    if (t === "s") {
      const idx = Number(m[1]);
      if (!shared.length) sharedFaltante = true;
      return shared[idx] ?? "";
    }
    return texto(m[1], maxTexto);
  };

  const procesarFila = (interior: string) => {
    if (!necesarias) {
      // Fila 1 = encabezados. Se parsea ENTERA, una sola vez, y se mapea por
      // NOMBRE y no por posición: el día que ImporChat agregue una columna al
      // medio, esto sigue funcionando.
      const porLetra: Record<string, string> = {};
      for (const c of interior.matchAll(CELDA_RE)) {
        const L = letraDeRef(c[1] ?? "");
        if (L) porLetra[L] = valorDeCelda(c[1] ?? "", c[2]);
      }
      necesarias = new Map();
      const usadas = new Set<string>(COLUMNAS_USADAS);
      for (const [L, nombre] of Object.entries(porLetra)) {
        const n = nombre.trim();
        if (usadas.has(n)) necesarias.set(L, n);
      }
      return;
    }
    filas++;
    // ⛔ Acá muere el 67% del trabajo: las 12 columnas que nadie lee no llegan
    // ni a `valorDeCelda`.
    const v: Record<string, string> = {};
    for (const c of interior.matchAll(CELDA_RE)) {
      const attrs = c[1] ?? "";
      const nombre = necesarias.get(letraDeRef(attrs));
      if (!nombre) continue;
      v[nombre] = valorDeCelda(attrs, c[2]);
    }

    // El cliente es SIEMPRE el Receptor, incluso en las filas que escribió él.
    // Cruzar por "Emisor" da cero coincidencias y la señal sale vacía sin
    // ningún error visible — trampa ya pagada.
    const chat = (v["ID Receptor"] ?? "").trim();
    const fecha = serialAFecha(v["Fecha Mensaje"] ?? "");
    if (!chat || !fecha) return;
    vistos.add(chat);
    // ⛔ El chat que a nadie le interesa NO se guarda. Ver `soloEstosChats`:
    // eran ~4.600 de 5.918 conversaciones cargadas enteras en memoria para no
    // consultarlas jamás.
    if (soloEstos && !soloEstos.has(chat)) return;
    const tipo = v["Tipo Mensaje"] ?? "";
    const arr = porChat.get(chat) ?? [];
    arr.push({
      rol: v["Rol"] ?? "",
      tipo,
      // Solo los botones necesitan texto (para leer "CONFIRMAR"). El resto va
      // vacío a propósito: es la diferencia entre caber en memoria y no caber.
      texto: tipo === "button" ? (v["Texto Mensaje"] ?? "") : "",
      plantilla: v["Template"] || null,
      fecha,
    });
    porChat.set(chat, arr);
  };

  // `{stream:true}` en cada trozo: un carácter UTF-8 partido entre dos trozos
  // se reconstruye solo. Decoder propio de esta instancia — mezclar un
  // `decode()` de una sola vez con los de flujo sobre la MISMA instancia es un
  // bug latente.
  const dec = new TextDecoder();
  let resto = "";

  return {
    empujar(trozo: Uint8Array) {
      // El vencimiento se mira una vez por trozo: barato, y convierte una
      // muerte muda en un error con mensaje.
      if (Date.now() > vencimiento) throw new LecturaVencida(filas);
      const buf = resto + dec.decode(trozo, { stream: true });
      const corte = buf.lastIndexOf("</row>");
      // Sin una fila completa todavía: se guarda entero y se espera al próximo.
      if (corte < 0) { resto = buf; return; }
      // Un solo matchAll por trozo: recortar fila por fila del buffer copiaría
      // el trozo entero por cada una de las 48.000 filas.
      for (const m of buf.slice(0, corte + 6).matchAll(FILA_RE)) procesarFila(m[1]);
      resto = buf.slice(corte + 6);
    },
    fin(): ResultadoHoja {
      resto += dec.decode(); // cierra cualquier secuencia UTF-8 a medias
      for (const m of resto.matchAll(FILA_RE)) procesarFila(m[1]);
      resto = "";
      for (const arr of porChat.values()) arr.sort((a, b) => a.fecha.getTime() - b.fecha.getTime());
      return { porChat, filas, chatsVistos: vistos.size, sharedFaltante };
    },
  };
}

/**
 * Lee una hoja que YA está entera en memoria. Envoltorio sobre
 * `crearLectorHoja` — lo usan las pruebas y cualquier llamador que no pueda
 * trabajar en flujo. En la edge function se usa el lector directo, que es el
 * que evita tener los 55 MB adentro.
 */
export function leerHojaMensajes(
  hojaRaw: Uint8Array,
  shared: string[],
  opts: OpcionesHoja = {},
): ResultadoHoja {
  const CHUNK = opts.chunk ?? (1 << 20);
  const lector = crearLectorHoja(shared, opts);
  for (let off = 0; off < hojaRaw.length; off += CHUNK) {
    lector.empujar(hojaRaw.subarray(off, Math.min(off + CHUNK, hojaRaw.length)));
  }
  return lector.fin();
}
