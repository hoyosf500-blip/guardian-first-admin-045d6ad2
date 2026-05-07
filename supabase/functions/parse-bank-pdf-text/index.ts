// parse-bank-pdf-text — parsea texto extraído de un PDF de extracto Bancolombia
// (Mastercard o Amex) y retorna movimientos categorizados. Opcionalmente hace
// el upsert vía RPC.
//
// El cliente extrae el texto del PDF con pdfjs-dist (ver
// CfoPersonalCardUploader.tsx) y manda el texto plano a este endpoint. Hacer
// el parsing del PDF directamente en Deno requeriría dependencias pesadas
// (pdfjs-dist server-side) que no funcionan bien en edge runtime.
//
// Body:
//   { text: string,         // texto plano del PDF
//     filename: string,     // nombre original (origen_pdf)
//     dryRun?: boolean }    // si true, solo devuelve preview sin guardar
//
// Response:
//   { ok: true,
//     metadata: { tarjeta, marca, periodo_corte_from, periodo_corte_to },
//     movements: Movement[],
//     upsert?: { inserted, updated, total } }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";

interface Movement {
  tarjeta: string;
  marca: "mastercard" | "amex" | "otro";
  banco: string;
  fecha: string;                     // ISO YYYY-MM-DD
  descripcion: string;
  numero_autorizacion: string | null;
  monto: number;                     // positivo cargo, negativo abono
  moneda: "COP" | "USD";
  tipo: "compra" | "abono" | "intereses" | "comision" | "avance" | "otro";
  cuotas_total: number | null;
  cuota_numero: number | null;
  valor_cuota: number | null;
  interes_mensual_pct: number | null;
  interes_anual_pct: number | null;
  saldo_pendiente: number | null;
  periodo_corte_from: string | null; // ISO
  periodo_corte_to: string | null;   // ISO
  origen_pdf: string;
  raw_line: string;
}

interface Metadata {
  tarjeta: string;
  marca: "mastercard" | "amex" | "otro";
  periodo_corte_from: string | null;
  periodo_corte_to: string | null;
}

const MONTHS_ES: Record<string, number> = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12,
};

/** Parsea "$ 1.234.567,89" o "$1,234.56" → number. Si tiene "-" delante, negativo. */
function parseMoney(raw: string): number {
  const cleaned = raw.replace(/\$|\s/g, "").trim();
  if (!cleaned) return 0;

  const negative = cleaned.startsWith("-");
  const abs = cleaned.replace(/^-/, "");

  let normalized: string;
  if (abs.includes(".") && abs.includes(",")) {
    // formato latino "1.234.567,89" → punto miles, coma decimal
    normalized = abs.replace(/\./g, "").replace(",", ".");
  } else if (abs.includes(",")) {
    const parts = abs.split(",");
    if (parts[1]?.length === 2) {
      normalized = abs.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = abs.replace(/,/g, "");
    }
  } else {
    normalized = abs;
  }

  const n = Number(normalized);
  if (isNaN(n)) return 0;
  return negative ? -n : n;
}

