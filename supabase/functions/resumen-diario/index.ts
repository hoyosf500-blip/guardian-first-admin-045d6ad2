// supabase/functions/resumen-diario/index.ts
//
// El resumen del día, por correo, al dueño de cada tienda.
//
// ── Por qué existe ──────────────────────────────────────────────────────────
// Guardian no tenía NINGUNA vía de aviso saliente: cero correo, cero
// mensajería en todo el repo. Si nadie abría la pantalla, nadie se enteraba de
// nada. El dueño pidió "que el colaborador sepa qué hacer sin yo estar
// encima" — y eso solo se sostiene si él se entera sin ir a mirar.
//
// ── Cómo evita inventar datos ───────────────────────────────────────────────
// El correo cuenta dos cosas y NO las mezcla: lo que el equipo DECLARÓ al
// cerrar (`seg_cierres`) y lo que la base cuenta sola (entregados, cancelados,
// novedades abiertas, pedidos sin fecha de movimiento).
//
// Ninguna de esas cifras redefine una regla de negocio. En particular **no se
// reimplementa `esAccionable` en SQL**: esa definición vive en `segLists.ts` y
// ya la aplicó el cliente al firmar el cierre. Una segunda definición en el
// servidor se desincroniza sola — es el error que dejó el contador clavado en
// 222 y el que hizo que el hero y el panel del turno mostraran "9 de 32" y
// "21 de 32" al mismo tiempo, en la misma pantalla.
//
// ── Multi-tienda ────────────────────────────────────────────────────────────
// TODA consulta va con `store_id`. El resumen de una empresa no puede llevar ni
// un número de otra: es la regla más dura de esta operación. Por eso tampoco se
// leen `daily_reports` ni `operator_daily_reports`, que NO tienen `store_id` y
// cruzarían tiendas sin avisar.
//
// ── Correo ──────────────────────────────────────────────────────────────────
// Se manda por Resend (HTTP, sin librería SMTP). Sin `RESEND_API_KEY` la
// función NO finge: responde diciendo que falta la clave y deja la fila en
// `sync_logs`. Un "enviado" en verde sin destinatario sería exactamente el tipo
// de mentira que este trabajo viene corrigiendo.
//
// Auth: `x-cron-secret` (pg_cron) o admin global con Bearer. Body opcional
// `{ store_id?, dry_run? }` — `dry_run` devuelve el texto SIN mandarlo.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { construirResumen, type CierreDeAsesora, type DatosResumen } from "../_shared/resumenDiario.ts";

const json = (b: unknown, s = 200, h: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...h, "Content-Type": "application/json" } });

/** Día calendario de Bogotá. NUNCA `toISOString()` de la hora local: después
 *  de las 19:00 de Bogotá la fecha UTC ya es la de mañana, y el resumen de hoy
 *  se armaría sobre un día que todavía no existe. */
function diaBogota(): string {
  return new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
}

function diaLegible(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dias = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
    "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${dias[dt.getUTCDay()]}, ${d} de ${meses[m - 1]}`;
}

// deno-lint-ignore no-explicit-any
type SB = any;

/** Estados que siguen VIVOS. Se listan explícitamente: contar "todo lo que no
 *  es terminal" haría que un estado nuevo de Dropi entrara como vivo sin que
 *  nadie lo decida. */
const VIVOS = [
  "EN PROCESAMIENTO", "GUIA GENERADA", "EN BODEGA TRANSPORTADORA",
  "EN TRANSITO", "EN REPARTO", "NOVEDAD", "EN OFICINA", "PENDIENTE",
];

