// chateapro-sync — que Guardian se entere de quién escribió y sigue esperando.
//
// Gemelo de `importchat-sync` para las tiendas de Colombia. Escribe en el
// pedido `chat_entrante_at` / `chat_saliente_at`, que es lo que alimenta la
// bandeja «Escribieron», la rayita de actividad del tablero, el «Te respondió»
// y el ciclo de contacto.
//
// ── Por qué se escribió (medido, no supuesto) ──────────────────────────────
// El 2-sep-2026, con las tres funciones de chat de Colombia ya funcionando, se
// contaron los 800 contactos de la cuenta: **39 clientes habían escrito y
// nadie les había contestado.** 36 llevaban más de 2 horas, **22 más de un
// día** y el más viejo **97 horas**. Entre ellos:
//
//   · una clienta con el pedido en NOVEDAD (la transportadora esperando
//     respuesta) que había escrito 28 horas antes,
//   · otra a la que le acababa de salir la guía,
//   · y 27 personas sin pedido registrado: preguntaron y nadie las atendió.
//
// Guardian no podía verlos. En la base, misma hora: Ecuador 2.196 pedidos con
// `chat_entrante_at` de 3.426; **Colombia 0 de 589**. Y la pantalla no decía
// "no lo puedo medir en esta tienda" — decía *«Nadie esperando respuesta —
// todos los que escribieron ya fueron atendidos 🎉»*. Un cero afirmado sobre
// un dato que nunca existió es peor que no tener la pantalla: la asesora la
// mira, la ve vacía y se va tranquila.
//
// ── Por qué es MUCHO más simple que el de Ecuador ──────────────────────────
// ImporChat obliga a bajar un XLSX de 48.000 filas y ~9 MB, que ya mató a esa
// función dos veces por memoria y CPU. Chatea Pro devuelve `last_message_at` y
// `last_message_type` en la propia lista de contactos: 8 llamadas REST de 100
// contactos y está todo. No hay zip, no hay parser, no hay presupuesto de
// memoria — solo el de reloj, que se respeta igual.
//
// Auth: service_role. Es un cron; no hay camino de usuario.
// Body: {} (todas las tiendas con Chatea Pro) | { store_id } (solo esa).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { respuestaPing } from "../_shared/versionEdge.ts";
import { cargarConfigChateapro, listarSuscriptores, ChateaproError } from "../_shared/chateaproApi.ts";
import { cambiosDeChat, type ContactoCp, type PedidoCruce } from "../_shared/chateaproCruce.ts";

const SOURCE = "chateapro-sync";
/** ⛔ Subirla en el mismo commit que cambie algo: si no, el ping miente. */
const VERSION = "chateapro-sync 2026-09-02.1 la-bandeja-deja-de-mentir";

/** Tope de la API (lo dice la spec; más devuelve 400). */
const PAGINA = 100;
/** 20 páginas = 2.000 contactos por tienda. La cuenta de Colombia tiene ~800. */
const MAX_PAGINAS = 20;
/** Ventana de pedidos a cruzar. La misma que usa Seguimiento. */
const DIAS = 45;
/** Presupuesto de reloj por debajo del límite del edge, para que SIEMPRE
 *  alcance a cerrar la fila de `sync_logs`. Mismo criterio que dropi-cron. */
const BUDGET_MS = 110_000;

