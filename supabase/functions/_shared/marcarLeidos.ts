// supabase/functions/_shared/marcarLeidos.ts
//
// "¿Cuándo fue la última vez que Guardian le preguntó a Dropi por ESTE pedido?"
//
// ── Por qué hace falta una columna nueva ────────────────────────────────────
// Hasta ahora no existía NINGUNA forma de saberlo. `last_movement_at` contesta
// otra pregunta —*cuándo se movió el pedido en Dropi*— y la tarjeta la usaba
// como si fuera frescura del dato: un pedido cuya información tiene tres días
// de atraso se pintaba VERDE si en Dropi se había movido hace dos horas.
//
// Y hay pedidos que ninguno de los tres caminos de refresco alcanza. Cada uno
// tiene su ventana: el cron mira 3 días por creación y 21 por cambio de estado
// (28 en Ecuador), el botón 10 días, y la reconciliación nocturna barre un mes
// por noche. Un pedido con `fecha` nula o mal formada se cae de las tres y no
// lo vuelve a mirar nadie, nunca. Sin este dato eso es invisible por
// definición: no se puede buscar lo que no se registra.
//
// ── Por qué acá y no dentro de la RPC ───────────────────────────────────────
// Estampar esto desde `upsert_orders_from_dropi` obligaría a reescribir una
// función viva (⛔ REGLA #1), y encima no serviría: esa RPC solo escribe cuando
// algo CAMBIÓ, y el caso que interesa es justamente el pedido que se leyó y
// estaba igual. Acá es un UPDATE aparte, en TypeScript, que no toca ninguna
// función desplegada.
//
// ── Por qué no se estampa en cada corrida ───────────────────────────────────
// El cron pasa cada ~20 minutos por tienda. Estampar cada pedido en cada
// corrida sería un UPDATE por fila cada 20 min —con su disparo de realtime a
// todos los navegadores abiertos— para responder una pregunta que se mide en
// DÍAS. Con el umbral, cada pedido se re-estampa unas pocas veces al día y la
// respuesta sigue siendo igual de buena.
//
// Degrada solo: mientras la migración de la columna no esté aplicada, esto no
// hace nada y no rompe el sync.

/** Cada cuánto, como mucho, se vuelve a estampar un mismo pedido. */
export const HORAS_ENTRE_MARCAS = 6;

// deno-lint-ignore no-explicit-any
type SB = any;

function columnaFaltante(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  const m = (err.message || "").toLowerCase();
  return m.includes("does not exist") || m.includes("schema cache");
}

/**
 * Marca como LEÍDOS los pedidos que se acaban de consultar en Dropi.
 *
 * @returns cuántas filas se marcaron; `null` si la columna todavía no existe.
 */
export async function marcarLeidos(
  sb: SB,
  storeId: string,
  externalIds: string[],
  ahora: number = Date.now(),
): Promise<number | null> {
  const ids = [...new Set(externalIds.filter(Boolean))];
  if (ids.length === 0) return 0;

  const corte = new Date(ahora - HORAS_ENTRE_MARCAS * 3600_000).toISOString();
  let marcadas = 0;

  for (let i = 0; i < ids.length; i += 200) {
    const lote = ids.slice(i, i + 200);
    const { data, error } = await sb
      .from("orders")
      .update({ last_synced_at: new Date(ahora).toISOString() })
      // SIEMPRE con store_id: los external_id de Dropi son por país y desde
      // agosto-2026 son únicos POR TIENDA, no globalmente. Sin este filtro se
      // marcarían pedidos de otra empresa.
      .eq("store_id", storeId)
      .in("external_id", lote)
      .or(`last_synced_at.is.null,last_synced_at.lt.${corte}`)
      .select("id");

    if (error) {
      if (columnaFaltante(error)) return null; // migración pendiente: no es un fallo
      console.warn("[marcarLeidos] error:", error.message);
      return marcadas;
    }
    marcadas += (data || []).length;
  }

  return marcadas;
}
