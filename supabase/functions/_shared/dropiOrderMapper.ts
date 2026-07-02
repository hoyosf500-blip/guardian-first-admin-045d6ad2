// Mapeo de un objeto orden de Dropi (GET /integrations/orders/myorders o
// GET /integrations/orders/{id}) a una fila de la tabla `orders`. Antes vivía
// inline en supabase/functions/dropi-sync/index.ts; se extrajo para que
// dropi-refresh-order (single-order refresh) también lo use sin duplicar.
//
// IMPORTANTE: Si Dropi cambia el shape del objeto orden, actualizar acá UNA
// vez en lugar de en cada call-site.

/** Una fila lista para upsert en order_status_history (historial real de Dropi). */
export interface StatusHistoryRow {
  dropi_history_id: number;
  order_id: string;     // uuid de orders.id (FK)
  store_id: string;
  external_id: string;  // id de Dropi (texto)
  status: string;
  changed_at: string;   // ISO timestamp (created_at de la entrada en Dropi)
}

/**
 * Extrae el historial de estados que Dropi devuelve en `o.history[]` y lo mapea
 * a filas de order_status_history. Dropi entrega el recorrido COMPLETO del pedido
 * (PENDIENTE → GUIA_GENERADA → PREPARADO → DESPACHADA → EN REPARTO → …) en la
 * misma respuesta que el sync ya baja — ingerirlo da el timeline real sin pedir
 * nada extra a Dropi.
 *
 * Defensivo: si `o.history` no viene (o no es array), devuelve []. El sync sigue
 * funcionando igual (cero regresión). Cada entrada necesita id + status +
 * created_at para ser válida; las incompletas se descartan.
 *
 * @param orderId uuid de orders.id (resuelto tras el upsert por external_id).
 */
export function extractStatusHistoryRows(
  o: Record<string, unknown>,
  orderId: string,
  storeId: string,
): StatusHistoryRow[] {
  const hist = Array.isArray(o.history) ? (o.history as Array<Record<string, unknown>>) : [];
  if (hist.length === 0) return [];
  const externalId = String(o.id ?? "");
  const rows: StatusHistoryRow[] = [];
  for (const h of hist) {
    const dropiHistoryId = Number(h?.id);
    const status = String(h?.status ?? "").trim();
    const changedAt = String(h?.created_at ?? "").trim();
    if (!Number.isFinite(dropiHistoryId) || dropiHistoryId <= 0 || !status || !changedAt) continue;
    rows.push({
      dropi_history_id: dropiHistoryId,
      order_id: orderId,
      store_id: storeId,
      external_id: externalId,
      status,
      changed_at: changedAt,
    });
  }
  return rows;
}

/** Días calendario desde una fecha-string hasta hoy (server time). */
export function calcDiasCal(dateStr: string): number {
  if (!dateStr) return 0;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 0;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  } catch {
    return 0;
  }
}

/** Mapea una orden cruda de Dropi al schema de la tabla `orders`. */
export function mapDropiOrderToRow(
  o: Record<string, unknown>,
  userId: string,
  today: string,
  storeId: string,
): Record<string, unknown> {
  const products = (o.orderdetails as Array<Record<string, unknown>>) || [];
  const productName = products
    .map((p) => (p.product as Record<string, unknown>)?.name || "")
    .filter(Boolean)
    .join(", ");
  const cantidad = products.reduce(
    (sum, p) => sum + (parseFloat(String(p.quantity || "1")) || 1),
    0,
  );
  // Product cost = Σ (supplier_price o sale_price) × CANTIDAD por línea.
  // FIX 2026-07-02: antes NO multiplicaba por quantity → en pedidos multi-unidad
  // costo_prod quedaba subcontado (mayo EC: $639 vs $761 reales = COGS 31.3% vs
  // 37.3%) e inflaba la ganancia del simulador y product_profitability.
  const costoProd = products.reduce((sum, p) => {
    const supplierPrice = parseFloat(String(p.supplier_price || "0")) || 0;
    const salePrice =
      parseFloat(String((p.product as Record<string, unknown>)?.sale_price || "0")) || 0;
    const qty = parseFloat(String(p.quantity || "1")) || 1;
    return sum + (supplierPrice || salePrice) * qty;
  }, 0);

  const createdAt = String(o.created_at || "");
  const updatedAt = String(o.updated_at || "");
  const fecha = createdAt ? createdAt.split("T")[0] : today;

  // Determine fecha_conf from updated_at if status changed from PENDIENTE CONFIRMACION
  const status = String(o.status || "PENDIENTE").toUpperCase();
  const isPendConf = status === "PENDIENTE CONFIRMACION";
  const fechaConf = !isPendConf && updatedAt ? updatedAt.split("T")[0] : null;

  // Extract novedad from novedad_servientrega or servientrega_movements
  const novedadServ = o.novedad_servientrega ? String(o.novedad_servientrega) : "";
  const movements = (o.servientrega_movements as Array<Record<string, unknown>>) || [];
  const lastMovement =
    movements.length > 0
      ? String(
          movements[movements.length - 1]?.description ||
            movements[movements.length - 1]?.status ||
            "",
        )
      : "";
  const novedad = novedadServ || lastMovement;

  // Tags
  const tags = Array.isArray(o.tags)
    ? (o.tags as Array<Record<string, unknown>>)
        .map((t) => String(t.name || t))
        .filter(Boolean)
        .join(", ")
    : String(o.tags || "");

  // Shop/tienda name
  const shop = o.shop as Record<string, unknown> | null;
  const tienda = shop ? String(shop.name || "") : "";

  // Guia: prefer shipping_guide
  const guia = String(o.shipping_guide || "");

  // Distribution company (transportadora)
  const distCompany = o.distribution_company as Record<string, unknown> | null;
  const transportadora = distCompany
    ? String(distCompany.name || o.shipping_company || "")
    : String(o.shipping_company || "");

  // Novedad solucionada
  const novedadSol = Boolean(o.issue_solved_by_operator || o.managed_devolution_app);

  return {
    external_id: String(o.id || ""),
    uploaded_by: userId,
    store_id: storeId,
    upload_date: today,
    nombre: `${o.name || ""} ${o.surname || ""}`.trim() || "Sin nombre",
    phone: String(o.phone || "").replace(/[^0-9]/g, ""),
    ciudad: String(o.city || ""),
    departamento: String(o.state || ""),
    producto: productName || "Sin producto",
    estado: status,
    fecha,
    fecha_conf: fechaConf,
    dias: calcDiasCal(createdAt),
    dias_conf: fechaConf ? calcDiasCal(fechaConf) : 0,
    valor: parseFloat(String(o.total_order || "0")) || 0,
    flete: parseFloat(String(o.shipping_amount || "0")) || 0,
    costo_prod: costoProd,
    costo_dev: parseFloat(String(o.discounted_amount || "0")) || 0,
    cantidad: Math.round(cantidad),
    direccion: String(o.dir || ""),
    novedad,
    guia,
    transportadora,
    tags,
    tienda,
    novedad_sol: novedadSol,
    last_movement_at: updatedAt || null,
  };
}
