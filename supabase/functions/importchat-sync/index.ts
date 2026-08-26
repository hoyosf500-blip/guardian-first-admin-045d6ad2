// importchat-sync — trae de ImporChat lo único que predice una cancelación
// antes de que ocurra: qué hizo el CLIENTE con el botón del WhatsApp.
//
// Medido en agosto-2026 (EC, 765 pedidos resueltos, 213 cancelados):
//   apretó "CONFIRMAR PEDIDO" .....  402 → 10,4% cancela
//   NO lo apretó ..................  220 → 57,7% cancela   ($3.928, el 62% de
//                                          toda la plata cancelada del mes)
// z = −12,63, aguanta en los 4 productos por separado, y la mediana entre que
// sale la plantilla y que aprietan es 0,0 h: se sabe en el primer minuto.
// La antigüedad del pedido, en cambio, no distingue nada dentro del primer día.
// La lógica de la señal vive (y se prueba) en _shared/senalConfirmacion.ts.
//
// ── Cómo lo trae ───────────────────────────────────────────────────────────
//   1. `dropi_integrations/orders/cache/list` → por pedido: chat_id_cliente y
//      **la hora real de creación** (Guardian no la tenía: `created_at` es la
//      hora del sync). Paginado de a 200.
//   2. `configuraciones/exportar_mensajes_xlsx` → el historial COMPLETO de
//      mensajes en un XLSX (~9 MB, 48.000 filas).
//      ⚠️ Ese endpoint IGNORA el rango de fechas que se le pase: siempre baja
//      todo. No es un bug a corregir — hace falta el historial entero para
//      poder afirmar "este cliente nunca escribió, jamás", que es un grupo de
//      127 pedidos (17%) que cancela 76%.
//      ⛔ NO se abre con SheetJS (24-ago-2026). `XLSX.read` + `sheet_to_json`
//      materializa 48.000 objetos de 18 campos: la función se quedaba sin
//      memoria/CPU y la PLATAFORMA LA MATABA — sin catch, sin fila en
//      sync_logs. Medido: 7 disparos, 7 muertes mudas, cero rastro. Ahora se
//      descomprimen SOLO las dos entradas que importan del zip (fflate) y se
//      recorren las filas con regex, guardando por chat lo mínimo: memoria
//      acotada en vez de proporcional al archivo.
//   3. Deriva la señal y hace un UPDATE DIRIGIDO por (store_id, external_id).
//      No inserta pedidos ni toca estado/valor/guía: ImporChat no manda sobre
//      eso. Y no pasa por `upsert_orders_from_dropi` — ⛔ REGLA #1.
//
// ── Trampa del export, ya pagada ───────────────────────────────────────────
// En las filas con Rol='Cliente' el "Emisor" SIGUE siendo la conexión del
// negocio, no el cliente. El cliente es SIEMPRE `ID Receptor` / `Celular
// Receptor`. Cruzar por "Emisor" da cero coincidencias y la señal sale vacía
// sin ningún error visible.
//
// Auth: x-cron-secret (igual que dropi-cron/shopify-auto-push) o Bearer de un
// miembro de la tienda. Body: { store_id?, dias?, dry_run? }.
// Siempre escribe en `sync_logs` — también una corrida sana con 0 cambios, que
// es el contrato que necesita cualquier badge de salud para distinguir
// "corrió y no había nada" de "no corrió".

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { unzipSync } from "https://esm.sh/fflate@0.8.2";
import { getCorsHeaders } from "../_shared/cors.ts";
import {
  derivarActividadChat,
  derivarSenal,
  type MensajeChat,
} from "../_shared/senalConfirmacion.ts";
import {
  ensureFreshImporchatToken,
  IMPORCHAT_BASE_DEFAULT,
} from "../_shared/imporchatSession.ts";

const SOURCE = "importchat-sync";
const PAGE_SIZE = 200;
const MAX_PAGES = 15;
const DIAS_DEFAULT = 10;
/** Ventana del pedido: desde 2 h antes (la plantilla puede salir apenas antes
 *  de que Dropi registre la orden) hasta 7 días después. */
const VENTANA_ANTES_MS = 2 * 60 * 60 * 1000;
const VENTANA_DESPUES_MS = 7 * 24 * 60 * 60 * 1000;
/** Presupuesto de pared por debajo del límite del edge, para que SIEMPRE
 *  alcance a escribir la fila de sync_logs. Mismo criterio que dropi-cron. */
