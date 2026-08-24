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
//      mensajes en un XLSX (~8 MB). Se parsea con el MISMO SheetJS vendorizado
//      que usa dropi-wallet-sync.
//      ⚠️ Ese endpoint IGNORA el rango de fechas que se le pase: siempre baja
//      todo. No es un bug a corregir — hace falta el historial entero para
//      poder afirmar "este cliente nunca escribió, jamás", que es un grupo de
//      127 pedidos (17%) que cancela 76%.
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
import * as XLSX from "../_shared/vendor/xlsx-0.20.3.mjs";
import { getCorsHeaders } from "../_shared/cors.ts";
import {
  derivarActividadChat,
  derivarSenal,
  type MensajeChat,
} from "../_shared/senalConfirmacion.ts";

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

/** Las horas del export de ImporChat y de `order_created_at` vienen en hora
 *  LOCAL del país, sin zona. Se comparan entre sí en local (por eso el cálculo
 *  de la ventana no necesita offset) y solo se convierte a UTC al guardar. */
const OFFSET_HORAS: Record<string, number> = { EC: -5, CO: -5, GT: -6 };

function aUTC(local: Date, cc: string): Date {
  const off = OFFSET_HORAS[cc] ?? -5;
  return new Date(local.getTime() - off * 3600_000);
}

