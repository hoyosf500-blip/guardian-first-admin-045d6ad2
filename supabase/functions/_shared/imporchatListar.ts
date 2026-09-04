/**
 * Listado LIVIANO de chats de ImporChat (3-sep-2026).
 *
 * `importchat-sync` bajaba `configuraciones/exportar_mensajes_xlsx` —9 MB, la
 * historia entera de la cuenta— cada 30 min, y ~1 de cada 6 corridas moría por
 * memoria o reloj (medido: 42% el 28-ago, 1/6 el 3-sep tras los arreglos).
 * `clientes_chat_center/listar` devuelve, por chat, el ÚLTIMO mensaje (cuándo,
 * de quién, qué tipo, qué texto). Con eso alcanza para todo lo que la
 * operación mira minuto a minuto: quién habló último y cuándo, si apretó el
 * botón de confirmar, si escribió. El XLSX queda para reconciliar una vez por
 * noche y como respaldo si esto falla.
 *
 * ⛔ La forma exacta del JSON NO está verificada en vivo al escribir esto: se
 * conocen los nombres de los campos por la documentación del proyecto
 * (`ultimo_mensaje_at`, `ultimo_rol_mensaje`, `celular_cliente`, `chat_cerrado`)
 * y por el esquema de mensajes del socket (`rol_mensaje` 0=cliente 1=negocio,
 * `texto_mensaje`, `tipo_mensaje`, `created_at`). `interpretarFila` acepta las
 * variantes razonables y, si NINGUNA fila trae id + fecha, `traerUltimosMensajes`
 * devuelve la muestra de claves para que quien lo lea en sync_logs sepa qué
 * mandó ImporChat — y el sync cae al XLSX en vez de inventar. El modo
 * `probe_listar` del sync devuelve las filas crudas para mirarlas.
 *
 * Puro salvo `traerUltimosMensajes` (fetch). Probado desde
 * `src/lib/imporchatListar.test.ts`.
 */

export interface UltimoMensajeChat {
  chatId: string;
  /** Instante del último mensaje, en UTC. */
  at: Date;
  /** Misma vara que `MensajeChat.rol` del XLSX. */
  rol: "Cliente" | "Propietario" | "otro";
  tipo: string;
  texto: string;
}

const OFFSET_HORAS: Record<string, number> = { EC: -5, CO: -5, GT: -6 };

/** "2026-08-21 20:18:23" (hora local del país) o ISO con zona → Date UTC. */
export function fechaListar(v: unknown, cc: string): Date | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    // epoch en segundos o ms
    return new Date(v < 1e12 ? v * 1000 : v);
  }
  const s = String(v).trim();
  if (!s) return null;
  // Con zona explícita (Z o ±hh:mm): Date.parse ya la resuelve.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) && s.includes("T")) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t) : null;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t) : null;
  }
  const local = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const off = OFFSET_HORAS[cc] ?? -5;
  return new Date(local - off * 3600_000);
}

function primero(row: Record<string, unknown>, claves: string[]): unknown {
  for (const k of claves) {
    if (row[k] != null && row[k] !== "") return row[k];
  }
  return undefined;
}

export function rolListar(v: unknown): UltimoMensajeChat["rol"] {
  if (v == null) return "otro";
  const s = String(v).trim().toLowerCase();
  if (s === "0" || s === "cliente" || s === "client" || s === "customer") return "Cliente";
  if (s === "1" || s === "propietario" || s === "negocio" || s === "bot" || s === "asesor" || s === "agente" || s === "owner" || s === "business") return "Propietario";
  return "otro";
}

/** Una fila del listado → último mensaje del chat, o null si no trae lo mínimo (id + fecha). */
export function interpretarFila(rowRaw: unknown, cc: string): UltimoMensajeChat | null {
  if (!rowRaw || typeof rowRaw !== "object") return null;
  const row = rowRaw as Record<string, unknown>;
  const id = primero(row, ["id", "id_cliente_chat_center", "chat_id", "id_chat", "chat_id_cliente"]);
  const at = fechaListar(primero(row, ["ultimo_mensaje_at", "fecha_ultimo_mensaje", "ultimo_mensaje_fecha", "last_message_at", "updated_at"]), cc);
  if (id == null || !at) return null;
  const tipo = String(primero(row, ["ultimo_tipo_mensaje", "tipo_ultimo_mensaje", "ultimo_mensaje_tipo", "tipo_mensaje", "tipo"]) ?? "text").toLowerCase();
  const texto = String(primero(row, ["ultimo_mensaje", "texto_ultimo_mensaje", "ultimo_texto_mensaje", "ultimo_mensaje_texto", "texto_mensaje", "texto"]) ?? "");
  return {
    chatId: String(id),
    at,
    rol: rolListar(primero(row, ["ultimo_rol_mensaje", "rol_ultimo_mensaje", "ultimo_mensaje_rol", "rol_mensaje", "rol"])),
    tipo,
    texto,
  };
}

