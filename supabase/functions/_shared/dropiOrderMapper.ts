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

// ── fecha_conf ESTABLE (auditoría 2026-07-31) ───────────────────────────────
// Antes: fecha_conf = updated_at.split('T')[0] siempre que el estado no fuera
// PENDIENTE CONFIRMACION. Como updated_at cambia con CADA movimiento, la
// "Fecha confirmación" derivaba: un pedido confirmado el 1-jul y entregado el
// 20-jul quedaba con fecha_conf=2026-07-20, y un CANCELADO directo quedaba
// "confirmado" el día de la cancelación. OrderDetailPage la rotula como fecha
// de confirmación y CrmTable/SegBoard la usan como base de SLA → los "días" de
// una fila cambiaban bajo los pies de la asesora con cada movimiento.
//
// Ahora se deriva del historial REAL (`o.history[]`, el mismo que ingiere
// order_status_history): la PRIMERA entrada que salió de la cola de
// confirmación es LA fecha de confirmación, y es estable entre syncs (la
// guardia IS DISTINCT FROM de la RPC deja de disparar realtime por este campo).
//
// ⚠️ Si NO viene historial se conserva el comportamiento previo (updated_at):
// la RPC upsert_orders_from_dropi hace `fecha_conf = EXCLUDED.fecha_conf` SIN
// COALESCE, así que mandar null acá BORRARÍA un sello legítimo ya guardado.
// Mejor un valor aproximado estable-por-día que un null que destruye datos.

/** Normaliza un status Dropi para comparar (mayúsculas, sin tildes,
 *  `_` → espacio — el historial trae "GUIA_GENERADA" con guion bajo). */
function normStatusForConf(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PRE_CONF_RE = /^(PENDIENTE CONFIRMACION|POR CONFIRMAR)$/;
const CANCELISH_RE = /CANCELAD|RECHAZAD|REEMPLAZAD|ANULAD/;

/** Fecha de confirmación (YYYY-MM-DD) derivada del historial de Dropi.
 *  `status` debe venir ya en mayúsculas; `updatedAt` es el fallback legacy. */
export function deriveFechaConf(
  o: Record<string, unknown>,
  status: string,
  updatedAt: string,
): string | null {
  // Sigue en la cola de confirmación → nunca se confirmó.
  if (status === "PENDIENTE CONFIRMACION" || status === "POR CONFIRMAR") return null;

  const hist = Array.isArray(o.history) ? (o.history as Array<Record<string, unknown>>) : [];
  if (hist.length > 0) {
    // Primera entrada post-cola (ni pre-confirmación ni cancelación): esa es
    // la confirmación real. ISO strings comparan bien lexicográficamente.
    let earliest: string | null = null;
    for (const h of hist) {
      const st = normStatusForConf(String(h?.status ?? ""));
      const at = String(h?.created_at ?? "").trim();
      if (!st || !at) continue;
      if (PRE_CONF_RE.test(st) || CANCELISH_RE.test(st)) continue;
      if (earliest === null || at < earliest) earliest = at;
    }
    if (earliest) return earliest.split("T")[0];
    // Historial presente y SIN ninguna entrada post-confirmación:
    //  - cancelado directo desde la cola → null honesto (jamás se confirmó;
    //    también corrige el sello falso que dejó el comportamiento viejo);
    //  - estado avanzado con historial incompleto → fallback legacy abajo
    //    (nunca null: no arriesgamos borrar un sello legítimo).
    if (CANCELISH_RE.test(normStatusForConf(status))) return null;
  }

  // Sin historial (o incompleto): comportamiento previo — aproximado pero
  // nunca destruye un dato ya sellado vía la RPC sin COALESCE.
  return updatedAt ? updatedAt.split("T")[0] : null;
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

  // ── VARIANTES (talla / color) ─────────────────────────────────────────
  //
  // Antes esto era `products.map(p => p.product?.name).join(", ")`: leía SOLO
  // el nombre base y TIRABA la variante. Con zapatos en Colombia el resultado
  // era "Nuevo modelo Sneakers 2801, Nuevo modelo Sneakers 2801" — el mismo
  // nombre repetido, sin forma de saber qué tallas pidió el cliente. 10 de los
  // últimos 40 pedidos de CO estaban así (verificado en producción 2026-07-21).
  //
  // Dropi expone la variante como `attribute_values` (ej. [{value:"38"},
  // {value:"Negro"}] → "38 / Negro"). El nombre del contenedor cambia según el
  // endpoint, así que se prueban los candidatos conocidos en vez de asumir uno:
  // si Dropi usa otro, la línea sale sin variante pero NADA se rompe.
  const variantLabel = (p: Record<string, unknown>): string => {
    const v = (p.variation ?? p.product_variation ?? p.variacion ?? p.variant ?? null) as
      Record<string, unknown> | null;
    if (!v || typeof v !== "object") return "";
    const attrs = v.attribute_values;
    if (Array.isArray(attrs)) {
      const txt = (attrs as Record<string, unknown>[])
        .map((a) => String(a?.value ?? a?.name ?? "").trim())
        .filter(Boolean)
        .join(" / ");
      if (txt) return txt;
    }
    return String(v.name ?? v.sku ?? "").trim();
  };

  // Detalle por LÍNEA — lo que ve la asesora en la ficha. El dueño pidió
  // variante + cantidad + precio de cada línea (2026-07-21).
  const detalle = products.map((p) => {
    const prod = (p.product as Record<string, unknown>) || {};
    const qty = Math.round(parseFloat(String(p.quantity || "1")) || 1);
    const precio = parseFloat(
      String(p.price ?? p.sale_price ?? prod.sale_price ?? "0"),
    ) || 0;
    return {
      nombre: String(prod.name || "").trim(),
      variante: variantLabel(p),
      cantidad: qty > 0 ? qty : 1,
      precio,
    };
  }).filter((d) => d.nombre || d.variante);

  // `producto` queda con los nombres base SIN REPETIR.
  //
  // Ojo, esto además arregla un bug de reportes que ya existía: al repetir el
  // nombre por cada línea, "Sneakers, Sneakers" quedaba como un producto
  // DISTINTO de "Sneakers" en logistics_by_product y product_profitability →
  // el mismo zapato partido en dos grupos. Las variantes NO van acá justamente
  // para no volver a fragmentar (una fila por talla); viven en el detalle.
  const productName = [...new Set(detalle.map((d) => d.nombre).filter(Boolean))].join(", ");
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

  // fecha_conf estable desde el historial (ver deriveFechaConf arriba) — antes
  // se re-estampaba con updated_at en cada sync y la fecha derivaba.
  const status = String(o.status || "PENDIENTE").toUpperCase();
  const fechaConf = deriveFechaConf(o, status, updatedAt);

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
    // Detalle por línea con variante/cantidad/precio.
    //
    // ⚠️ ORDEN OBLIGATORIO: la migración 20260721130000 (que crea la columna)
    // va ANTES de redesplegar estas funciones. Postgres NO ignora una columna
    // inexistente en un upsert: devuelve error y se cae TODO el sync de pedidos.
    // Si por lo que sea hay que desplegar primero, comentar esta línea.
    productos_detalle: detalle.length > 0 ? detalle : null,
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
