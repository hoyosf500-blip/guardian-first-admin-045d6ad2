// dropi-verify-credentials — prueba EN VIVO las credenciales Dropi de una tienda.
//
// POR QUÉ EXISTE
// El asistente de configuración guardaba y decía "Tienda configurada" en verde
// sin probar nada. Un cliente podía terminar el setup con las tres credenciales
// mal y entrar a un CRM vacío creyendo que lo hizo bien.
//
// No se puede probar desde el navegador: api.dropi.co/ec no permite fetch
// cross-origin (misma razón por la que existe dropi-snapshot).
//
// LAS TRES PRUEBAS, en orden de dependencia:
//   1. api_key   → GET /integrations/orders/myorders. Si esto falla, el CRM
//                  nace vacío. Es lo único bloqueante.
//   2. login     → POST /api/login vía ensureFreshSessionToken(force). Es lo
//                  que mantiene viva la billetera PARA SIEMPRE. Si falta,
//                  la billetera muere en una hora (le pasó a Colombia).
//   3. billetera → GET /api/wallet/exportexcel con un rango de 1 día. Barato.
//
// Cada prueba devuelve su HTTP crudo; la interpretación (qué es bloqueante, qué
// es un throttle y no una credencial mala, qué mensaje ve el cliente) vive en
// src/lib/verificacionCredenciales.ts, que es puro y está testeado.
//
// SEGURIDAD: solo el DUEÑO de la tienda. Nunca devuelve tokens ni claves.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, isStoreOwner } from "../_shared/dropiStoreConfig.ts";
import { ensureFreshSessionToken } from "../_shared/dropiSessionLogin.ts";

interface Chequeo {
  clave: "api_key" | "login" | "billetera";
  ok: boolean;
  httpStatus?: number;
  mensaje?: string;
  muestra?: number;
  omitido?: boolean;
}

const TIMEOUT_MS = 25_000;

/** Recorta el mensaje de Dropi: va a la pantalla de un cliente, no a un log. */
function corto(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 200);
}

function hoyISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 1. ¿Podemos LEER SUS PEDIDOS? Lo único verdaderamente bloqueante.
 *
 *  ⚠️ El header `Origin` NO es opcional. Dropi contesta 401 `{"message":"Access
 *  denied", ..., "ip":"..."}` sin llegar a mirar la clave cuando falta, y como
 *  el cuerpo trae la IP parece un bloqueo por dirección — no lo es.
 *
 *  Medido el 2026-08-13 con la MISMA api_key de la tienda de Colombia:
 *  `dropi-snapshot` (que sí manda Origin) trajo 2.450 pedidos con HTTP 200,
 *  mientras esta función daba 401. Era la única diferencia entre las dos
 *  llamadas. `dropi-sync`, `dropi-health` y `dropi-snapshot` ya lo mandaban;
 *  esta se quedó sin él y por eso el asistente le decía "tu API Key no es
 *  válida" a TODO dueño nuevo, con la clave buena. */
async function probarApiKey(base: string, apiKey: string, origin: string): Promise<Chequeo> {
  if (!apiKey) {
    return { clave: "api_key", ok: false, mensaje: "No se cargó la API Key." };
  }
  const hoy = hoyISO();
  const url = `${base}/integrations/orders/myorders?result_number=1` +
    `&date_from=${hoy}&date_to=${hoy}&filter_date_by=${encodeURIComponent("FECHA DE CREADO")}`;
  try {
    const res = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "dropi-integration-key": apiKey,
        ...(origin ? { Origin: origin } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 200) {
      return {
        clave: "api_key",
        ok: false,
        httpStatus: res.status,
        mensaje: corto(await res.text().catch(() => "")),
      };
    }
    // 200 con cero pedidos NO es un fallo: una cuenta nueva no tiene pedidos
    // hoy. Marcarlo en rojo haría que el cliente cambie una clave que servía.
    const body = await res.json().catch(() => null);
    const objs = Array.isArray(body?.objects) ? body.objects : [];
    return { clave: "api_key", ok: true, httpStatus: 200, muestra: objs.length };
  } catch (e) {
    return {
      clave: "api_key",
      ok: false,
      httpStatus: 0,
      mensaje: corto(e instanceof Error ? e.message : String(e)),
    };
  }
}

/** 2. ¿Podemos ENTRAR A SU CUENTA? Lo que mantiene viva la billetera.
 *
 *  Si la tienda no tiene email/clave se marca `omitido`, NO `falla`: no está
 *  roto, está sin configurar, y son dos mensajes distintos para el cliente. */
