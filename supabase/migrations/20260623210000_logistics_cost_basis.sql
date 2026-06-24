-- ════════════════════════════════════════════════════════════════════════
-- logistics_cost_basis — base de costos REAL (COGS + flete) por tienda, para el
-- simulador de unit-economics de "/logistica → Cómo voy".
--
-- POR QUÉ EXISTE: el COGS (SUM costo_prod) y el flete (SUM flete) de los entregados
-- hoy solo viven en financial_summary y product_profitability, que son ADMIN-ONLY
-- (has_role(...,'admin') + RAISE) y NO son store-scoped (devolverían datos de TODAS
-- las tiendas). Los socios no los pueden leer. Este RPC los expone SOLO para el
-- store del usuario, vía _resolve_scope_store() — mismo patrón store-scoped que
-- logistics_summary (20260521233349 / 20260623200000). NO toca financial_summary.
--
-- Todo se mide sobre UPPER(estado)='ENTREGADO': el costo de producto y el flete
-- solo se realizan al entregar (igual criterio que financial_summary).
--
-- Idempotente: CREATE OR REPLACE.
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.logistics_cost_basis(p_from_date date, p_to_date date, p_ciudad text DEFAULT NULL::text)
 RETURNS TABLE(entregados bigint, ingresos_entregados numeric, cogs_entregados numeric, flete_entregados numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  RETURN QUERY
  WITH entregadas AS (
    SELECT o.valor, o.costo_prod, o.flete
    FROM public.orders o
    WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND UPPER(o.estado) = 'ENTREGADO'
      AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
      AND (v_store IS NULL OR o.store_id = v_store)
  )
  SELECT
    COUNT(*)::bigint,
    COALESCE(SUM(valor), 0)::numeric,
    COALESCE(SUM(costo_prod), 0)::numeric,
    COALESCE(SUM(flete), 0)::numeric
  FROM entregadas;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.logistics_cost_basis(date, date, text) TO authenticated;
