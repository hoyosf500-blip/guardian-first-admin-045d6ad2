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
import {
  cargarConfigChateapro,
  listarSuscriptores,
  listarPlantillas,
  buscarSuscriptorPorTelefono,
  leerHilo,
  ChateaproError,
} from "../_shared/chateaproApi.ts";
import { plantillasQueConfirman, senalDeHilo } from "../_shared/chateaproSenal.ts";
import { cambiosDeChat, type ContactoCp, type PedidoCruce } from "../_shared/chateaproCruce.ts";

const SOURCE = "chateapro-sync";
/** ⛔ Subirla en el mismo commit que cambie algo: si no, el ping miente. */
const VERSION = "chateapro-sync 2026-09-02.3 los-de-hoy-primero";

/** Tope de la API (lo dice la spec; más devuelve 400). */
const PAGINA = 100;
/** 20 páginas = 2.000 contactos por tienda. La cuenta de Colombia tiene ~800. */
const MAX_PAGINAS = 20;
/** Ventana de pedidos a cruzar. La misma que usa Seguimiento. */
const DIAS = 45;
/** Presupuesto de reloj por debajo del límite del edge, para que SIEMPRE
 *  alcance a cerrar la fila de `sync_logs`. Mismo criterio que dropi-cron. */
const BUDGET_MS = 110_000;
/**
 * ⛔ CUÁNTO TIEMPO HAY QUE TENER LIBRE PARA EMPEZAR A LEER HILOS.
 *
 * La pregunta correcta NO es "¿queda algo de tiempo?" sino "¿queda SUFICIENTE
 * para lo que viene?". Con 1 ms libre, el sync de Ecuador se metía igual en una
 * operación de decenas de segundos, la plataforma lo mataba a mitad y la fila
 * de `sync_logs` quedaba en `running` para siempre: desde afuera, idéntico a
 * "nunca corrió". Fueron 82 corridas colgadas de 197 y CERO errores.
 */
const RESERVA_HILOS_MS = 25_000;
/**
 * Cuántos pedidos leer por corrida. Cada uno son 2 llamadas (buscar el contacto
 * + leer el hilo), así que 30 son ~60 llamadas cada 10 min. Es un tope de
 * cortesía con la API, no un límite del problema: lo que no entra hoy entra en
 * la corrida siguiente, porque la selección se ordena por lo más viejo sin leer.
 */
const HILOS_POR_CORRIDA = 30;
/** Solo se mira la señal en la ventana donde todavía sirve para algo: la
 *  mediana entre que sale la plantilla y que aprietan es 0,0 h, y a los 3 días
 *  el pedido ya se despachó o se cayó. */
