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
import { construirResumen, type AsistenciaAsesora, type CierreDeAsesora, type DatosResumen } from "../_shared/resumenDiario.ts";
import { respuestaPing } from "../_shared/versionEdge.ts";
import { fechaHoraLocal, OFFSET_HORAS } from "../_shared/horaLocal.ts";

const json = (b: unknown, s = 200, h: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...h, "Content-Type": "application/json" } });

/** Día calendario LOCAL de la tienda. NUNCA `toISOString()` de la hora local:
 *  después de las 19:00 la fecha UTC ya es la de mañana, y el resumen de hoy se
 *  armaría sobre un día que todavía no existe. Por país (4-sep-2026): antes
 *  era `-5h` fijo, y Guatemala es UTC−6 — de 00:00 a 01:00 su resumen se
 *  armaba sobre AYER. Mismo offset que usan los touchpoints de las edge. */
function diaLocal(countryCode: string | null | undefined): string {
  return fechaHoraLocal(countryCode).fecha;
}

/** Las 00:00 locales de `dia`, en UTC — el piso de los conteos "de hoy". */
function inicioDiaUtc(dia: string, countryCode: string | null | undefined): string {
  const off = OFFSET_HORAS[String(countryCode || "").toUpperCase()] ?? -5;
  const [y, m, d] = dia.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - off * 3600_000).toISOString();
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

