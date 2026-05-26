-- FIX: admin_operator_actions_per_day fallaba en runtime con
--   "column reference \"fecha\" is ambiguous".
--
-- Causa: la función declara `RETURNS TABLE (fecha DATE, ...)`, lo que vuelve a
-- `fecha` una VARIABLE OUT en el scope de la función. Dentro de la CTE
-- `per_day_order` se referenciaba `fecha` SIN calificar (en el SELECT y en el
-- GROUP BY), así que PL/pgSQL no podía decidir entre la variable OUT `fecha` y
-- la columna `actions.fecha` → abortaba al ejecutar. (El CREATE pasaba igual
-- porque plpgsql planea el SQL embebido recién en la primera llamada, por eso
-- shippeó roto en 20260526055105.)
--
-- Fix mínimo: calificar las dos referencias como `actions.fecha`. Misma firma,
-- misma lógica, mismo scope-por-tienda vía _resolve_scope_store(). CREATE OR
-- REPLACE sin DROP → cero riesgo de PGRST202.

CREATE OR REPLACE FUNCTION public.admin_operator_actions_per_day(p_from DATE, p_to DATE)
RETURNS TABLE (
  fecha DATE,
  operadora TEXT,
  conf BIGINT,
  canc BIGINT,
  noresp BIGINT,
  atendidos BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();

  RETURN QUERY
  WITH actions AS (
    SELECT
      (r.created_at AT TIME ZONE 'America/Bogota')::date AS fecha,
      r.operator_id,
      r.order_id,
      r.result
    FROM public.order_results r
    WHERE r.module = 'confirmar'
      AND (r.created_at AT TIME ZONE 'America/Bogota')::date BETWEEN p_from AND p_to
      AND (v_store IS NULL OR r.store_id = v_store)
      AND (v_store IS NULL OR EXISTS (
        SELECT 1 FROM public.store_members sm
        WHERE sm.user_id = r.operator_id AND sm.store_id = v_store AND sm.role = 'operator'
      ))
  ),
  per_day_order AS (
    -- Por (día, pedido): si el operador confirmó/canceló ese día gana
    -- esa resolución; si solo dejó noresp, cuenta como noresp.
    -- `actions.fecha` calificado para no chocar con la variable OUT `fecha`.
    SELECT
      actions.fecha,
      actions.operator_id,
      actions.order_id,
      CASE
        WHEN BOOL_OR(actions.result = 'conf') THEN 'conf'
        WHEN BOOL_OR(actions.result = 'canc') THEN 'canc'
        WHEN BOOL_OR(actions.result = 'noresp') THEN 'noresp'
        ELSE 'otro'
      END AS final_result
    FROM actions
    GROUP BY actions.fecha, actions.operator_id, actions.order_id
  )
  SELECT
    pdo.fecha,
    COALESCE(p.display_name, 'Operador')::text,
    COUNT(*) FILTER (WHERE pdo.final_result = 'conf')::bigint,
    COUNT(*) FILTER (WHERE pdo.final_result = 'canc')::bigint,
    COUNT(*) FILTER (WHERE pdo.final_result = 'noresp')::bigint,
    COUNT(*)::bigint
  FROM per_day_order pdo
  LEFT JOIN public.profiles p ON p.user_id = pdo.operator_id
  GROUP BY pdo.fecha, p.display_name
  ORDER BY pdo.fecha DESC, p.display_name ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_operator_actions_per_day(DATE, DATE) TO authenticated;