/** "09/04/2026" → "2026-04-09" */
function parseDate(raw: string): string | null {
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

/** "15 mar - 15 abr. 2026" o "29 dic. 2025 - 15 ene. 2026" → {from, to} ISO */
function parsePeriodoCorte(text: string): { from: string | null; to: string | null } {
  const re = /(\d{1,2})\s+(\w{3})\.?\s*(\d{4})?\s*[-–]\s*(\d{1,2})\s+(\w{3})\.?\s*(\d{4})/i;
  const m = text.match(re);
  if (!m) return { from: null, to: null };

  const [, d1, mo1, y1raw, d2, mo2, y2] = m;
  const m1 = MONTHS_ES[mo1.toLowerCase()];
  const m2 = MONTHS_ES[mo2.toLowerCase()];
  if (!m1 || !m2) return { from: null, to: null };

  const y1 = y1raw || y2;
  const from = `${y1}-${String(m1).padStart(2, "0")}-${String(d1).padStart(2, "0")}`;
  const to = `${y2}-${String(m2).padStart(2, "0")}-${String(d2).padStart(2, "0")}`;
  return { from, to };
}

function parseMetadata(text: string): Metadata {
  const upper = text.toUpperCase();

  const tarjetaMatch = text.match(/Tarjeta:\s*\**(\d{4})/i) || text.match(/\*+(\d{4})/);
  const tarjeta = tarjetaMatch ? `*${tarjetaMatch[1]}` : "";

  let marca: "mastercard" | "amex" | "otro" = "otro";
  if (upper.includes("AMERICAN EXPRESS") || upper.includes("AMEX")) marca = "amex";
  else if (upper.includes("MASTERCARD")) marca = "mastercard";

  const periodoSection = text.match(/Periodo\s+facturado[\s\S]{0,200}/i)?.[0] || text;
  const { from, to } = parsePeriodoCorte(periodoSection);

  return { tarjeta, marca, periodo_corte_from: from, periodo_corte_to: to };
}

function detectTipo(descripcion: string): Movement["tipo"] {
  const u = descripcion.toUpperCase();
  if (u.startsWith("ABONO") || u.includes("PAGO TARJETA")) return "abono";
  if (u.startsWith("INTERESES")) return "intereses";
  if (u.startsWith("COMISION AVANCE")) return "comision";
  if (u.startsWith("AVANCE") || u.includes("ANTICIPO")) return "avance";
  return "compra";
}

function parseMovements(text: string, metadata: Metadata, filename: string): Movement[] {
  const movements: Movement[] = [];
  const lines = text.split(/\r?\n/);

  let monedaActual: "COP" | "USD" = "COP";
  let periodoFromActual = metadata.periodo_corte_from;
  let periodoToActual = metadata.periodo_corte_to;

  // Línea con N° autorización + fecha + descripción + monto + cuotas + ...
  const movRe = /^\s*([A-Z0-9]{5,7})?\s+(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+(-?\$\s?[\d.,]+)(?:\s+(\d+\/\d+))?(?:\s+(-?\$\s?[\d.,]+))?(?:\s+([\d.,]+\s*%))?(?:\s+([\d.,]+\s*%))?(?:\s+(-?\$\s?[\d.,]+))?\s*$/;

  // Línea sin N° autorización (intereses corrientes, etc.)
  const movSimpleRe = /^\s*(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+(-?\$\s?[\d.,]+)(?:\s+(-?\$\s?[\d.,]+))?(?:\s+(-?\$\s?[\d.,]+))?\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;

    const upperLine = line.toUpperCase();

    // Cambio de sección de moneda
    if (upperLine.includes("MONEDA: DOLARES")
        || (upperLine.includes("ESTADO DE CUENTA EN:") && upperLine.includes("DOLARES"))) {
      monedaActual = "USD";
      continue;
    }
    if (upperLine.includes("MONEDA: PESOS")
        || (upperLine.includes("ESTADO DE CUENTA EN:") && upperLine.includes("PESOS"))) {
      monedaActual = "COP";
      continue;
    }

    // Cambio de periodo
    if (upperLine.includes("PERIODO FACTURADO") || upperLine.includes("NUEVOS MOVIMIENTOS")) {
      const ctx = line + " " + (lines[i + 1] || "") + " " + (lines[i + 2] || "");
      const { from, to } = parsePeriodoCorte(ctx);
      if (to) {
        periodoFromActual = from;
        periodoToActual = to;
      }
      continue;
    }

    // Saltar headers y ruido
    if (upperLine.startsWith("NÚMERO DE") || upperLine.startsWith("AUTORIZACIÓN")
        || upperLine.startsWith("VR MONEDA ORIG") || upperLine.startsWith("DCF:")
        || upperLine.startsWith("BANCOLOMBIA") || upperLine.includes("RECUERDA ESTAR")) {
      continue;
    }

    let m = movRe.exec(line);
    let numAuth: string | null = null;
    let fechaRaw: string | null = null;
    let descripcion = "";
    let montoRaw = "";
    let cuotasRaw: string | undefined;
    let valorCuotaRaw: string | undefined;
    let interesMesRaw: string | undefined;
    let interesAnioRaw: string | undefined;
    let saldoRaw: string | undefined;

    if (m) {
      [, numAuth, fechaRaw, descripcion, montoRaw, cuotasRaw, valorCuotaRaw, interesMesRaw, interesAnioRaw, saldoRaw] = m;
    } else {
      m = movSimpleRe.exec(line);
      if (!m) continue;
      [, fechaRaw, descripcion, montoRaw, valorCuotaRaw, saldoRaw] = m;
    }

    const fecha = parseDate(fechaRaw!);
    if (!fecha) continue;

    descripcion = descripcion.trim();
    if (!descripcion || descripcion.length < 2) continue;

    const monto = parseMoney(montoRaw);
    if (monto === 0 && !descripcion.toUpperCase().includes("ABONO")) {
      continue;
    }

    let cuotas_total: number | null = null;
    let cuota_numero: number | null = null;
    if (cuotasRaw) {
      const cm = cuotasRaw.match(/^(\d+)\/(\d+)$/);
      if (cm) {
        cuota_numero = Number(cm[1]);
        cuotas_total = Number(cm[2]);
      }
    }

    const valor_cuota = valorCuotaRaw ? parseMoney(valorCuotaRaw) : null;
    const saldo_pendiente = saldoRaw ? parseMoney(saldoRaw) : null;

    let interes_mensual_pct: number | null = null;
    let interes_anual_pct: number | null = null;
    if (interesMesRaw) {
      const v = Number(interesMesRaw.replace(/[^\d.,]/g, "").replace(",", "."));
      if (!isNaN(v)) interes_mensual_pct = v;
    }
    if (interesAnioRaw) {
      const v = Number(interesAnioRaw.replace(/[^\d.,]/g, "").replace(",", "."));
      if (!isNaN(v)) interes_anual_pct = v;
    }

    const tipo = detectTipo(descripcion);

    movements.push({
      tarjeta: metadata.tarjeta,
      marca: metadata.marca,
      banco: "Bancolombia",
      fecha,
      descripcion,
      numero_autorizacion: numAuth?.trim() || null,
      monto,
      moneda: monedaActual,
      tipo,
      cuotas_total,
      cuota_numero,
      valor_cuota,
      interes_mensual_pct,
      interes_anual_pct,
      saldo_pendiente,
      periodo_corte_from: periodoFromActual,
      periodo_corte_to: periodoToActual,
      origen_pdf: filename,
      raw_line: line.trim().slice(0, 500),
    });
  }

  return movements;
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, error: "No autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sbUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

    const anonClient = createClient(sbUrl, anonKey);
    const { data: { user }, error: authError } = await anonClient.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ ok: false, error: "Token inválido" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Audit H1: PDFs de TC personal del dueño — solo admin puede subir.
    const sbAdmin = createClient(sbUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: roleRow } = await sbAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) {
      return new Response(
        JSON.stringify({ ok: false, error: "Solo administradores pueden subir PDFs personales" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json().catch(() => ({}));
    const text = String(body.text || "");
    const filename = String(body.filename || "extracto.pdf");
    const dryRun = Boolean(body.dryRun);

    if (!text || text.length < 50) {
      return new Response(
        JSON.stringify({ ok: false, error: "Texto del PDF vacío o demasiado corto" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const metadata = parseMetadata(text);
    if (!metadata.tarjeta) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "No se pudo detectar la tarjeta. ¿Es un extracto de Bancolombia?",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const movements = parseMovements(text, metadata, filename);

    if (movements.length === 0) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "No se detectó ningún movimiento. Revisar formato del PDF.",
          metadata,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (dryRun) {
      return new Response(
        JSON.stringify({ ok: true, metadata, movements, dryRun: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Upsert con sesión del usuario (RLS valida admin vía SECURITY DEFINER del RPC)
    const userClient = createClient(sbUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: upsertResult, error: upsertError } = await userClient.rpc(
      "upsert_personal_card_movements",
      { p_movements: movements },
    );

    if (upsertError) {
      console.error("Upsert error:", upsertError);
      return new Response(
        JSON.stringify({ ok: false, error: upsertError.message, metadata, movements }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        metadata,
        movements_count: movements.length,
        upsert: upsertResult,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("parse-bank-pdf-text error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: String((err as Error)?.message || err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