/** Colombia y Ecuador comparten huso; el resto se resuelve cuando exista. */
const OFFSET: Record<string, number> = { CO: -5, EC: -5, GT: -6 };

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  { const p = respuestaPing(req, VERSION, cors); if (p) return p; }

  const t0 = Date.now();
  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  // ── Rastro que sobrevive a una muerte ─────────────────────────────────────
  // La plataforma puede matar la función sin darle un `catch`. Se abre una fila
  // 'running' al arrancar y se le escribe la fase; si muere, esa fila dice
  // dónde quedó. Sin esto, desde afuera es idéntico a "nunca se llamó" — que
  // es exactamente lo que pasó siete veces con el sync de Ecuador.
  let storeId = "";
  let trazaId: string | null = null;
  let huboError = false;

  const filaLog = (status: string, msg: string, n: number) => {
    const f: Record<string, unknown> = { source: SOURCE, status, error_message: msg || null, synced_count: n };
    // ⛔ `store_id` y `synced_count` son NOT NULL: mandarles null hace que
    // Postgres RECHACE la fila y supabase-js NO lanza, así que el try/catch no
    // se entera y la corrida queda sin registro.
    if (storeId) f.store_id = storeId;
    return f;
  };
  const traza = async (fase: string, n = 0) => {
    try {
      if (trazaId == null) {
        const { data, error } = await sb.from("sync_logs")
          .insert(filaLog("running", fase, n)).select("id").maybeSingle();
        if (error) console.error(`[${SOURCE}] sync_logs rechazó la traza: ${error.code} ${error.message}`);
        trazaId = (data as { id?: string } | null)?.id ?? null;
      } else {
        const { error } = await sb.from("sync_logs").update({
          error_message: fase, synced_count: n, ...(storeId ? { store_id: storeId } : {}),
        }).eq("id", trazaId);
        if (error) console.error(`[${SOURCE}] no se pudo actualizar la traza: ${error.message}`);
      }
    } catch (e) { console.error(`[${SOURCE}] traza:`, e); }
  };
  const cerrar = async (status: string, msg: string, n: number) => {
    // Un 'success' NO puede pisar un 'error' ya escrito.
    if (status === "success" && huboError) status = "warn";
    if (status === "error") huboError = true;
    try {
      if (trazaId != null) {
        await sb.from("sync_logs").update({
          status, error_message: msg || null, synced_count: n,
          ...(storeId ? { store_id: storeId } : {}),
        }).eq("id", trazaId);
      } else {
        await sb.from("sync_logs").insert(filaLog(status, msg, n));
      }
    } catch (e) { console.error(`[${SOURCE}] cerrar:`, e); }
  };

  try {
    const body = await req.json().catch(() => ({}));
    const pedida = String(body?.store_id || "").trim();

    await traza("fase 1: buscando tiendas con Chatea Pro");

    // Qué tiendas mirar. La lista sale de quién TIENE credenciales, no de una
    // lista escrita a mano: una tienda nueva entra sola.
    const { data: cfgs, error: cfgErr } = await sb.from("store_chateapro_config")
      .select("store_id, habilitado");
    if (cfgErr) throw new Error(`no pude leer store_chateapro_config: ${cfgErr.message}`);
    let tiendas = (cfgs ?? [])
      .filter((c: { habilitado?: boolean }) => c.habilitado !== false)
      .map((c: { store_id: string }) => c.store_id);
    if (pedida) tiendas = tiendas.filter((s: string) => s === pedida);

    if (tiendas.length === 0) {
      await cerrar("success", "ninguna tienda con Chatea Pro configurado", 0);
      return json({ ok: true, version: VERSION, tiendas: 0, escritos: 0 });
    }

    const desde = new Date(Date.now() - DIAS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let escritosTotal = 0;
    const detalle: Array<Record<string, unknown>> = [];

    for (const sid of tiendas) {
      if (Date.now() - t0 > BUDGET_MS) {
        // Se corta ANTES de empezar otra tienda, no a mitad. La próxima corrida
        // la toma: el cruce es idempotente, no hay nada que reanudar.
        await cerrar("warn", `se acabó el tiempo con ${tiendas.length - detalle.length} tienda(s) sin mirar`, escritosTotal);
        return json({ ok: true, version: VERSION, parcial: true, escritos: escritosTotal, detalle });
      }
      storeId = sid;
      await traza(`fase 2: leyendo contactos de ${sid}`, escritosTotal);

      const cfg = await cargarConfigChateapro(sb, sid);
      if (!cfg) { detalle.push({ store_id: sid, saltada: "sin credenciales" }); continue; }

      const { data: tienda } = await sb.from("stores").select("country_code").eq("id", sid).maybeSingle();
      const offset = OFFSET[String(tienda?.country_code || "CO").toUpperCase()] ?? -5;

      // ── Los contactos ──────────────────────────────────────────────────
      const contactos: ContactoCp[] = [];
      let pagina = 1;
      try {
        for (; pagina <= MAX_PAGINAS; pagina++) {
          if (Date.now() - t0 > BUDGET_MS) break;
          const lote = await listarSuscriptores(cfg, pagina, PAGINA);
          if (lote.length === 0) break;
          for (const c of lote) contactos.push(c as ContactoCp);
          if (lote.length < PAGINA) break;
        }
      } catch (e) {
        // Una tienda que falla NO puede dejar a las demás sin sincronizar.
        const msg = e instanceof ChateaproError && e.status === 401
          ? "la API key de Chatea Pro no es válida o venció"
          : (e instanceof Error ? e.message : String(e));
        huboError = true;
        detalle.push({ store_id: sid, error: msg, contactos: contactos.length });
        console.error(`[${SOURCE}] ${sid}: ${msg}`);
        continue;
      }

      // ── Los pedidos de la ventana ──────────────────────────────────────
      const { data: pedidos, error: pedErr } = await sb.from("orders")
        .select("external_id, phone, fecha, chat_entrante_at, chat_saliente_at")
        .eq("store_id", sid).gte("fecha", desde);
      if (pedErr) {
        huboError = true;
        detalle.push({ store_id: sid, error: `no pude leer pedidos: ${pedErr.message}` });
        continue;
      }

      const cambios = cambiosDeChat(contactos, (pedidos ?? []) as PedidoCruce[], offset);
      await traza(`fase 3: escribiendo ${cambios.length} pedidos de ${sid}`, escritosTotal);

      // ── UPDATE DIRIGIDO por (store_id, external_id) ────────────────────
      // ⛔ NO se pasa por `upsert_orders_from_dropi` (REGLA #1) ni se toca
      // estado, valor o guía: Chatea Pro no manda sobre eso. Solo las columnas
      // de chat.
      const ahora = new Date().toISOString();
      let escritos = 0;
      for (const c of cambios) {
        if (Date.now() - t0 > BUDGET_MS) break;
        const { error } = await sb.from("orders").update({
          ...(c.chat_entrante_at ? { chat_entrante_at: c.chat_entrante_at } : {}),
          ...(c.chat_saliente_at ? { chat_saliente_at: c.chat_saliente_at } : {}),
          ...(c.chat_saliente_tipo ? { chat_saliente_tipo: c.chat_saliente_tipo } : {}),
          chat_leido_at: ahora,
        }).eq("store_id", sid).eq("external_id", c.external_id);
        if (error) console.error(`[${SOURCE}] ${sid}/${c.external_id}: ${error.message}`);
        else escritos++;
      }
      escritosTotal += escritos;

      const esperando = contactos.filter((c) => String(c.last_message_type ?? "") === "in").length;
      detalle.push({ store_id: sid, contactos: contactos.length, esperando, escritos });
    }

    storeId = "";
    await cerrar(huboError ? "warn" : "success", `${escritosTotal} pedidos con dato de chat`, escritosTotal);
    return json({ ok: true, version: VERSION, escritos: escritosTotal, detalle, ms: Date.now() - t0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${SOURCE}]`, msg);
    await cerrar("error", msg, 0);
    return json({ ok: false, version: VERSION, error: msg }, 500);
  }
});
