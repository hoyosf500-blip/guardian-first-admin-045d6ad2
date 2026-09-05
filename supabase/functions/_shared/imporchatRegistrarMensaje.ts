/**
 * Deja el mensaje ENVIADO escrito en la conversación de ImporChat.
 *
 * ⛔ ESTE ARCHIVO ES EL ARREGLO DEL BUG QUE REPORTÓ EL OPERADOR.
 *
 * ── Lo que de verdad pasaba (medido el 4-sep-2026 de noche) ────────────────
 * El operador lo dijo con precisión: *"envían la plantilla pero la plantilla no
 * llega a ImporChat"*. Era literal, y nosotros le agregamos una conclusión que
 * NO era suya y resultó falsa: "por ende no llega al cliente".
 *
 * Las plantillas SÍ llegaban al cliente. Prueba: se le mandó `en_transito_v2` a
 * Ariana Cárdenas (#6856013) y ella contestó apretando el botón **"Perfecto"**
 * — que es el único botón "Perfecto" de las 46 plantillas de la cuenta. O sea
 * que tuvo el mensaje en la mano. Y sin embargo el hilo no lo mostraba.
 *
 * ── Por qué faltaba ────────────────────────────────────────────────────────
 * Mandar una plantilla por la API son DOS llamadas, no una. Leído del bundle
 * del propio panel de ImporChat:
 *
 *   1. `whatsapp_managment/enviar_template_masivo`  → Meta la entrega.
 *   2. `clientes_chat_center/agregarMensajeEnviado` → queda en la conversación.
 *
 * Su propio catch lo dice con todas las letras: *"Meta OK, pero falló guardar
 * en BD"*. Guardian hacía la 1 y nunca la 2. Por eso el mensaje salía y el hilo
 * quedaba mudo — y por eso el espejo `orders.chat_saliente_at`, que se alimenta
 * de ese hilo, tampoco se movía.
 *
 * El texto libre nunca tuvo el problema porque va por SOCKET (`SEND_MESSAGE`) y
 * ahí el servidor de ImporChat persiste solo. De ahí que el equipo dijera
 * "los mensajes escritos sí se mandan, las plantillas no".
 *
 * Verificado de punta a punta esa misma noche: se escribió el mensaje de Ariana
 * con esta llamada y apareció en el hilo (`de:"negocio"`, `tipo:"template"`).
 */

/** Lo que hace falta de la conexión para poder registrar el mensaje. */
export interface ConexionIC {
  /** El número del negocio, como lo guarda ImporChat (`593…`). */
  telefono: string | null;
  /** El id del teléfono en Meta. El panel lo manda como `mid_mensaje`. */
  idTelefono: string | null;
}

/**
 * El id que devuelve Meta cuando ACEPTA el mensaje. Es la única prueba real de
 * que la plantilla salió: `success:true` a secas solo dice que ImporChat
 * recibió el pedido, y esa confusión es la que costó once días de envíos que
 * nadie sabía si existían.
 *
 * Se leen las tres formas que mira el panel, en su mismo orden.
 */
export function wamidDe(datos: Record<string, unknown> | null): string | null {
  if (!datos) return null;
  if (typeof datos.wamid === "string" && datos.wamid) return datos.wamid;
  const data = datos.data as { messages?: Array<{ id?: unknown }> } | undefined;
  const porData = data?.messages?.[0]?.id;
  if (typeof porData === "string" && porData) return porData;
  const propios = (datos.messages as Array<{ id?: unknown }> | undefined)?.[0]?.id;
  return typeof propios === "string" && propios ? propios : null;
}

/** El `id_usuario` vive dentro del JWT de sesión: no hace falta guardarlo. */
export function idUsuarioDelToken(token: string): number | null {
  try {
    const p = token.split(".")[1];
    if (!p) return null;
    const b64 = p.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const payload = JSON.parse(atob(b64 + pad)) as Record<string, unknown>;
    const id = payload.id_usuario;
    return typeof id === "number" ? id : (typeof id === "string" ? Number(id) || null : null);
  } catch {
    return null;
  }
}

