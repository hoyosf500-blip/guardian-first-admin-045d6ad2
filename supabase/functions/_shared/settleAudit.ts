// Settle SERVER-AUTHORITATIVE de las auditorías de edición (order_results).
//
// POR QUÉ (2026-07-13, caso Antonio Pilco #6110990): el cliente insertaba la
// fila 'pending' y la promovía con un UPDATE por JWT... que RLS bloqueaba EN
// SILENCIO (order_results no tenía política UPDATE) → toda edición exitosa
// quedaba 'pending' eterna y el panel la gritaba como "Edición no aplicada"
// (falso positivo). Además del fix de RLS, las edges settlean acá con service
// role en CADA outcome terminal — sobrevive incluso a la muerte de la pestaña.
//
// Guardas: solo la fila PROPIA del operador y solo si sigue 'pending'
// (idempotente: un auditId ajeno o ya settleado no toca nada).

export async function settleAuditRow(
  // deno-lint-ignore no-explicit-any
  sbAdmin: any,
  auditId: string,
  userId: string,
  status: "synced" | "failed",
  notes?: string,
): Promise<void> {
  try {
    await sbAdmin.from("order_results")
      .update({
        dropi_sync_status: status,
        ...(notes ? { result_notes: notes.slice(0, 300) } : {}),
      })
      .eq("id", auditId)
      .eq("operator_id", userId)
      .eq("dropi_sync_status", "pending");
  } catch (e) {
    console.error("[settleAudit] settle falló (no fatal):", e);
  }
}

/** Deriva status+nota de settle desde el payload de respuesta de la edge —
 *  espeja EXACTAMENTE la semántica del cliente (OrderEditorDialog):
 *  synced si ok===true o dropiAccepted===true (Dropi guardó aunque la ficha
 *  local haya fallado); failed el resto, con nota según el code. */
export function deriveSettleFromPayload(
  payload: Record<string, unknown>,
): { status: "synced" | "failed"; notes?: string } {
  const err = String(payload.error || "").slice(0, 250);
  if (payload.ok === true) {
    if (payload.noChange === true) return { status: "synced", notes: "Sin cambios que empujar a Dropi" };
    if (payload.warning) return { status: "synced", notes: `Edición OK con aviso: ${String(payload.warning)}` };
    return { status: "synced" };
  }
  if (payload.dropiAccepted === true) {
    return { status: "synced", notes: `Dropi guardó los datos pero falló la ficha local: ${err}` };
  }
  if (payload.code === "creacion_incierta") {
    return { status: "failed", notes: `EDICIÓN INCIERTA — no reintentar: ${err}` };
  }
  return { status: "failed", notes: `EDICIÓN falló: ${err}` };
}
