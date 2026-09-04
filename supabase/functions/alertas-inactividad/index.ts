// alertas-inactividad — le avisa al DUEÑO, por correo y sin que esté conectado,
// cuando una asesora lleva ≥30 min sin ninguna gestión en horario laboral, o
// cuando 45 min después del inicio del turno todavía no entró (3-sep-2026).
//
// Lo dispara pg_cron cada 10 min (`20260904160000_alertas_dueno_cron.sql`) con
// el mismo `x-cron-secret` de resumen-diario. Sin RESEND_API_KEY no finge nada:
// deja un `error` en sync_logs. La decisión es pura (`_shared/alertasInactividad.ts`,
// probada en src/lib/alertasInactividad.test.ts); acá solo se juntan datos, se
// dedupea contra `alertas_dueno` y se manda.
//
// ⛔ Mide lo que Guardian registra. Una llamada sin marcar no cuenta, y el
// correo lo dice. El dueño (role owner) nunca es vigilado: mira, no trabaja.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { respuestaPing } from "../_shared/versionEdge.ts";
import { OFFSET_HORAS } from "../_shared/horaLocal.ts";
import { decidirAlertas, redactarCorreo, type Alerta, type TipoAlerta } from "../_shared/alertasInactividad.ts";

const VERSION = "alertas-inactividad 2026-09-04.1 el-dueno-se-entera-sin-estar";

const UMBRAL_INACTIVIDAD_MIN = 30;
const GRACIA_ENTRADA_MIN = 45;
/** Un aviso de inactividad por persona cada 90 min mientras siga igual. */
const REPETIR_INACTIVA_MS = 90 * 60_000;

// deno-lint-ignore no-explicit-any
type SB = any;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

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
}

