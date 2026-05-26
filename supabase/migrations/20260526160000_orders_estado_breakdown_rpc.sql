-- orders_estado_breakdown — desglose CRUDO por estado de los pedidos de la tienda.
--
-- Por qué existe: el embudo de Logística → Resumen usaba los buckets PRE-agrupados
-- de logistics_summary, que NO mapean los estados intermedios (CONFIRMADO, GUIA
-- GENERADA, PREPARANDO, etc.) → ~16% de pedidos caían en un "Otros" misterioso.
-- Este RPC devuelve cada `estado` con su conteo, valor y unidades, sin agrupar, y
-- el cliente bucketea TODO (los no clasificados se muestran por su nombre real, no
-- ocultos). Da además "Productos vendidos" (SUM cantidad) y "Total vendido sin
-- cancelados" (SUM valor) exactos para reconciliar con el dashboard de Dropi.
--
-- Store-scoped vía _resolve_scope_store() (mismo patrón que logistics_summary /
-- wallet_summary / wallet_ganancia_neta), SECURITY DEFINER, SIN gate admin → los
-- socios (owner/supervisor) ven el desglose de SU tienda. Mismo filtro de fecha que
-- logistics_summary para que los conteos cuadren entre vistas.

CREATE OR REPLACE FUNCTION public.orders_estado_breakdown(
  p_from date,
  p_to   date
)
RETURNS TABLE (
  estado   text,
  pedidos  bigint,
  valor    numeric,
  unidades numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  RETURN QUERY
  SELECT
    UPPER(COALESCE(NULLIF(TRIM(o.estado), ''), '(sin estado)')) AS estado,
    COUNT(*)::bigint                                            AS pedidos,
    COALESCE(SUM(o.valor), 0)::numeric                          AS valor,
    COALESCE(SUM(COALESCE(o.cantidad, 0)), 0)::numeric          AS unidades
  FROM public.orders o
  WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND o.fecha::date BETWEEN p_from AND p_to
    AND (v_store IS NULL OR o.store_id = v_store)
  GROUP BY UPPER(COALESCE(NULLIF(TRIM(o.estado), ''), '(sin estado)'));
END;
$function$;

GRANT EXECUTE ON FUNCTION public.orders_estado_breakdown(date, date) TO authenticated;
