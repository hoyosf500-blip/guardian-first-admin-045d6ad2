-- Detalle de cancelaciones (motivos) por operadora + fecha, para el popup que
-- abre la celda "Cancelados" en Reportes diarios (DailyReportsView).
--
-- Matchea por display_name (p_operadora) para NO tener que tocar el RPC
-- admin_operator_shifts_range (que hoy solo devuelve el nombre, no operator_id;
-- y reescribir RPCs vivas desde el repo es riesgoso por el drift repo↔DB).
-- Store-scoped via _resolve_scope_store() (admin/owner/supervisor → su tienda;
-- operadora pura → RAISE 42501, no puede leer). Mismo patrón que las otras
-- RPCs de DailyReportsView.

-- Por si quedó una versión vieja de 2 args de un intento anterior.
DROP FUNCTION IF EXISTS public.admin_cancelled_details(text, date);

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
  module text
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
    COALESCE(r.module, 'confirmar') AS module
  FROM public.order_results r
  JOIN public.profiles p ON p.user_id = r.operator_id
  LEFT JOIN public.orders o ON o.id = r.order_id
  WHERE r.result = 'canc'
    AND r.result_date::date = p_fecha
    AND p.display_name = p_operadora
    AND (p_store_id IS NULL OR r.store_id = p_store_id)
    AND (v_store IS NULL OR r.store_id = v_store)
  ORDER BY r.created_at;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_cancelled_details(text, date, uuid) TO authenticated;

-- Índice para el patrón (tienda + fecha + estado) cuando crezca el volumen.
CREATE INDEX IF NOT EXISTS idx_order_results_store_date_result
  ON public.order_results (store_id, result_date, result);