const BUDGET_MS = 110_000;
/** Los textos del export se recortan al guardarlos: lo único largo que se lee
 *  es el botón ("CONFIRMAR PEDIDO"), y 48.000 mensajes completos en memoria son
 *  justamente lo que mataba a la función. */
const MAX_TEXTO = 64;
/** Un pedido leído hace menos de esto no se vuelve a escribir. Hace que el
 *  backfill sea REANUDABLE: si una corrida no alcanza a terminar, la siguiente
 *  arranca donde quedó en vez de repetir todo y morir en el mismo lugar. */
const FRESCURA_MS = 6 * 60 * 60 * 1000;

/** ⚠️ DOS relojes distintos, verificado en vivo el 24-ago-2026:
 *
 *  · `order_created_at` de `orders/cache/list` viene en hora LOCAL del país
 *    ("2026-08-24 16:47:01" con reloj local 16:59). Se convierte con `aUTC`.
 *  · Las fechas del XLSX son SERIALES DE EXCEL EN UTC (46258,8687 = 20:50 UTC
 *    = 15:50 local, contrastado contra el `created_at` del mismo mensaje).
 *
 *  La versión anterior les pasaba el serial numérico a un parser de texto:
 *  devolvía null para TODAS las filas, así que el historial quedaba vacío y
 *  cada pedido salía "sin_dato" sin un solo error visible. Y de haberlo
 *  parseado como local, la ventana del pedido habría quedado corrida 5 horas.
 *  Internamente ahora TODO viaja en UTC real; el offset se aplica una sola vez,
 *  al leer el pedido. */
const OFFSET_HORAS: Record<string, number> = { EC: -5, CO: -5, GT: -6 };

function aUTC(local: Date, cc: string): Date {
  const off = OFFSET_HORAS[cc] ?? -5;
  return new Date(local.getTime() - off * 3600_000);
}

/** "2026-08-21 20:18:23" → Date con esos componentes anclados en UTC (o sea:
 *  hora local del país, sin que el runtime le invente zona). */
function parseLocal(s: string): Date | null {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

/** Serial de Excel (días desde 1899-12-30) → Date UTC real. 25569 = días entre
 *  esa época y 1970-01-01. */
function serialAFecha(v: string): Date | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 20000 || n > 90000) return null;
  return new Date(Math.round((n - 25569) * 86400000));
}

interface PedidoIC {
  externalId: string;
  chatId: string;
  /** Hora real de creación, ya en UTC. */
  creadoUTC: Date;
}