const DIAS_SENAL = 3;

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

      // ── FASE 4: la señal del botón CONFIRMAR PEDIDO ───────────────────
      // Es lo que más plata mueve de todo este archivo. Medido en Ecuador
      // (765 pedidos resueltos de agosto-2026): quien aprieta el botón cancela
      // 10,4%; quien no lo aprieta, 57,7% — $3.928, el 62% de toda la plata
      // cancelada del mes. Y se sabe enseguida: la mediana entre que sale la
      // plantilla y que aprietan es 0,0 h.
      //
      // Acá SÍ hay que abrir conversaciones, así que va con dos frenos: solo
      // los pedidos de los últimos días (después la señal ya no sirve para
      // nada) y un tope por corrida. Lo que no entra hoy entra en la próxima:
      // se ordena por lo más viejo sin leer.
      let conSenal = 0;
      /**
       * De los que se miraron, a cuántos se les llegó a OFRECER el botón.
       *
       * Se cuenta y se reporta porque la tasa que hace valiosa a esta señal
       * (10% contra 58%) se midió sobre pedidos que SÍ recibieron la plantilla.
       * Si en esta tienda casi nadie la recibe —el bot de Colombia es
       * conversacional, no siempre manda plantilla—, entonces la mayoría de los
       * "tibio" no significan "no confirmó": significan "nunca se le preguntó".
       * Eso hay que verlo en el log, no descubrirlo con la cola mal ordenada.
       */
      let conPlantilla = 0;
      const ciegos: string[] = [];
      if (Date.now() - t0 < BUDGET_MS - RESERVA_HILOS_MS) {
        try {
          // ⛔ Las plantillas que confirman se DESCUBREN, no se escriben a mano.
          // En Ecuador cambiar la plantilla en el panel apagó la señal dos días
          // enteros sin un solo error en el log (58% → 2% → 0%).
          const confirmadoras = plantillasQueConfirman(await listarPlantillas(cfg));
          if (confirmadoras.size === 0) {
            huboError = true;
            console.error(`[${SOURCE}] ${sid}: NINGUNA plantilla ofrece el botón de confirmar — la señal quedaría en cero`);
          }

          const desdeSenal = new Date(Date.now() - DIAS_SENAL * 86_400_000).toISOString().slice(0, 10);
          /**
           * ⛔ EL ORDEN ES LA DECISIÓN, y la primera versión lo tenía AL REVÉS.
           *
           * Estaba `fecha ascending` —los más viejos primero— copiando la idea
           * de "reanudable" del sync de Ecuador. Verificado en producción el
           * 2-sep-2026 con la función ya desplegada: escribió 30 señales y los
           * dos pedidos que yo había medido a mano (88110734 CANDIDA VILORIA,
           * que APRETÓ el botón, y 88111168 DEYANIR BARRERA, que no) quedaron
           * los dos en `null`. Son de hoy, y con más de 30 pedidos en la
           * ventana los de hoy nunca llegan al cupo.
           *
           * Y son justo los que importan: la mediana entre que sale la
           * plantilla y que aprietan es 0,0 h, y esta señal existe para ordenar
           * la cola de Confirmar de HOY. Un pedido de hace tres días ya se
           * despachó o se cayó.
           *
           * Por eso van dos consultas y no un `order` compuesto:
           *   1. Los que NO tienen señal todavía, del más nuevo al más viejo.
           *   2. Con lo que sobre del cupo, refrescar los que ya la tienen pero
           *      no están confirmados — alguien puede apretar el botón dos
           *      horas después, y sin este paso quedaría marcado "mudo" para
           *      siempre.
           * Un pedido ya `confirmado` no se relee: ese estado no se deshace.
           */
          const nuevos = await sb.from("orders")
            .select("external_id, phone")
            .eq("store_id", sid).gte("fecha", desdeSenal)
            .is("chat_riesgo", null)
            .order("fecha", { ascending: false })
            .limit(HILOS_POR_CORRIDA);

          const aMirar = [...((nuevos.data ?? []) as Array<{ external_id: string; phone: string | null }>)];
          if (aMirar.length < HILOS_POR_CORRIDA) {
            const refresco = await sb.from("orders")
              .select("external_id, phone")
              .eq("store_id", sid).gte("fecha", desdeSenal)
              .not("chat_riesgo", "is", null)
              .neq("chat_riesgo", "confirmado")
              .order("fecha", { ascending: false })
              .limit(HILOS_POR_CORRIDA - aMirar.length);
            aMirar.push(...((refresco.data ?? []) as Array<{ external_id: string; phone: string | null }>));
          }

          for (const o of aMirar) {
            if (Date.now() - t0 > BUDGET_MS) break;
            if (!o.phone) continue;
            const sus = await buscarSuscriptorPorTelefono(cfg, String(o.phone), String(tienda?.country_code || "CO"));
            // Sin contacto no hay conversación que leer. NO es "no confirmó":
            // es que no se pudo mirar, y eso se llama `sin_dato`.
            if (!sus) continue;
            const hilo = await leerHilo(cfg, sus.user_ns);
            const senal = senalDeHilo(hilo.mensajes, confirmadoras);
            if (senal.botonesDesconocidos.length) ciegos.push(...senal.botonesDesconocidos);
            if (senal.recibioPlantilla) conPlantilla++;
            const { error } = await sb.from("orders").update({
              chat_riesgo: senal.riesgo,
              chat_mudo: senal.riesgo === "mudo",
              confirmo_boton_at: senal.apretoBotonAt ? senal.apretoBotonAt.toISOString() : null,
              chat_cliente_escribio_at: senal.clienteEscribioAt ? senal.clienteEscribioAt.toISOString() : null,
              chat_leido_at: new Date().toISOString(),
            }).eq("store_id", sid).eq("external_id", o.external_id);
            if (error) console.error(`[${SOURCE}] señal ${sid}/${o.external_id}: ${error.message}`);
            else conSenal++;
          }
        } catch (e) {
          // La señal es un extra: si falla, el cruce de más arriba ya quedó
          // escrito y la bandeja sigue funcionando.
          huboError = true;
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[${SOURCE}] ${sid} señal: ${msg}`);
          detalle.push({ store_id: sid, error_senal: msg });
        }
      }

      const esperando = contactos.filter((c) => String(c.last_message_type ?? "") === "in").length;
      // ⛔ Un botón que no sabemos leer se GRITA. Sin esto, cablear una
      // plantilla nueva apaga la señal sin dar ningún error — el modo de falla
      // que costó dos días de asesoras llamando a gente ya confirmada.
      if (ciegos.length) {
        huboError = true;
        console.error(`[${SOURCE}] ${sid}: botones que no sé leer → ${[...new Set(ciegos)].join(" | ")}`);
      }
      detalle.push({
        store_id: sid, contactos: contactos.length, esperando, escritos,
        con_senal: conSenal, recibieron_plantilla_confirmacion: conPlantilla,
        ...(ciegos.length ? { botones_desconocidos: [...new Set(ciegos)] } : {}),
      });
    }

    storeId = "";
    const ciegosTodos = detalle.flatMap((d) => (d.botones_desconocidos as string[]) ?? []);
    await cerrar(
      huboError ? "warn" : "success",
      ciegosTodos.length
        ? `${escritosTotal} pedidos con dato de chat — ⛔ BOTONES QUE NO SÉ LEER: ${[...new Set(ciegosTodos)].join(" | ")}`
        : `${escritosTotal} pedidos con dato de chat`,
      escritosTotal,
    );
    return json({ ok: true, version: VERSION, escritos: escritosTotal, detalle, ms: Date.now() - t0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${SOURCE}]`, msg);
    await cerrar("error", msg, 0);
    return json({ ok: false, version: VERSION, error: msg }, 500);
  }
});
