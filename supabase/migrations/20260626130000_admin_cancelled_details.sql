-- Detalle de cancelaciones (motivos) por operadora + fecha, para el popup que
-- abre la celda "Cancelados" en Reportes diarios (DailyReportsView).
--
-- AHORA expone también la ANTIGÜEDAD del pedido cancelado (order_fecha + dias)
-- para distinguir cancelaciones de pedidos NUEVOS (hoy/ayer) vs ARRASTRE viejo.
-- Así el dueño ve de un vistazo si la operadora cancela pedidos frescos o cola
-- vieja.
--
-- Matchea por display_name (p_operadora) para NO tener que tocar el RPC
-- admin_operator_shifts_range (que hoy solo devuelve el nombre, no operator_id;
-- y reescribir RPCs vivas desde el repo es riesgoso por el drift repo↔DB).
-- Store-scoped via _resolve_scope_store() (admin/owner/supervisor → su tienda;
-- operadora pura → RAISE 42501, no puede leer). Mismo patrón que las otras
-- RPCs de DailyReportsView.

-- Cambia la signatura del RETURNS TABLE (agrega order_fecha + dias) → hay que
-- dropear ambas firmas previas (2 args legacy y 3 args sin antigüedad), porque
-- Postgres no permite CREATE OR REPLACE si cambian las columnas de salida.
DROP FUNCTION IF EXISTS public.admin_cancelled_details(text, date);
DROP FUNCTION IF EXISTS public.admin_cancelled_details(text, date, uuid);

-- p_store_id (lo pasa el cliente desde activeStoreId) acota el match por
-- display_name a ESA tienda — defensa multi-tenant: si un admin tiene
-- active_store_id NULL, el resolver no filtra, pero p_store_id sí, evitando
-- traer homónimas de otra tienda. Si viene NULL, cae al scope del resolver.
CREATE OR REPLACE FUNCTION public.admin_cancelled_details(
  p_operadora text,
  p_fecha date,
  p_store_id uuid DEFAULT NULL
)
RETURNS TABLE(
  external_id text,
  nombre text,
  phone text,
  reason text,
  hora timestamptz,
  module text,
  order_fecha date,
  dias int
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  RETURN QUERY
  SELECT
    o.external_id::text,
    o.nombre::text,
    r.phone::text,
    COALESCE(NULLIF(TRIM(r.reason), ''), '(sin motivo)') AS reason,
    r.created_at AS hora,
    COALESCE(r.module, 'confirmar') AS module,
    -- Fecha de creación del pedido (date) SOLO si orders.fecha tiene FORMATO
    -- YYYY-MM-DD (es texto NO confiable: puede venir DD/MM/YYYY o basura). El
    -- guard es de FORMATO, no de validez calendárica — mismo patrón que
    -- logistics_summary y ~40 RPCs hermanas; Dropi siempre manda ISO válido.
    CASE
      WHEN o.fecha ~ '^\d{4}-\d{2}-\d{2}$' THEN o.fecha::date
      ELSE NULL
    END AS order_fecha,
    -- Antigüedad en días CALENDARIO del pedido AL MOMENTO de cancelarlo (p_fecha),
    -- no a hoy, para que sea estable al revisar reportes de días pasados.
    -- Robusto ante orders.fecha malformada (mismo guard regex que logistics_summary):
    --   1) si fecha parsea  -> p_fecha - fecha (no negativo)
    --   2) si no parsea pero hay orders.dias precalculado -> usarlo
    --   3) último fallback  -> p_fecha - created_at::date (timestamp real de la fila)
    --   4) todo falla       -> NULL (la UI muestra "antigüedad desconocida")
    CASE
      WHEN o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
        THEN GREATEST((p_fecha - o.fecha::date), 0)
      WHEN o.dias IS NOT NULL
        THEN GREATEST(o.dias, 0)
      WHEN o.created_at IS NOT NULL
        THEN GREATEST((p_fecha - o.created_at::date), 0)
      ELSE NULL
    END AS dias
  FROM public.order_results r
  JOIN public.profiles p ON p.user_id = r.operator_id
  LEFT JOIN public.orders o ON o.id = r.order_id
  WHERE r.result = 'canc'
    AND r.result_date = p_fecha          -- result_date ya es DATE (no necesita cast)
    AND p.display_name = p_operadora
    AND (p_store_id IS NULL OR r.store_id = p_store_id)
    AND (v_store IS NULL OR r.store_id = v_store)
  ORDER BY r.created_at;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_cancelled_details(text, date, uuid) TO authenticated;

-- Índice para el patrón (tienda + fecha + estado) cuando crezca el volumen.
CREATE INDEX IF NOT EXISTS idx_order_results_store_date_result
  ON public.order_results (store_id, result_date, result);