interface Tienda {
  id: string; name: string; status?: string; country_code?: string | null;
  work_start_min?: number | null; work_end_min?: number | null;
  lunch_start_min?: number | null; lunch_end_min?: number | null;
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  { const p = respuestaPing(req, VERSION, cors); if (p) return p; }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    // ── Auth: cron secret o admin global (mismo esquema que resumen-diario) ──
    const { data: secretRow } = await sb.from("app_settings").select("value").eq("key", "cron_shared_secret").maybeSingle();
    const cronSecret = String(secretRow?.value || "");
    const cronHeader = req.headers.get("x-cron-secret");
    if (cronHeader) {
      if (!cronSecret || cronHeader !== cronSecret) return json({ error: "Cron secret inválido" }, 401, cors);
    } else {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) return json({ error: "No autorizado" }, 401, cors);
      if (authHeader !== `Bearer ${serviceKey}`) {
        const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
        const anon = createClient(supabaseUrl, anonKey);
        const { data: { user }, error } = await anon.auth.getUser(authHeader.replace("Bearer ", ""));
        if (error || !user) return json({ error: "Token inválido" }, 401, cors);
        const { data: rol } = await sb.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
        if (!rol) return json({ error: "Solo administradores" }, 403, cors);
      }
    }

    const body = await req.json().catch(() => ({})) as { store_id?: string; store_ids?: string[]; dry_run?: boolean };
    const dryRun = body.dry_run === true;
    const apiKey = Deno.env.get("RESEND_API_KEY") || "";
    const from = Deno.env.get("RESUMEN_FROM") || "Guardian <onboarding@resend.dev>";
    if (!apiKey && !dryRun) {
      const msg = "Falta RESEND_API_KEY: las alertas al dueño no se pueden mandar.";
      await sb.from("sync_logs").insert({ source: "alertas-inactividad", status: "error", synced_count: 0, error_message: msg }).then(() => {}, () => {});
      return json({ ok: false, error: msg }, 200, cors);
    }

    let q = sb.from("stores").select("id, name, status, country_code, work_start_min, work_end_min, lunch_start_min, lunch_end_min");
    if (body.store_id) q = q.eq("id", body.store_id);
    else if (body.store_ids?.length) q = q.in("id", body.store_ids);
    const { data: stores, error: storesErr } = await q;
    if (storesErr) return json({ error: storesErr.message }, 500, cors);

    const ahora = new Date();
    const salida: Record<string, unknown>[] = [];

    for (const store of (stores || []) as Tienda[]) {
      if (store.status !== "active") continue;
      const cc = String(store.country_code || "CO").toUpperCase();
      const off = OFFSET_HORAS[cc] ?? -5;
      const localMs = ahora.getTime() + off * 3600_000;
      const local = new Date(localMs);
      const minutoLocal = local.getUTCHours() * 60 + local.getUTCMinutes();
      const horaLocal = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
      // Medianoche LOCAL de hoy, en UTC: es el "desde" de todas las lecturas.
      const inicioDiaUtc = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - off * 3600_000).toISOString();

      const horario = {
        workStartMin: Number(store.work_start_min ?? 540),
        workEndMin: Number(store.work_end_min ?? 1080),
        lunchStartMin: Number(store.lunch_start_min ?? 0),
        lunchEndMin: Number(store.lunch_end_min ?? 0),
      };
      // Corte barato antes de leer nada: fuera de turno no hay a quién avisar.
      if (minutoLocal < horario.workStartMin || minutoLocal >= horario.workEndMin) {
        salida.push({ store: store.name, fuera_de_turno: true });
        continue;
      }

      const [miembrosRes, resultadosRes, toquesRes, pausasRes, avisadasRes] = await Promise.all([
        sb.from("store_members").select("user_id, role").eq("store_id", store.id),
        sb.from("order_results").select("operator_id, created_at").eq("store_id", store.id).gte("created_at", inicioDiaUtc).limit(5000),
        sb.from("touchpoints").select("operator_id, created_at").eq("store_id", store.id).gte("created_at", inicioDiaUtc).limit(5000),
        sb.from("operator_pausas").select("operator_id").eq("store_id", store.id).is("fin", null).gte("inicio", inicioDiaUtc),
        sb.from("alertas_dueno").select("operator_id, tipo, created_at").eq("store_id", store.id).gte("created_at", inicioDiaUtc),
      ]);
      // ⛔ Con cualquier lectura caída NO se decide: un "no entró" sobre una
      // consulta que falló es una acusación inventada.
      const caida = [miembrosRes, resultadosRes, toquesRes, pausasRes, avisadasRes].find((r) => r.error);
      if (caida) {
        const msg = caida.error?.message || "error desconocido";
        console.error(`[alertas-inactividad] lectura falló (${store.name}):`, msg);
        salida.push({ store: store.name, error: msg });
        continue;
      }

      const miembros = (miembrosRes.data || []) as { user_id: string; role: string }[];
      const trabajan = miembros.filter((m) => m.role === "operator" || m.role === "supervisor");
      if (trabajan.length === 0) { salida.push({ store: store.name, sin_equipo: true }); continue; }
      const nombres = new Map<string, string>();
      const { data: perfiles } = await sb.from("profiles").select("user_id, display_name").in("user_id", trabajan.map((m) => m.user_id));
      for (const p of (perfiles || []) as { user_id: string; display_name: string | null }[]) {
        if (p.display_name) nombres.set(p.user_id, p.display_name);
      }

      const ultima = new Map<string, number>();
      const anotar = (r: { operator_id: string | null; created_at: string | null }) => {
        if (!r.operator_id || !r.created_at) return;
        const t = Date.parse(r.created_at);
        if (!Number.isFinite(t)) return;
        if ((ultima.get(r.operator_id) ?? 0) < t) ultima.set(r.operator_id, t);
      };
      for (const r of (resultadosRes.data || []) as { operator_id: string | null; created_at: string | null }[]) anotar(r);
      for (const r of (toquesRes.data || []) as { operator_id: string | null; created_at: string | null }[]) anotar(r);
      const enPausa = new Set(((pausasRes.data || []) as { operator_id: string }[]).map((p) => p.operator_id));

      const avisadas = (avisadasRes.data || []) as { operator_id: string; tipo: string; created_at: string }[];
      const yaAvisado = (userId: string, tipo: TipoAlerta): boolean => {
        const mias = avisadas.filter((a) => a.operator_id === userId && a.tipo === tipo);
        if (tipo === "no_entro") return mias.length > 0;
        return mias.some((a) => ahora.getTime() - Date.parse(a.created_at) < REPETIR_INACTIVA_MS);
      };

      const alertas: Alerta[] = decidirAlertas({
        ahoraMs: ahora.getTime(),
        minutoLocal,
        horario,
        miembros: trabajan.map((m) => ({ userId: m.user_id, nombre: nombres.get(m.user_id) || "Sin nombre" })),
        ultimaGestionMs: ultima,
        enPausa,
        yaAvisado,
        umbralInactividadMin: UMBRAL_INACTIVIDAD_MIN,
        graciaEntradaMin: GRACIA_ENTRADA_MIN,
      });
      if (alertas.length === 0) { salida.push({ store: store.name, alertas: 0 }); continue; }

      const ownerIds = miembros.filter((m) => m.role === "owner").map((m) => m.user_id);
      const para = await correoDelDueno(sb, ownerIds);
      const { asunto, texto } = redactarCorreo(store.name, alertas, horaLocal, horario);
      if (dryRun || !para) {
        salida.push({ store: store.name, alertas: alertas.length, para: para || null, dry_run: dryRun, asunto, texto });
        if (!para && !dryRun) {
          await sb.from("sync_logs").insert({
            source: "alertas-inactividad", status: "warn", synced_count: 0, store_id: store.id,
            error_message: `${alertas.length} alerta(s) sin destinatario: la tienda no tiene dueño con correo.`,
          }).then(() => {}, () => {});
        }
        continue;
      }
      try {
        await enviar(apiKey, from, para, asunto, texto);
        // Se anota DESPUÉS de mandar: si el envío falla, la próxima corrida lo
        // vuelve a intentar en vez de creer que ya avisó.
        await sb.from("alertas_dueno").insert(alertas.map((a) => ({
          store_id: store.id, operator_id: a.userId, tipo: a.tipo, minutos: a.minutos,
        })));
        await sb.from("sync_logs").insert({
          source: "alertas-inactividad", status: "warn", synced_count: alertas.length, store_id: store.id,
          error_message: `${asunto} → ${para}`,
        }).then(() => {}, () => {});
        salida.push({ store: store.name, alertas: alertas.length, enviado: true, para });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[alertas-inactividad] envío falló (${store.name}):`, msg);
        await sb.from("sync_logs").insert({
          source: "alertas-inactividad", status: "error", synced_count: 0, store_id: store.id,
          error_message: `No se pudo mandar el correo de alertas: ${msg}`.slice(0, 500),
        }).then(() => {}, () => {});
        salida.push({ store: store.name, alertas: alertas.length, enviado: false, error: msg });
      }
    }

    return json({ ok: true, version: VERSION, tiendas: salida }, 200, cors);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[alertas-inactividad] error inesperado:", msg);
    return json({ ok: false, error: msg }, 500, cors);
  }
});