async function traerPedidos(
  base: string, token: string, idConf: number, desde: string, hasta: string,
  cc: string, vencimiento: number,
): Promise<{ pedidos: PedidoIC[]; parcial: boolean }> {
  const out: PedidoIC[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    // La paginación es lo primero que puede comerse el reloj (31 páginas con
    // page_size 200 en la tienda EC). Se corta a tiempo y se avisa: media
    // cola medida vale más que una función muerta.
    if (Date.now() > vencimiento) return { pedidos: out, parcial: true };
    const r = await fetch(`${base}dropi_integrations/orders/cache/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id_configuracion: idConf, plataforma: "dropi",
        page, page_size: PAGE_SIZE, from: desde, until: hasta,
      }),
    });
    if (!r.ok) {
      throw new Error(`orders/cache/list HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const j = await r.json();
    const d = j?.data;
    for (const row of d?.rows ?? []) {
      const creado = parseLocal(row.order_created_at);
      if (!creado || !row.chat_id_cliente) continue;
      out.push({
        externalId: String(row.id),
        chatId: String(row.chat_id_cliente),
        creadoUTC: aUTC(creado, cc),
      });
    }
    if (page >= (d?.total_pages ?? 1)) return { pedidos: out, parcial: false };
  }
  // Se agotaron las páginas permitidas: hay más historia sin traer.
  return { pedidos: out, parcial: true };
}

async function traerMensajes(
  base: string, token: string, idConf: number,
): Promise<Map<string, MensajeChat[]>> {
  const r = await fetch(`${base}configuraciones/exportar_mensajes_xlsx`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ id_configuracion: idConf }),
  });
  if (!r.ok) {
    throw new Error(`exportar_mensajes_xlsx HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const buf = new Uint8Array(await r.arrayBuffer());

  // Del zip se sacan SOLO la hoja y la tabla de textos; estilos/temas ni se
  // descomprimen. (SheetJS descomprimía y modelaba todo: eso mataba la función.)
  const zip = unzipSync(buf, {
    filter: (f) => f.name === "xl/worksheets/sheet1.xml" || f.name === "xl/sharedStrings.xml",
  });
  const dec = new TextDecoder();
  const desescapar = (s: string) => s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

  // Tabla de textos compartidos. Se recorta cada entrada a MAX_TEXTO: lo único
  // largo del archivo son los mensajes, y de ellos solo se lee si un botón dice
  // "CONFIRMAR" (17 caracteres). Guardar los textos enteros son ~20 MB al pedo.
  const shared: string[] = [];
  const ssRaw = zip["xl/sharedStrings.xml"];
  if (ssRaw) {
    const ss = dec.decode(ssRaw);
    for (const si of ss.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) {
      if (si[1] === undefined) { shared.push(""); continue; }
      let s = "";
      for (const t of si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += t[1];
      shared.push(desescapar(s).slice(0, MAX_TEXTO));
    }
  }

  const hojaRaw = zip["xl/worksheets/sheet1.xml"];
  if (!hojaRaw) throw new Error("El XLSX de mensajes no trae la hoja sheet1");

  // Valor de una celda: `t="s"` indexa la tabla compartida, `t="inlineStr"` trae
  // el texto adentro, y el resto es el valor crudo (las fechas son seriales).
  const valorCelda = (celda: string): string => {
    const t = /\bt="([^"]+)"/.exec(celda)?.[1];
    if (t === "inlineStr") {
      let s = "";
      for (const x of celda.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += x[1];
      return desescapar(s).slice(0, MAX_TEXTO);
    }
    const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(celda)?.[1];
    if (v == null) return "";
    if (t === "s") return shared[Number(v)] ?? "";
    return desescapar(v).slice(0, MAX_TEXTO);
  };
  const letra = (ref: string) => /^([A-Z]+)/.exec(ref)?.[1] ?? "";

  const porChat = new Map<string, MensajeChat[]>();
  let cols: Record<string, string> | null = null; // nombre de columna → letra
  let filas = 0;

  const procesarFila = (interior: string) => {
    const celdas: Record<string, string> = {};
    for (const c of interior.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
      const attrs = c[1] ?? c[3] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!ref) continue;
      celdas[letra(ref)] = c[1] === undefined ? "" : valorCelda(`<c ${attrs}>${c[2]}</c>`);
    }
    if (!cols) {
      // Fila 1 = encabezados. Se mapean por NOMBRE y no por posición: el día que
      // ImporChat agregue una columna al medio, esto sigue funcionando.
      cols = {};
      for (const [L, nombre] of Object.entries(celdas)) cols[nombre.trim()] = L;
      return;
    }
    filas++;
    // El cliente es SIEMPRE el Receptor, incluso en las filas que escribió él.
    const chat = (celdas[cols["ID Receptor"] ?? ""] ?? "").trim();
    const fecha = serialAFecha(celdas[cols["Fecha Mensaje"] ?? ""] ?? "");
    if (!chat || !fecha) return;
    const tipo = celdas[cols["Tipo Mensaje"] ?? ""] ?? "";
    const arr = porChat.get(chat) ?? [];
    arr.push({
      rol: celdas[cols["Rol"] ?? ""] ?? "",
      tipo,
      // Solo los botones necesitan texto (para leer "CONFIRMAR"). El resto va
      // vacío a propósito: es la diferencia entre caber en memoria y no caber.
      texto: tipo === "button" ? (celdas[cols["Texto Mensaje"] ?? ""] ?? "") : "",
      plantilla: celdas[cols["Template"] ?? ""] || null,
      fecha,
    });
    porChat.set(chat, arr);
  };

  // ⛔ La hoja descomprimida son 55 MB (medido sobre el archivo real) y este
  // export NO usa tabla de textos compartidos: cada mensaje viaja dentro de su
  // celda. Decodificarla entera son ~110 MB de string UTF-16 de una sola vez —
  // el camino directo al OOM. Se recorre de a 1 MB: se decodifica el trozo, se
  // procesan las filas COMPLETAS que contiene y solo la cola parcial pasa al
  // siguiente. La memoria queda acotada por el buffer, no por el archivo.
  const CHUNK = 1 << 20;
  let resto = "";
  for (let off = 0; off < hojaRaw.length; off += CHUNK) {
    const buf = resto + dec.decode(hojaRaw.subarray(off, Math.min(off + CHUNK, hojaRaw.length)), { stream: true });
    const corte = buf.lastIndexOf("</row>");
    if (corte < 0) { resto = buf; continue; }
    // Un solo matchAll por trozo: recortar fila por fila del buffer copiaría
    // ~1 MB por cada una de las 48.000 filas.
    for (const m of buf.slice(0, corte + 6).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) procesarFila(m[1]);
    resto = buf.slice(corte + 6);
  }
  for (const m of resto.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) procesarFila(m[1]);

  for (const arr of porChat.values()) arr.sort((a, b) => a.fecha.getTime() - b.fecha.getTime());
  console.log(`[${SOURCE}] XLSX: ${filas} filas → ${porChat.size} chats`);
  return porChat;
}

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const t0 = Date.now();
  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...cors, "Content-Type": "application/json" },
    });

  let storeId = "";
  // ── Rastro que sobrevive a una muerte ──────────────────────────────────
  // La plataforma puede matar la función sin darle ni un `catch` (memoria o
  // reloj). Pasó 7 veces seguidas el 24-ago-2026 y NO dejó una sola fila: desde
  // afuera era indistinguible de "nunca se llamó". Ahora se inserta una fila
  // 'running' apenas arranca y se le va escribiendo la FASE alcanzada; si la
  // función muere, esa fila queda como la última señal de vida y dice dónde.
  let trazaId: string | null = null;

  /**
   * ⛔ `sync_logs.store_id` y `sync_logs.synced_count` son **NOT NULL** (con
   * DEFAULT). Mandarles `null` hace que Postgres RECHACE la fila… y como
   * supabase-js NO lanza excepción, el `try/catch` no se entera: la corrida
   * queda sin registro y desde afuera es idéntica a "nunca se ejecutó".
   * Fue exactamente lo que pasó el 24-ago-2026: la función terminó bien
   * (1.357 pedidos escritos, apagado limpio) y sync_logs quedó vacío.
   * Por eso: `store_id` se OMITE si no hay tienda en curso (queda el DEFAULT)
   * y `synced_count` nunca viaja en null.
   */
  const filaLog = (status: string, msg: string, n: number | null) => {
    const fila: Record<string, unknown> = {
      source: SOURCE, status, error_message: msg || null, synced_count: n ?? 0,
    };
    if (storeId) fila.store_id = storeId;
    return fila;
  };

  const traza = async (fase: string, n: number | null = null) => {
    try {
      if (trazaId == null) {
        const { data, error } = await sb.from("sync_logs")
          .insert(filaLog("running", fase, n)).select("id").maybeSingle();
        // El error se MIRA, no se asume: es la única forma de enterarse de un
        // rechazo del esquema (supabase-js devuelve el error, no lo lanza).
        if (error) console.error(`[${SOURCE}] sync_logs rechazó la traza: ${error.code} ${error.message}`);
        trazaId = (data as { id?: string } | null)?.id ?? null;
      } else {
        const { error } = await sb.from("sync_logs").update({
          error_message: fase, synced_count: n ?? 0,
          ...(storeId ? { store_id: storeId } : {}),
        }).eq("id", trazaId);
        if (error) console.error(`[${SOURCE}] no se pudo actualizar la traza: ${error.message}`);
      }
    } catch (e) {
      console.error(`[${SOURCE}] no se pudo escribir la traza:`, e);
    }
  };
  const log = async (status: string, msg: string, n: number | null) => {
    // Se escribe SIEMPRE, incluso con 0 cambios. Un badge que solo mira la hora
    // no distingue "corrió bien y no había nada" de "no corrió" — esa confusión
    // ya tuvo la billetera muerta semanas en verde (ver CLAUDE.md).
    try {
      // Cierra la fila 'running' si existe (una corrida = una fila), o inserta
      // una nueva si murió antes de poder abrirla.
      if (trazaId != null) {
        const { error } = await sb.from("sync_logs").update({
          status, error_message: msg || null, synced_count: n ?? 0,
          ...(storeId ? { store_id: storeId } : {}),
        }).eq("id", trazaId);
        if (error) console.error(`[${SOURCE}] no se pudo cerrar la traza: ${error.message}`);
        return;
      }
      const { error } = await sb.from("sync_logs").insert(filaLog(status, msg, n));
      if (error) {
        console.error(`[${SOURCE}] sync_logs rechazó la fila: ${error.code} ${error.message}`);
      }
    } catch (e) {
      console.error(`[${SOURCE}] no se pudo escribir sync_logs:`, e);
    }
  };

  try {
    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dry_run === true;
    const dias = Math.min(Math.max(Number(body?.dias) || DIAS_DEFAULT, 1), 60);

    // ── Auth ───────────────────────────────────────────────────────────────
    const cronSecret = req.headers.get("x-cron-secret");
    let autorizado = false;
    if (cronSecret) {
      // app_settings es CLAVE/VALOR (así la leen shopify-auto-push y
      // resumen-diario). La versión anterior pedía una COLUMNA
      // `cron_shared_secret` que no existe → cfg null → 401 eterno: el cron
      // jamás habría podido correr. Detectado el 24-ago-2026 comparando las
      // tres funciones antes del primer deploy.
      const { data: secretRow } = await sb
        .from("app_settings").select("value").eq("key", "cron_shared_secret").maybeSingle();
      const esperado = String(secretRow?.value || "");
      autorizado = !!esperado && cronSecret === esperado;
      if (!autorizado) return json({ ok: false, error: "cron secret inválido" }, 401);
    } else {
      const auth = req.headers.get("Authorization") ?? "";
      const { data: u } = await sb.auth.getUser(auth.replace("Bearer ", ""));
      if (!u?.user) return json({ ok: false, error: "no autenticado" }, 401);
      if (body?.store_id) {
        const { data: m } = await sb
          .from("store_members").select("role")
          .eq("store_id", body.store_id).eq("user_id", u.user.id).maybeSingle();
        if (!m) return json({ ok: false, error: "no sos miembro de esa tienda" }, 403);
      } else {
        // finding #5: SIN store_id un humano NO puede disparar el sync
        // multi-tienda — es pesado (paginación + XLSX ~9 MB por tienda) y el
        // `resumen` de respuesta filtraría datos de TODAS las tiendas a cualquier
        // usuario logueado. Solo un admin de plataforma (o el cron, que va por la
        // otra rama) puede correr todas.
        const { data: rol } = await sb.from("user_roles")
          .select("role").eq("user_id", u.user.id).eq("role", "admin").maybeSingle();
        if (!rol) return json({ ok: false, error: "Especificá store_id: solo un admin puede sincronizar todas las tiendas." }, 403);
      }
      autorizado = true;
    }

    await traza("arrancó");

    // ── Tiendas a procesar ─────────────────────────────────────────────────
    let q = sb.from("store_importchat_config")
      .select("store_id, id_configuracion, api_base, session_token, token_expira_at, habilitado")
      .eq("habilitado", true);
    if (body?.store_id) q = q.eq("store_id", body.store_id);
    const { data: configs, error: cfgErr } = await q;
    if (cfgErr) throw new Error(`No se pudo leer store_importchat_config: ${cfgErr.message}`);
    if (!configs?.length) {
      await log("warn", "Ninguna tienda tiene ImporChat configurado y habilitado", 0);
      return json({ ok: true, tiendas: 0, mensaje: "sin tiendas configuradas" });
    }

    const resumen: unknown[] = [];
    let totalTocados = 0;
    // Tiendas que quedaron a medias por presupuesto: el log final sale en
    // 'warn' con el detalle, para que un "success" no tape una corrida parcial.
    const parciales: string[] = [];

    for (const cfg of configs) {
      storeId = String(cfg.store_id);
      if (Date.now() - t0 > BUDGET_MS) {
        await log("warn", "Se acabó el presupuesto de tiempo antes de terminar las tiendas", totalTocados);
        break;
      }
      let token = String(cfg.session_token || "");
      if (!token) {
        // Fail-closed y RUIDOSO: sin token la señal se apaga, y una señal
        // apagada en silencio es peor que no tenerla — la pantalla mostraría
        // "sin dato" para todo y nadie sabría por qué.
        await log("error", "Falta session_token de ImporChat para esta tienda", null);
        resumen.push({ store_id: storeId, ok: false, error: "sin token" });
        continue;
      }

      // ── Renovación PROACTIVA de la llave (antes de todo lo demás) ──────────
      // La llave vence a los 7 días y NADA la renovaba: una bomba de tiempo que
      // apagaba todo ImporChat sin aviso. Este cron corre cada 30 min, así que
      // renovar acá —al arranque, antes del XLSX que a veces muere por memoria—
      // mantiene la llave viva para siempre con 48 h de margen. Si la
      // renovación falla, se sigue con la llave que había (no rompe la corrida).
      // Ver `_shared/imporchatSession.ts`.
      try {
        const frescoTok = await ensureFreshImporchatToken(sb, {
          storeId,
          base: String(cfg.api_base || IMPORCHAT_BASE_DEFAULT),
          sessionToken: token,
          tokenExpiraAt: cfg.token_expira_at ? String(cfg.token_expira_at) : null,
        });
        if (frescoTok && frescoTok !== token) {
          token = frescoTok;
          await log("success", "Llave de ImporChat renovada automáticamente", 0);
        }
      } catch (e) {
        // La renovación nunca debe tumbar el sync: se anota y se sigue.
        console.warn("[importchat-sync] renovación falló:", e instanceof Error ? e.message : e);
      }

      if (cfg.token_expira_at && new Date(cfg.token_expira_at).getTime() < Date.now() && token === String(cfg.session_token || "")) {
        // Solo se rinde si SIGUE vencida tras intentar renovar (la renovación
        // ya habría cambiado el token y actualizado token_expira_at).
        await log("error", `El token de ImporChat venció el ${cfg.token_expira_at} y no se pudo renovar`, null);
        resumen.push({ store_id: storeId, ok: false, error: "token vencido" });
        continue;
      }

      // finding #4: si una tienda falla (token muerto → traerPedidos/traerMensajes
      // hacen throw), NO debe tumbar el sync de las DEMÁS. Antes el throw salía al
      // catch global y las tiendas restantes no se procesaban. Se aísla por tienda.
      try {
      const { data: store } = await sb
        .from("stores").select("country_code").eq("id", storeId).maybeSingle();
      const cc = String(store?.country_code || "EC");

      const hasta = new Date();
      const desde = new Date(hasta.getTime() - dias * 86400_000);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);

      const base = String(cfg.api_base || "https://chat.imporfactory.app/api/v1/");
      const vencimiento = t0 + BUDGET_MS;

      await traza(`fase 1: pidiendo pedidos (${dias} días)`);
      const { pedidos, parcial: pedidosParciales } =
        await traerPedidos(base, token, Number(cfg.id_configuracion), fmt(desde), fmt(hasta), cc, vencimiento);
      console.log(`[${SOURCE}] ${storeId}: ${pedidos.length} pedidos a los ${Date.now() - t0} ms`);
      if (pedidosParciales) parciales.push(`pedidos incompletos (se cortó la paginación)`);
      await traza(`fase 2: bajando y leyendo el XLSX (${pedidos.length} pedidos)`);
      if (Date.now() > vencimiento) {
        await log("warn", `Se acabó el tiempo trayendo pedidos (${pedidos.length}); no se alcanzó a leer los mensajes. Volvé a correrlo.`, 0);
        return json({ ok: true, parcial: true, actualizados: 0 });
      }

      const chats = await traerMensajes(base, token, Number(cfg.id_configuracion));
      console.log(`[${SOURCE}] ${storeId}: ${chats.size} chats a los ${Date.now() - t0} ms`);
      await traza(`fase 3: derivando señales (${chats.size} chats)`);
      if (Date.now() > vencimiento) {
        await log("warn", `Se acabó el tiempo leyendo el XLSX (${chats.size} chats); no se alcanzó a escribir. Volvé a correrlo.`, 0);
        return json({ ok: true, parcial: true, actualizados: 0 });
      }

      let tocados = 0, conBoton = 0, mudos = 0, sinSaliente = 0, saltados = 0, frescos = 0;

      // Lo ya leído hace poco NO se reescribe: así el backfill es REANUDABLE.
      // Sin esto, cada corrida repite los mismos 3.000 pedidos desde el
      // principio y muere siempre en el mismo lugar; con esto, cada corrida
      // avanza y el cron termina el trabajo solo.
      const leidoPrevio = new Map<string, number>();
      // Pedidos que YA tienen guardado el id de conversación. Los que no lo
      // tienen fueron leídos por una versión anterior de esta función, cuando
      // esa columna todavía no se escribía: darlos por frescos deja la columna
      // vacía PARA SIEMPRE mientras la corrida informa "success".
      // Pasó de verdad el 24-ago-2026: 1.522 chats leídos, 0 con id de chat.
      const conChatId = new Set<string>();
      const ids = pedidos.map((p) => p.externalId);
      for (let i = 0; i < ids.length; i += 200) {
        const trozo = ids.slice(i, i + 200);
        const conNueva = await sb.from("orders")
          .select("external_id, chat_leido_at, importchat_chat_id")
          .eq("store_id", storeId)
          .in("external_id", trozo);
        // Si la migración 20260825010000 no corrió, se reintenta sin esa
        // columna (mismo patrón que el UPDATE de más abajo): sin el reintento
        // la lectura previa queda vacía y cada corrida repite todo desde cero.
        const res = conNueva.error
          ? await sb.from("orders")
              .select("external_id, chat_leido_at")
              .eq("store_id", storeId)
              .in("external_id", trozo)
          : conNueva;
        const filas = (res.data ?? []) as unknown as {
          external_id: string; chat_leido_at: string | null; importchat_chat_id?: string | null;
        }[];
        for (const row of filas) {
          if (row.chat_leido_at) leidoPrevio.set(String(row.external_id), Date.parse(row.chat_leido_at));
          if (row.importchat_chat_id) conChatId.add(String(row.external_id));
        }
      }

      // FASE 1 — derivar la señal de todos (puro CPU, barato).
      interface Tarea {
        externalId: string;
        payloadBase: Record<string, unknown>;
        columnasNuevas: Record<string, unknown>;
      }
      const tareas: Tarea[] = [];
      const ahoraMs = Date.now();
      for (const p of pedidos) {
        const historial = chats.get(p.chatId) ?? null;
        const desdeMs = p.creadoUTC.getTime() - VENTANA_ANTES_MS;
        const hastaMs = p.creadoUTC.getTime() + VENTANA_DESPUES_MS;
        const ventana = historial
          ? historial.filter((m) => {
              const t = m.fecha.getTime();
              return t >= desdeMs && t <= hastaMs;
            })
          : null;

        const s = derivarSenal(ventana, historial);
        // Actividad sobre el historial COMPLETO: ¿le escribimos alguna vez?
        // ¿cuándo fue la última? La comparación con "llegó a la agencia" o
        // "se canceló" vive en la pantalla; acá solo el hecho crudo.
        const act = derivarActividadChat(historial);
        if (s.apretoBotonAt) conBoton++;
        if (s.mudo) mudos++;
        if (historial && !act.salienteAt) sinSaliente++;
        if (dryRun) continue;

        // Fresco = leído hace poco Y sin nada nuevo en el chat desde entonces.
        // La segunda condición importa: un pedido que recibió un mensaje hace
        // diez minutos se vuelve a escribir aunque se haya leído hace una hora.
        const leido = leidoPrevio.get(p.externalId);
        const ultimoMs = historial?.length ? historial[historial.length - 1].fecha.getTime() : 0;
        // Tercera condición: que no falte NADA de lo que hoy se guarda. Si
        // ImporChat tiene chat para este pedido y nosotros todavía no tenemos
        // su id, hay algo nuevo que traer por más reciente que sea la lectura.
        // (Si ImporChat tampoco tiene chat no hay nada que buscar y el pedido
        // sí puede quedarse fresco — si no, cada corrida lo repetiría.)
        const faltaChatId = !!p.chatId && !conChatId.has(p.externalId);
        if (!faltaChatId && leido && ahoraMs - leido < FRESCURA_MS && ultimoMs <= leido) { frescos++; continue; }

        // ⛔ ¿Se LEYÓ de verdad el chat de este pedido? `historial===null` = el
        // export de ImporChat todavía no lo trae (o el id no matcheó). En ese
        // caso NO sabemos nada de la conversación y NO se puede pisar lo que ya
        // había: escribir `chat_entrante_at=NULL` borraba la marca de "el cliente
        // escribió" y `ventanaWhatsapp` bloqueaba responderle al que ACABA de
        // escribir (misma regresión que `importchat-chat` ya protege). Cuando no
        // se leyó, se omiten TODAS las columnas de actividad (incl. chat_leido_at,
        // así el próximo sync lo reintenta) y solo se tocan datos estables.
        const leyoChat = historial !== null;
        tareas.push({
          externalId: p.externalId,
          // Columnas de 20260824230000. Van aparte para poder REINTENTAR sin
          // ellas si esa migración no corrió (Lovable no auto-aplica).
          // Las fechas de mensajes YA son UTC (seriales de Excel): meterles el
          // offset otra vez las correría 5 horas.
          columnasNuevas: {
            ...(leyoChat ? {
              chat_saliente_at: act.salienteAt ? act.salienteAt.toISOString() : null,
              chat_saliente_tipo: act.salienteTipo,
              chat_entrante_at: act.entranteAt ? act.entranteAt.toISOString() : null,
            } : {}),
            // Sin esto no se le puede RESPONDER al cliente desde Guardian: el
            // canal de ImporChat pide el id del chat, no el teléfono. Se escribe
            // solo si lo conocemos (nunca se pisa un id ya guardado con null).
            ...(p.chatId ? { importchat_chat_id: p.chatId } : {}),
          },
          payloadBase: {
            ...(leyoChat ? {
              confirmo_boton_at: s.apretoBotonAt ? s.apretoBotonAt.toISOString() : null,
              chat_cliente_escribio_at: s.clienteEscribioAt
                ? s.clienteEscribioAt.toISOString() : null,
              chat_mudo: s.mudo,
              chat_riesgo: s.riesgo,
              chat_leido_at: new Date().toISOString(),
            } : {}),
            pedido_creado_at: p.creadoUTC.toISOString(),
          },
        });
      }
      await traza(`fase 4: escribiendo ${tareas.length} pedidos (${frescos} ya frescos)`);

      // FASE 2 — escribir EN PARALELO de a 15. La v1 escribía en SERIE: con
      // dias=60 son hasta 3.000 UPDATEs (~50 ms c/u ≈ 150 s solo de escritura)
      // y la plataforma mataba la función ANTES del log final — 4 disparos
      // medidos el 24-ago, 4 timeouts, CERO filas en sync_logs: una corrida
      // muerta sin rastro, que es exactamente lo que sync_logs existe para
      // evitar. Entre tanda y tanda se mira el presupuesto: si se acaba, se
      // deja constancia PARCIAL en vez de morir en silencio.
      let columnasNuevasOk = true;
      const escribir = async (t: Tarea): Promise<boolean> => {
        // UPDATE dirigido por (store_id, external_id). El par es único desde la
        // migración 20260820140000: el número de pedido solo NO identifica una
        // tienda y filtrar sin store_id podría escribirle a otro país.
        let { error: upErr } = await sb.from("orders")
          .update(columnasNuevasOk ? { ...t.payloadBase, ...t.columnasNuevas } : t.payloadBase)
          .eq("store_id", storeId).eq("external_id", t.externalId);
        if (upErr && columnasNuevasOk && /chat_saliente|chat_entrante|importchat_chat_id/i.test(upErr.message)) {
          console.warn(`[${SOURCE}] migración 20260824230000 sin aplicar — escribo sin actividad de chat`);
          columnasNuevasOk = false;
          ({ error: upErr } = await sb.from("orders")
            .update(t.payloadBase)
            .eq("store_id", storeId).eq("external_id", t.externalId));
        }
        if (upErr) {
          console.error(`[${SOURCE}] update ${t.externalId}: ${upErr.message}`);
          return false;
        }
        return true;
      };
      const PARALELO = 15;
      for (let i = 0; i < tareas.length; i += PARALELO) {
        if (Date.now() > vencimiento) {
          saltados = tareas.length - i;
          parciales.push(`escribí ${tocados} de ${tareas.length}, quedaron ${saltados} (corré de nuevo para completar)`);
          break;
        }
        const ok = await Promise.all(tareas.slice(i, i + PARALELO).map(escribir));
        tocados += ok.filter(Boolean).length;
      }
      console.log(`[${SOURCE}] ${storeId}: ${tocados}/${tareas.length} escritos a los ${Date.now() - t0} ms`);

      totalTocados += tocados;
      resumen.push({
        store_id: storeId, ok: true, pedidos: pedidos.length,
        actualizados: tocados, con_boton: conBoton, mudos,
        sin_saliente: sinSaliente, saltados, frescos, chats: chats.size, dry_run: dryRun,
      });
      } catch (eStore) {
        // La tienda falló entera (p. ej. 401 de un token que murió a mitad de
        // corrida): se anota y se SIGUE con las demás. Un "success" final no puede
        // taparlo → también entra a `parciales`.
        const emsg = eStore instanceof Error ? eStore.message : String(eStore);
        console.error(`[${SOURCE}] ${storeId} falló, sigo con las demás: ${emsg}`);
        await log("error", `Tienda ${storeId}: ${emsg}`, null);
        resumen.push({ store_id: storeId, ok: false, error: emsg });
        parciales.push(`tienda ${storeId} falló (${emsg})`);
        continue;
      }
    }

    storeId = "";
    // Un "success" no puede tapar una corrida parcial: si alguna tienda quedó
    // a medias por presupuesto, el log final sale en 'warn' con el detalle.
    await log(parciales.length ? "warn" : "success", parciales.join(" | "), totalTocados);
    return json({ ok: true, actualizados: totalTocados, parcial: parciales.length > 0, tiendas: resumen });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${SOURCE}]`, msg);
    await log("error", msg, null);
    // 200 con ok:false: el cron no debe reintentar en loop, y el badge lee
    // sync_logs, no el código HTTP.
    return json({ ok: false, error: msg });
  }
});