async function juntarDatos(sb: SB, store: { id: string; name: string; country_code?: string | null }): Promise<{
  datos: DatosResumen; ownerIds: string[];
}> {
  const cc = store.country_code ?? null;
  const dia = diaLocal(cc);
  const desdeUtc = inicioDiaUtc(dia, cc); // 00:00 local de la tienda
  const hastaUtc = new Date(Date.parse(desdeUtc) + 86_400_000).toISOString();

  const [cierresRes, miembrosRes, novedadesRes, entregadosRes, canceladosRes, sinFechaRes, syncRes, resultadosRes, toquesRes, pausasRes] =
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
      // Asistencia (4-sep-2026): primera/última gestión y cuántas, por persona.
      // Un día de una tienda son cientos de filas, no miles: el límite es de
      // seguridad, no un recorte esperado.
      sb.from("order_results").select("operator_id, created_at")
        .eq("store_id", store.id).gte("created_at", desdeUtc).lt("created_at", hastaUtc).limit(5000),
      sb.from("touchpoints").select("operator_id, created_at")
        .eq("store_id", store.id).gte("created_at", desdeUtc).lt("created_at", hastaUtc).limit(5000),
      sb.from("operator_pausas").select("operator_id, inicio, fin")
        .eq("store_id", store.id).gte("inicio", desdeUtc).lt("inicio", hastaUtc).limit(1000),
    ]);

  // ⛔ Los tres que no leían `.error` (4-sep-2026): con `store_members` caída,
  // `asesorasDelTurno` era 0 y el titular decía "Seguimiento cerró en cero";
  // con `seg_cierres` caída, "Nadie cerró el día". Ahora lo que no se pudo
  // leer viaja como null/false y el correo lo dice con esas palabras.
  const miembrosLeidos = !miembrosRes.error;
  const cierresLeidos = !cierresRes.error;
  if (miembrosRes.error) console.error(`[resumen-diario] store_members falló (${store.name}):`, miembrosRes.error.message);
  if (cierresRes.error) console.error(`[resumen-diario] seg_cierres falló (${store.name}):`, cierresRes.error.message);
  if (syncRes.error) console.error(`[resumen-diario] sync_logs falló (${store.name}):`, syncRes.error.message);

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

  const ultimoSync = syncRes.error ? undefined : ((syncRes.data || [])[0] as { created_at: string } | undefined);

  // ── Asistencia: quién entró, cuándo, cuánto hizo, cuántas pausas ─────────
  const noOwners = miembros.filter((m) => m.role !== "owner");
  let asistencia: AsistenciaAsesora[] | null = null;
  if (miembrosLeidos && !resultadosRes.error && !toquesRes.error && !pausasRes.error) {
    type Acum = { ts: number[]; gestiones: number; pausas: number; minutos: number };
    const porOp = new Map<string, Acum>();
    for (const m of noOwners) porOp.set(m.user_id, { ts: [], gestiones: 0, pausas: 0, minutos: 0 });
    for (const r of (resultadosRes.data || []) as { operator_id: string | null; created_at: string | null }[]) {
      const a = r.operator_id ? porOp.get(r.operator_id) : undefined;
      const t = r.created_at ? Date.parse(r.created_at) : NaN;
      if (a && Number.isFinite(t)) a.ts.push(t);
    }
    for (const r of (toquesRes.data || []) as { operator_id: string | null; created_at: string | null }[]) {
      const a = r.operator_id ? porOp.get(r.operator_id) : undefined;
      if (!a) continue;
      a.gestiones += 1;
      const t = r.created_at ? Date.parse(r.created_at) : NaN;
      if (Number.isFinite(t)) a.ts.push(t);
    }
    for (const p of (pausasRes.data || []) as { operator_id: string | null; inicio: string; fin: string | null }[]) {
      const a = p.operator_id ? porOp.get(p.operator_id) : undefined;
      if (!a) continue;
      a.pausas += 1;
      if (p.fin) {
        const ms = Date.parse(p.fin) - Date.parse(p.inicio);
        if (Number.isFinite(ms) && ms > 0) a.minutos += Math.round(ms / 60_000);
      }
    }
    asistencia = noOwners.map((m) => {
      const a = porOp.get(m.user_id)!;
      const min = a.ts.length ? Math.min(...a.ts) : null;
      const max = a.ts.length ? Math.max(...a.ts) : null;
      return {
        nombre: nombres.get(m.user_id) || "Sin nombre",
        primera: min != null ? fechaHoraLocal(cc, new Date(min)).hora : null,
        ultima: max != null ? fechaHoraLocal(cc, new Date(max)).hora : null,
        gestiones: a.gestiones,
        pausas: a.pausas,
        minutosPausa: a.minutos,
      };
    }).sort((x, y) => y.gestiones - x.gestiones || x.nombre.localeCompare(y.nombre));
  } else {
    for (const [nombre, res] of [["order_results", resultadosRes], ["touchpoints", toquesRes], ["operator_pausas", pausasRes]] as const) {
      if (res.error) console.error(`[resumen-diario] ${nombre} falló (${store.name}):`, res.error.message);
    }
  }

  const datos: DatosResumen = {
    tienda: store.name,
    dia: diaLegible(dia),
    cierres,
    cierresLeidos,
    // Los `owner` no se cuentan como turno: el dueño mira, no trabaja la cola.
    // Contarlo haría que el correo le reclame a él por no cerrar todos los días.
    asesorasDelTurno: miembrosLeidos ? noOwners.length : null,
    asistencia,
    // Si la consulta falló, va `null` y el correo dice "sin dato". Un 0 acá se
    // lee como un día sin entregas, que es una afirmación que nadie midió.
    //
    // ⛔ El arreglo se había aplicado a DOS de los cuatro conteos del mismo
    // Promise.all (30-ago-2026). Los otros dos quedaron con `?? 0`, así que el
    // correo de las 21:00 podía decirle al dueño «Novedades abiertas: 0» sobre
    // un día que nunca se pudo medir — y eso se lee como buena noticia, así que
    // no revisa la cola.
    novedadesAbiertas: novedadesRes.error ? null : (novedadesRes.count ?? 0),
    entregadosHoy: entregadosRes.error ? null : (entregadosRes.count ?? 0),
    canceladosHoy: canceladosRes.error ? null : (canceladosRes.count ?? 0),
    sinFechaDeMovimiento: sinFechaRes.error ? null : (sinFechaRes.count ?? 0),
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

/**
 * Marca de versión desplegada. Se contesta con `?ping=1` y NO toca la base.
 * ⛔ Subila en TODO commit que cambie esta función o algo que importa: es lo
 *    único que distingue "Lovable dijo que desplegó" de "está desplegado".
 *    El guardián `src/test/edgeVersionPing.test.ts` exige que exista y que el
 *    ping se conteste ANTES de cualquier auth.
 */
const VERSION = "resumen-diario 2026-09-04.1 quien-trabajo-hoy-y-lo-no-leido-se-dice";

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Antes de auth y sin tocar la base: "¿qué versión está desplegada?".
  { const p = respuestaPing(req, VERSION, cors); if (p) return p; }

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

    const body = await req.json().catch(() => ({})) as {
      store_id?: string; store_ids?: string[]; dry_run?: boolean;
    };
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
    let q = sb.from("stores").select("id, name, status, country_code");
    // `store_ids` existe porque esto manda correo HACIA AFUERA: los dueños de
    // las otras tiendas de la plataforma son terceros, y empezar a escribirles
    // sin que nadie lo decida es una acción que no se puede deshacer. Con la
    // lista, el cron se puede arrancar solo con las tiendas propias y abrirse
    // después. Sin ninguna de las dos, sigue yendo a todas las activas.
    if (body.store_id) q = q.eq("id", body.store_id);
    else if (body.store_ids?.length) q = q.in("id", body.store_ids);
    const { data: stores, error: storesErr } = await q;
    if (storesErr) return json({ error: storesErr.message }, 500, cors);

    const salida: Record<string, unknown>[] = [];
    for (const store of (stores || []) as { id: string; name: string; status?: string; country_code?: string | null }[]) {
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