/** Saca las filas y el total de páginas de las formas de respuesta conocidas. */
export function extraerFilas(json: unknown, page: number, limit: number): { filas: unknown[]; totalPaginas: number } {
  const j = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const d = (j.data && typeof j.data === "object" ? j.data : {}) as Record<string, unknown>;
  const filas =
    (Array.isArray(d.rows) && d.rows) ||
    (Array.isArray(d.data) && d.data) ||
    (Array.isArray(d.items) && d.items) ||
    (Array.isArray(j.rows) && j.rows) ||
    (Array.isArray(j.data) && (j.data as unknown[])) ||
    (Array.isArray(j.items) && j.items) ||
    [];
  const tp = Number(d.total_pages ?? d.last_page ?? d.totalPages ?? j.total_pages ?? j.last_page ?? j.totalPages);
  const totalPaginas = Number.isFinite(tp) && tp > 0 ? tp : (filas.length < limit ? page : page + 1);
  return { filas, totalPaginas };
}

export interface ResultadoListar {
  porChat: Map<string, UltimoMensajeChat>;
  paginas: number;
  filas: number;
  ignoradas: number;
  /** Claves de la primera fila, para diagnosticar una forma desconocida. */
  muestraKeys: string[];
  parcial: boolean;
}

/**
 * Pagina el listado hasta encontrar TODOS los chats pedidos, agotar las
 * páginas o quedarse sin reloj. Nunca tira: `null` = no se pudo (HTTP, red,
 * timeout) y quien llama decide el respaldo.
 */
export async function traerUltimosMensajes(
  base: string,
  token: string,
  idConf: number,
  cc: string,
  vencimiento: number,
  chatsBuscados: ReadonlySet<string>,
  opts: { limit?: number; maxPaginas?: number; fetchFn?: typeof fetch } = {},
): Promise<ResultadoListar | null> {
  const limit = opts.limit ?? 200;
  const maxPaginas = opts.maxPaginas ?? 40;
  const f = opts.fetchFn ?? fetch;
  const porChat = new Map<string, UltimoMensajeChat>();
  let filasTotal = 0, ignoradas = 0, paginas = 0;
  let muestraKeys: string[] = [];
  const faltan = new Set(chatsBuscados);

  for (let page = 1; page <= maxPaginas; page++) {
    const restante = vencimiento - Date.now();
    if (restante < 3_000) return { porChat, paginas, filas: filasTotal, ignoradas, muestraKeys, parcial: true };
    const url = `${base}clientes_chat_center/listar?id_configuracion=${encodeURIComponent(String(idConf))}&page=${page}&limit=${limit}`;
    const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(Math.min(20_000, Math.max(3_000, restante)))
      : undefined;
    let r: Response;
    try {
      r = await f(url, { method: "GET", headers: { Authorization: `Bearer ${token}` }, signal });
      // Algunos endpoints de ImporChat son POST con JSON: si el GET no existe, se prueba una vez.
      if (r.status === 404 || r.status === 405) {
        r = await f(`${base}clientes_chat_center/listar`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ id_configuracion: idConf, page, limit }),
          signal,
        });
      }
    } catch (e) {
      console.warn("[imporchatListar] fetch falló:", e instanceof Error ? e.message : String(e));
      return null;
    }
    if (!r.ok) {
      console.warn(`[imporchatListar] HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
      return null;
    }
    let json: unknown;
    try { json = await r.json(); } catch { return null; }
    const { filas, totalPaginas } = extraerFilas(json, page, limit);
    paginas = page;
    if (page === 1 && filas.length && filas[0] && typeof filas[0] === "object") {
      muestraKeys = Object.keys(filas[0] as Record<string, unknown>).slice(0, 40);
    }
    for (const fila of filas) {
      filasTotal++;
      const u = interpretarFila(fila, cc);
      if (!u) { ignoradas++; continue; }
      if (!porChat.has(u.chatId)) porChat.set(u.chatId, u);
      faltan.delete(u.chatId);
    }
    if (filas.length === 0) break;
    if (chatsBuscados.size > 0 && faltan.size === 0) break;
    if (page >= totalPaginas) break;
  }
  return { porChat, paginas, filas: filasTotal, ignoradas, muestraKeys, parcial: false };
}