async function juntarDatos(sb: SB, store: { id: string; name: string }): Promise<{
  datos: DatosResumen; ownerIds: string[];
}> {
  const dia = diaBogota();
  const desdeUtc = new Date(`${dia}T05:00:00.000Z`).toISOString(); // 00:00 Bogotá

  const [cierresRes, miembrosRes, novedadesRes, entregadosRes, canceladosRes, sinFechaRes, syncRes] =
    await Promise.all([
      sb.from("seg_cierres")
        .select("operator_id, cola, gestionados, faltaron, motivo")
        .eq("store_id", store.id).eq("dia", dia),
      sb.from("store_members").select("user_id, role").eq("store_id", store.id),
      sb.from("orders").select("id", { count: "exact", head: true })
        .eq("store_id", store.id).eq("estado", "NOVEDAD"),
      // ⛔ `last_movement_at` y NO `updated_at`: esa columna NO EXISTE en
      // `orders` (verificado el 21-ago-2026 — la primera versión de este
      // archivo la usaba). PostgREST devolvía error, el conteo llegaba en
      // null y el `?? 0` lo imprimía como "Entregados hoy: 0". Un día entero
      // de entregas convertido en un cero con cara de dato medido.
      sb.from("orders").select("id", { count: "exact", head: true })
        .eq("store_id", store.id).eq("estado", "ENTREGADO").gte("last_movement_at", desdeUtc),
      sb.from("orders").select("id", { count: "exact", head: true })
        .eq("store_id", store.id).eq("estado", "CANCELADO").gte("last_movement_at", desdeUtc),
      sb.from("orders").select("id", { count: "exact", head: true })
        .eq("store_id", store.id).in("estado", VIVOS).is("last_movement_at", null),
      sb.from("sync_logs").select("created_at")
        .eq("store_id", store.id).in("source", ["dropi-cron", "dropi"])
        .eq("status", "success").order("created_at", { ascending: false }).limit(1),
    ]);

  // Nombres: `profiles` para que el correo diga "Ana" y no un UUID. La clave es
  // `user_id`, NO `id`: `profiles` tiene las dos columnas y son distintas.
  const miembros = (miembrosRes.data || []) as { user_id: string; role: string }[];
  const ids = miembros.map((m) => m.user_id);
  const nombres = new Map<string, string>();
  if (ids.length) {
    const { data: perfiles } = await sb.from("profiles").select("user_id, display_name").in("user_id", ids);
    for (const p of (perfiles || []) as { user_id: string; display_name: string | null }[]) {
      if (p.display_name) nombres.set(p.user_id, p.display_name);
    }
  }

  const cierres: CierreDeAsesora[] = ((cierresRes.data || []) as {
    operator_id: string; cola: number; gestionados: number; faltaron: number; motivo: string | null;
  }[]).map((c) => ({
    nombre: nombres.get(c.operator_id) || "Sin nombre",
    cola: c.cola, gestionados: c.gestionados, faltaron: c.faltaron, motivo: c.motivo,
  }));

  const ultimoSync = (syncRes.data || [])[0] as { created_at: string } | undefined;

  const datos: DatosResumen = {
    tienda: store.name,
    dia: diaLegible(dia),
    cierres,
    // Los `owner` no se cuentan como turno: el dueño mira, no trabaja la cola.
    // Contarlo haría que el correo le reclame a él por no cerrar todos los días.
    asesorasDelTurno: miembros.filter((m) => m.role !== "owner").length,
    novedadesAbiertas: novedadesRes.count ?? 0,
    // Si la consulta falló, va `null` y el correo dice "sin dato". Un 0 acá se
    // lee como un día sin entregas, que es una afirmación que nadie midió.
    entregadosHoy: entregadosRes.error ? null : (entregadosRes.count ?? 0),
    canceladosHoy: canceladosRes.error ? null : (canceladosRes.count ?? 0),
    sinFechaDeMovimiento: sinFechaRes.count ?? 0,
    minutosDesdeSync: ultimoSync
      ? Math.floor((Date.now() - new Date(ultimoSync.created_at).getTime()) / 60_000)
      : null,
  };

  return { datos, ownerIds: miembros.filter((m) => m.role === "owner").map((m) => m.user_id) };
}

/** Correo del dueño de la tienda. `stores` no guarda ninguno: el dato vive en
 *  `auth.users`, y solo la service-role lo puede leer. Se resuelve por
 *  `store_members` (role='owner') para que el resumen de una empresa NUNCA
 *  pueda salir hacia el correo de otra. */
async function correoDelDueno(sb: SB, ownerIds: string[]): Promise<string> {
  for (const id of ownerIds) {
    const { data, error } = await sb.auth.admin.getUserById(id);
    if (!error && data?.user?.email) return data.user.email as string;
  }
  return "";
}

