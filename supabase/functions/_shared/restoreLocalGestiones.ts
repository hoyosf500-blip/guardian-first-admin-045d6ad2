/**
 * Re-aplica sobre `orders` la gestión LOCAL que el upsert de Dropi pudo pisar.
 *
 * Dropi puede seguir en "PENDIENTE CONFIRMACION" cuando la asesora ya
 * confirmó/canceló acá y el PUT falló o demora. Sin esto el pedido gestionado
 * REAPARECE en /confirmar y la asesora re-llama a un cliente que ya respondió.
 *
 * ⛔ Se resuelve en UNA sola pasada porque conf y canc compiten por el mismo
 * pedido: con dos queries independientes el UPDATE de conf dejaba el pedido en
 * PENDIENTE y el de canc ya no matcheaba su WHERE, así que una cancelación de
 * las 11am perdía contra una confirmación de las 9am — y el retry terminaba
 * CONFIRMANDO en Dropi un pedido que el cliente rechazó (guía, despacho y
 * devolución de ~$22k). Acá manda la gestión MÁS RECIENTE y cada pedido va a UN
 * solo update.
 *
 * El WHERE estado='PENDIENTE CONFIRMACION' es el guard real: lo que Dropi ya
 * refleja (PENDIENTE / CANCELADO) no se toca.
 *
 * ⛔ POR QUÉ VIVE ACÁ Y NO COPIADA EN CADA FUNCIÓN (30-ago-2026):
 * estaba duplicada en `dropi-sync` y `dropi-refresh-batch`, y a `dropi-cron`
 * —el único que corre SOLO cada 10-20 min, sin que nadie mire— **nunca le
 * llegó**: seguía con la versión vieja que leía `result='conf'` únicamente, y
 * encima su consulta de "confirmadas trabadas" no tenía cota de fecha, así que
 * una confirmación fallida de CUALQUIER día pasado resucitaba una cancelación
 * de hoy. Es el mismo patrón de la ficha de producto duplicada: se arregla una
 * copia y el bug sigue vivo en la otra. Una sola definición.
 */

export const RESTORE_WINDOW_DAYS = 7;

export interface RestoreResultado {
  /** Gestiones EVALUADAS (no filas escritas): el update no devuelve count y la
   *  mayoría no matchea el WHERE porque Dropi ya refleja la gestión. */
  confCandidates: number;
  cancCandidates: number;
  error: string | null;
}

export async function restoreLocalGestiones(
  // deno-lint-ignore no-explicit-any
  sb: any,
  storeId: string,
): Promise<RestoreResultado> {
  const windowFrom = new Date();
  windowFrom.setUTCDate(windowFrom.getUTCDate() - RESTORE_WINDOW_DAYS);
  const fromDate = windowFrom.toISOString().split("T")[0];

  const { data: gestiones, error } = await sb
    .from("order_results")
    .select("order_id, result, created_at")
    .eq("store_id", storeId)
    .in("result", ["conf", "canc"])
    .gte("result_date", fromDate)
    .order("created_at", { ascending: true });

  if (error) {
    // Fallar acá y seguir en silencio dejaría gestiones pisadas sin que nadie se
    // entere: se devuelve el motivo para que el caller lo surfacee.
    return { confCandidates: 0, cancCandidates: 0, error: error.message || String(error) };
  }

  // Orden ascendente ⇒ el último set() por order_id es la gestión más reciente.
  const winner = new Map<string, string>();
  for (const r of (gestiones ?? []) as Array<{ order_id: string; result: string }>) {
    winner.set(r.order_id, r.result);
  }

  const confIds: string[] = [];
  const cancIds: string[] = [];
  for (const [orderId, result] of winner) {
    (result === "canc" ? cancIds : confIds).push(orderId);
  }

  for (let i = 0; i < confIds.length; i += 50) {
    const { error: upErr } = await sb.from("orders").update({ estado: "PENDIENTE" })
      .in("id", confIds.slice(i, i + 50))
      .eq("store_id", storeId)
      .eq("estado", "PENDIENTE CONFIRMACION");
    if (upErr) {
      return { confCandidates: confIds.length, cancCandidates: cancIds.length, error: upErr.message || String(upErr) };
    }
  }
  for (let i = 0; i < cancIds.length; i += 50) {
    const { error: upErr } = await sb.from("orders").update({ estado: "CANCELADO" })
      .in("id", cancIds.slice(i, i + 50))
      .eq("store_id", storeId)
      .eq("estado", "PENDIENTE CONFIRMACION");
    if (upErr) {
      return { confCandidates: confIds.length, cancCandidates: cancIds.length, error: upErr.message || String(upErr) };
    }
  }
  return { confCandidates: confIds.length, cancCandidates: cancIds.length, error: null };
}
