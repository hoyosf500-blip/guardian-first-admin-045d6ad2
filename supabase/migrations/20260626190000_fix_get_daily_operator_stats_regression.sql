-- FIX regresión introducida por la migración de guards de Lovable
-- (20260626180000_multitenant_null_store_guard.sql).
--
-- Al reproducir get_daily_operator_stats, Lovable INYECTÓ un filtro que NO existe
-- en la fuente (20260521233349):
--   AND EXISTS (SELECT 1 FROM store_members sm
--               WHERE sm.user_id = r.operator_id AND sm.store_id = v_store
--                 AND sm.role = 'operator')
-- Ese filtro esconde del /dashboard a cualquier owner/supervisor que haya
-- confirmado pedidos (su fila desaparece). Las otras 18 funciones del barrido
-- quedaron fieles — esta es la única regresión.
--
-- Restauramos la definición canónica (fuente + el hard-stop correcto, SIN el
-- filtro de rol espurio).
CREATE OR REPLACE FUNCTION public.get_daily_operator_stats(p_date date)
RETURNS TABLE(operator_id uuid, display_name text, conf bigint, canc bigint, noresp bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  -- Hard-stop multi-tenant (lo bueno que aportó Lovable): sin tienda concreta
  -- → 0 filas, nunca mezclar CO+EC.
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT
    r.operator_id,
    COALESCE(p.display_name, 'Operador'),
    COUNT(*) FILTER (WHERE r.result = 'conf'),
    COUNT(*) FILTER (WHERE r.result = 'canc'),
    COUNT(*) FILTER (WHERE r.result = 'noresp')
  FROM public.order_results r
  LEFT JOIN public.profiles p ON p.user_id = r.operator_id
  WHERE r.result_date = p_date
    AND r.store_id = v_store
  GROUP BY r.operator_id, p.display_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_daily_operator_stats(date) TO authenticated;