/** El nombre con el que ImporChat firma el mensaje en el hilo. */
export function encargadoDelToken(token: string): string | null {
  try {
    const p = token.split(".")[1];
    if (!p) return null;
    const b64 = p.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const payload = JSON.parse(atob(b64 + pad)) as Record<string, unknown>;
    const n = payload.nombre_encargado ?? payload.nombre;
    return typeof n === "string" && n.trim() ? n.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Los datos de la conexión, cacheados por (idConf) mientras viva la instancia.
 *
 * Es una llamada más por arranque en frío, no por envío: la lista cambia cuando
 * alguien conecta o desconecta un número, o sea casi nunca.
 */
const cacheConexion = new Map<string, { at: number; datos: ConexionIC }>();
const CACHE_MS = 10 * 60_000;

export async function datosDeConexion(
  post: (ruta: string, cuerpo: unknown) => Promise<{ ok: boolean; datos: Record<string, unknown> | null; detalle: string }>,
  token: string,
  idConf: string | number,
): Promise<ConexionIC> {
  const clave = String(idConf);
  const guardado = cacheConexion.get(clave);
  if (guardado && Date.now() - guardado.at < CACHE_MS) return guardado.datos;

  // ⛔ Cada salida en vacío se DICE. Degradar en silencio es la familia de la
  // que salió este bug: el mensaje se registraría con dos campos en null y
  // nadie se enteraría hasta que alguien mirara un hilo raro semanas después.
  // No se cachea el vacío a propósito: así el próximo envío vuelve a intentar.
  const vacio = (motivo: string): ConexionIC => {
    console.warn(`[plantilla] sin datos de la conexión ${clave} (${motivo}): el mensaje se registra igual, con teléfono y mid en null`);
    return { telefono: null, idTelefono: null };
  };
  const idUsuario = idUsuarioDelToken(token);
  if (idUsuario == null) return vacio("el token de sesión no trae id_usuario");

  const r = await post("configuraciones/listar_conexiones", { id_usuario: idUsuario });
  if (!r.ok || !r.datos) return vacio(`listar_conexiones falló: ${r.detalle || "sin cuerpo"}`);
  const lista = (r.datos.data ?? r.datos.conexiones ?? r.datos) as unknown;
  if (!Array.isArray(lista)) return vacio("listar_conexiones no devolvió una lista");
  const fila = lista.find((x) => String((x as Record<string, unknown>)?.id) === clave) as
    | Record<string, unknown>
    | undefined;
  // Verificado el 4-sep-2026 contra la cuenta real: la lista trae 13 conexiones
  // y la 277 (Rushmira Ecuador) está ahí, con `telefono` de 12 dígitos e
  // `id_telefono` de 15. Si un día el token es de otro usuario, esto avisa.
  if (!fila) return vacio(`la conexión no está entre las ${lista.length} del usuario`);

  const datos: ConexionIC = {
    telefono: fila.telefono == null ? null : String(fila.telefono),
    idTelefono: fila.id_telefono == null ? null : String(fila.id_telefono),
  };
  cacheConexion.set(clave, { at: Date.now(), datos });
  return datos;
}

/**
 * Cómo se guarda el cuerpo de una plantilla (leído del panel, del camino de
 * "reenviar", que es el que vuelve a armar el payload de Meta a partir de esto):
 *
 *  - `texto_mensaje` va **con los `{{n}}` puestos**, no renderizado. El panel
 *    hace `texto.matchAll(/{{(.*?)}}/g)` para saber cuántos parámetros tiene.
 *  - `ruta_archivo` NO es un archivo: es el JSON con los valores.
 *    Ver la memoria `importchat_ruta_archivo_no_es_archivo`.
 */
export function cuerpoDeRegistro(opts: {
  cuerpoPlantilla: string;
  nombrePlantilla: string;
  idioma: string;
  valores: Record<number | string, string>;
  telefonoDestino: string;
  chatId: string | number;
  idConf: string | number;
  conexion: ConexionIC;
  wamid: string;
  encargado: string | null;
}): Record<string, unknown> {
  const placeholders: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.valores)) placeholders[String(k)] = String(v ?? "");

  return {
    texto_mensaje: opts.cuerpoPlantilla,
    tipo_mensaje: "template",
    ruta_archivo: JSON.stringify({
      placeholders,
      header: null,
      template_name: opts.nombrePlantilla,
      language: opts.idioma,
    }),
    telefono_recibe: opts.telefonoDestino,
    // `id_recibe` es el MISMO id que Guardian ya guarda en
    // `orders.importchat_chat_id`: comprobado contra
    // `clientes_chat_center/buscar_id_recibe`, que devolvió 789999 para el chat
    // 789999. No hace falta una llamada extra.
    id_recibe: opts.chatId,
    id_configuracion: opts.idConf,
    telefono_configuracion: opts.conexion.telefono,
    mid_mensaje: opts.conexion.idTelefono,
    responsable: opts.encargado,
    id_wamid_mensaje: opts.wamid,
    template_name: opts.nombrePlantilla,
    language_code: opts.idioma,
    meta_media_id: null,
  };
}