/** "2026-08-21 20:18:23" → Date en hora local (sin que el runtime le meta zona). */
function parseLocal(s: string): Date | null {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

interface PedidoIC {
  externalId: string;
  chatId: string;
  creadoLocal: Date;
}

async function traerPedidos(
  base: string, token: string, idConf: number, desde: string, hasta: string,
): Promise<PedidoIC[]> {
  const out: PedidoIC[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
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
        creadoLocal: creado,
      });
    }
    if (page >= (d?.total_pages ?? 1)) break;
  }
  return out;
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
  const wb = XLSX.read(buf, { type: "array" });
  const hoja = wb.Sheets[wb.SheetNames[0]];
  if (!hoja) throw new Error("El XLSX de mensajes no trae ninguna hoja");
  const filas = XLSX.utils.sheet_to_json(hoja, { defval: null }) as Record<string, unknown>[];

  const porChat = new Map<string, MensajeChat[]>();
  for (const f of filas) {
    // El cliente es SIEMPRE el Receptor, incluso en las filas que escribió él.
    const chat = String(f["ID Receptor"] ?? "").trim();
    const fecha = parseLocal(String(f["Fecha Mensaje"] ?? ""));
    if (!chat || !fecha) continue;
    const arr = porChat.get(chat) ?? [];
    arr.push({
      rol: String(f["Rol"] ?? ""),
      tipo: String(f["Tipo Mensaje"] ?? ""),
      texto: String(f["Texto Mensaje"] ?? ""),
      plantilla: f["Template"] == null ? null : String(f["Template"]),
      fecha,
    });
    porChat.set(chat, arr);
  }
  for (const arr of porChat.values()) arr.sort((a, b) => a.fecha.getTime() - b.fecha.getTime());
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
  const log = async (status: string, msg: string, n: number | null) => {
    // Se escribe SIEMPRE, incluso con 0 cambios. Un badge que solo mira la hora
    // no distingue "corrió bien y no había nada" de "no corrió" — esa confusión
    // ya tuvo la billetera muerta semanas en verde (ver CLAUDE.md).
    try {
      await sb.from("sync_logs").insert({
        source: SOURCE,
        store_id: storeId || null,
        status,
        error_message: msg || null,
        synced_count: n,
      });
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
      }
      autorizado = true;
    }

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

    for (const cfg of configs) {
      storeId = String(cfg.store_id);
      if (Date.now() - t0 > BUDGET_MS) {
        await log("warn", "Se acabó el presupuesto de tiempo antes de terminar las tiendas", totalTocados);
        break;
      }
      const token = String(cfg.session_token || "");
      if (!token) {
        // Fail-closed y RUIDOSO: sin token la señal se apaga, y una señal
        // apagada en silencio es peor que no tenerla — la pantalla mostraría
        // "sin dato" para todo y nadie sabría por qué.
        await log("error", "Falta session_token de ImporChat para esta tienda", null);
        resumen.push({ store_id: storeId, ok: false, error: "sin token" });
        continue;
      }
      if (cfg.token_expira_at && new Date(cfg.token_expira_at).getTime() < Date.now()) {
        await log("error", `El token de ImporChat venció el ${cfg.token_expira_at}`, null);
        resumen.push({ store_id: storeId, ok: false, error: "token vencido" });
        continue;
      }

      const { data: store } = await sb
        .from("stores").select("country_code").eq("id", storeId).maybeSingle();
      const cc = String(store?.country_code || "EC");

      const hasta = new Date();
      const desde = new Date(hasta.getTime() - dias * 86400_000);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);

      const base = String(cfg.api_base || "https://chat.imporfactory.app/api/v1/");
      const pedidos = await traerPedidos(base, token, Number(cfg.id_configuracion), fmt(desde), fmt(hasta));
      const chats = await traerMensajes(base, token, Number(cfg.id_configuracion));

      let tocados = 0, conBoton = 0, mudos = 0, sinSaliente = 0;
      for (const p of pedidos) {
        const historial = chats.get(p.chatId) ?? null;
        const desdeMs = p.creadoLocal.getTime() - VENTANA_ANTES_MS;
        const hastaMs = p.creadoLocal.getTime() + VENTANA_DESPUES_MS;
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

        // Columnas de 20260824230000. Van en un objeto aparte para poder
        // REINTENTAR sin ellas si esa migración todavía no corrió (Lovable no
        // auto-aplica): sin este fallback, una columna faltante tumbaba
        // también la señal del botón, que ya funcionaba.
        const columnasNuevas = {
          chat_saliente_at: act.salienteAt ? aUTC(act.salienteAt, cc).toISOString() : null,
          chat_saliente_tipo: act.salienteTipo,
          chat_entrante_at: act.entranteAt ? aUTC(act.entranteAt, cc).toISOString() : null,
        };
        const payloadBase = {
          confirmo_boton_at: s.apretoBotonAt ? aUTC(s.apretoBotonAt, cc).toISOString() : null,
          chat_cliente_escribio_at: s.clienteEscribioAt
            ? aUTC(s.clienteEscribioAt, cc).toISOString() : null,
          chat_mudo: s.mudo,
          chat_riesgo: s.riesgo,
          chat_leido_at: new Date().toISOString(),
          pedido_creado_at: aUTC(p.creadoLocal, cc).toISOString(),
        };

        // UPDATE dirigido por (store_id, external_id). El par es único desde la
        // migración 20260820140000: el número de pedido solo NO identifica una
        // tienda y filtrar sin store_id podría escribirle a otro país.
        let { error: upErr } = await sb.from("orders")
          .update({ ...payloadBase, ...columnasNuevas })
          .eq("store_id", storeId).eq("external_id", p.externalId);
        if (upErr && /chat_saliente|chat_entrante/i.test(upErr.message)) {
          console.warn(`[${SOURCE}] migración 20260824230000 sin aplicar — escribo sin actividad de chat`);
          ({ error: upErr } = await sb.from("orders")
            .update(payloadBase)
            .eq("store_id", storeId).eq("external_id", p.externalId));
        }
        if (upErr) {
          console.error(`[${SOURCE}] update ${p.externalId}: ${upErr.message}`);
          continue;
        }
        tocados++;
      }

      totalTocados += tocados;
      resumen.push({
        store_id: storeId, ok: true, pedidos: pedidos.length,
        actualizados: tocados, con_boton: conBoton, mudos,
        sin_saliente: sinSaliente, dry_run: dryRun,
      });
    }

    storeId = "";
    await log("success", "", totalTocados);
    return json({ ok: true, actualizados: totalTocados, tiendas: resumen });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${SOURCE}]`, msg);
    await log("error", msg, null);
    // 200 con ok:false: el cron no debe reintentar en loop, y el badge lee
    // sync_logs, no el código HTTP.
    return json({ ok: false, error: msg });
  }
});