async function probarLogin(
  // deno-lint-ignore no-explicit-any
  sb: any,
  cfg: { storeId: string; base: string; sessionToken: string },
  tieneCredenciales: boolean,
): Promise<{ chequeo: Chequeo; token: string }> {
  if (!tieneCredenciales) {
    return { chequeo: { clave: "login", ok: false, omitido: true }, token: "" };
  }
  try {
    // force: si no forzamos y el token guardado sigue vigente, devuelve ese y
    // NO probamos el login — que es exactamente lo que queremos verificar.
    const token = await ensureFreshSessionToken(sb, cfg, { force: true });
    if (!token) {
      return {
        chequeo: { clave: "login", ok: false, mensaje: "Dropi no devolvió token." },
        token: "",
      };
    }
    return { chequeo: { clave: "login", ok: true, httpStatus: 200 }, token };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // El mensaje de dropiSessionLogin ya nombra el 2FA cuando corresponde; la
    // capa pura lo detecta por texto y arma el consejo correcto.
    const m = msg.match(/\[(\d{3})\]/);
    return {
      chequeo: {
        clave: "login",
        ok: false,
        httpStatus: m ? Number(m[1]) : undefined,
        mensaje: corto(msg),
      },
      token: "",
    };
  }
}

/** 3. ¿Baja la BILLETERA? Un solo día para no gastar cuota ni tiempo. */
async function probarBilletera(base: string, token: string): Promise<Chequeo> {
  if (!token) return { clave: "billetera", ok: false, omitido: true };
  let userId = "";
  try {
    const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
    userId = String(payload?.sub ?? "");
  } catch {
    // Token no-JWT: dejamos que el endpoint decida en vez de fallar acá.
  }
  const hoy = hoyISO();
  // Los MISMOS parámetros que usa `dropi-wallet-sync`, que es el que de verdad
  // baja la billetera todos los días. Acá el nombre del parámetro de fecha
  // final iba mal escrito (con dos eles) y faltaba `wallet_id`: un chequeo que
  // no llama igual que la cosa que está comprobando puede reprobar algo que
  // funciona — es exactamente lo que pasó con el header `Origin` en el chequeo
  // de la API Key.
  const params = new URLSearchParams({ from: hoy, until: hoy, wallet_id: "0" });
  if (userId) params.set("user_id", userId);
  const url = `${base}/api/wallet/exportexcel?${params.toString()}`;
  try {
    const res = await fetch(url, {
      headers: {
        "Accept": "application/json, text/plain, */*",
        "x-authorization": `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 200) {
      return {
        clave: "billetera",
        ok: false,
        httpStatus: res.status,
        mensaje: corto(await res.text().catch(() => "")),
      };
    }
    const bytes = (await res.arrayBuffer()).byteLength;
    return { clave: "billetera", ok: true, httpStatus: 200, muestra: bytes };
  } catch (e) {
    return {
      clave: "billetera",
      ok: false,
      httpStatus: 0,
      mensaje: corto(e instanceof Error ? e.message : String(e)),
    };
  }
}

Deno.serve(async (req: Request) => {
  const CORS = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    const { data: userData } = await sb.auth.getUser(jwt);
    const userId = userData?.user?.id;
    if (!userId) return json({ ok: false, error: "No autenticado" }, 401);

    const { store_id } = await req.json().catch(() => ({}));
    if (!store_id) return json({ ok: false, error: "Falta store_id" }, 400);

    // Verificar credenciales toca secretos de la tienda: solo el dueño.
    if (!(await isStoreOwner(sb, userId, store_id))) {
      return json({ ok: false, error: "Solo el dueño puede verificar credenciales" }, 403);
    }

    const cfg = await loadStoreConfig(sb, store_id);

    // ¿Hay email y clave guardados? Query tolerante: si la migración del login
    // no corrió, degradamos a "sin credenciales" en vez de reventar.
    let tieneCredenciales = false;
    try {
      const { data } = await sb
        .from("store_dropi_config")
        .select("dropi_login_email, dropi_login_password")
        .eq("store_id", store_id)
        .maybeSingle();
      tieneCredenciales = Boolean(
        String(data?.dropi_login_email || "").trim() && String(data?.dropi_login_password || ""),
      );
    } catch { /* sin columnas de login */ }

    const chequeos: Chequeo[] = [];
    chequeos.push(await probarApiKey(cfg.base, cfg.apiKey, cfg.storeUrl));

    const { chequeo: chLogin, token } = await probarLogin(
      sb,
      { storeId: cfg.storeId, base: cfg.base, sessionToken: cfg.sessionToken },
      tieneCredenciales,
    );
    chequeos.push(chLogin);
    chequeos.push(await probarBilletera(cfg.base, token));

    console.log("[verify]", store_id, chequeos.map((c) => `${c.clave}:${c.ok ? "ok" : c.httpStatus ?? "x"}`).join(" "));

    return json({ ok: true, chequeos });
  } catch (e) {
    // Nunca 500 mudo: la pantalla necesita algo que mostrarle al cliente.
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 200);
  }
});