async function enviar(apiKey: string, from: string, para: string, asunto: string, texto: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [para], subject: asunto, text: texto }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    // ── Auth: cron secret o admin global ──────────────────────────
    const { data: secretRow } = await sb
      .from("app_settings").select("value").eq("key", "cron_shared_secret").maybeSingle();
    const cronSecret = String(secretRow?.value || "");
    const cronHeader = req.headers.get("x-cron-secret");
    if (cronHeader) {
      if (!cronSecret || cronHeader !== cronSecret) {
        return json({ error: "Cron secret inválido" }, 401, cors);
      }
    } else {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) return json({ error: "No autorizado" }, 401, cors);
      if (authHeader !== `Bearer ${serviceKey}`) {
        const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
        const anon = createClient(supabaseUrl, anonKey);
        const { data: { user }, error } = await anon.auth.getUser(authHeader.replace("Bearer ", ""));
        if (error || !user) return json({ error: "Token inválido" }, 401, cors);
        const { data: rol } = await sb.from("user_roles")
          .select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
        if (!rol) return json({ error: "Solo administradores" }, 403, cors);
      }
    }

    const body = await req.json().catch(() => ({})) as { store_id?: string; dry_run?: boolean };
    const dryRun = body.dry_run === true;

    const apiKey = Deno.env.get("RESEND_API_KEY") || "";
    const from = Deno.env.get("RESUMEN_FROM") || "Guardian <onboarding@resend.dev>";
    // Sin clave NO se finge un envío. Un "OK" en verde sin destinatario es
    // justo la clase de mentira que este trabajo viene corrigiendo.
    if (!apiKey && !dryRun) {
      const msg = "Falta RESEND_API_KEY: el resumen se armó pero no se pudo enviar.";
      await sb.from("sync_logs").insert({
        source: "resumen-diario", status: "error", synced_count: 0, error_message: msg,
      }).then(() => {}, () => {});
      return json({ ok: false, error: msg }, 200, cors);
    }

    // `stores` NO tiene `is_active` ni `owner_email` (verificado contra la base
    // el 21-ago-2026): la columna de estado es `status`.
    let q = sb.from("stores").select("id, name, status");
    if (body.store_id) q = q.eq("id", body.store_id);
    const { data: stores, error: storesErr } = await q;
    if (storesErr) return json({ error: storesErr.message }, 500, cors);

    const salida: Record<string, unknown>[] = [];
    for (const store of (stores || []) as { id: string; name: string; status?: string }[]) {
      // Fail-closed: solo tiendas explícitamente activas. Un status nuevo que
      // nadie previó no debería empezar a mandar correos solo.
      if (store.status !== "active") continue;
      const { datos, ownerIds } = await juntarDatos(sb, store);
      const resumen = construirResumen(datos);

      // Destinatario: el dueño de ESTA tienda. Si no hay a quién mandarle, se
      // dice — no se manda al dueño de la plataforma "por las dudas", que
      // mezclaría los números de una empresa con otra.
      const para = await correoDelDueno(sb, ownerIds);
      if (dryRun || !para) {
        salida.push({
          store_id: store.id, tienda: store.name, enviado: false,
          motivo: dryRun ? "dry_run" : "la tienda no tiene correo de dueño",
          asunto: resumen.asunto, texto: resumen.texto,
        });
        continue;
      }

      try {
        await enviar(apiKey, from, para, resumen.asunto, resumen.texto);
        salida.push({ store_id: store.id, tienda: store.name, enviado: true, para, titular: resumen.titular });
        await sb.from("sync_logs").insert({
          source: "resumen-diario", status: "success", synced_count: 1,
          store_id: store.id, error_message: null,
        }).then(() => {}, () => {});
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        salida.push({ store_id: store.id, tienda: store.name, enviado: false, motivo: msg });
        await sb.from("sync_logs").insert({
          source: "resumen-diario", status: "error", synced_count: 0,
          store_id: store.id, error_message: msg,
        }).then(() => {}, () => {});
      }
    }

    return json({ ok: true, dry_run: dryRun, tiendas: salida.length, resultados: salida }, 200, cors);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500, cors);
  }
});
