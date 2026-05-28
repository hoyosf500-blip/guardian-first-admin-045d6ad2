-- Excluir admins globales del dashboard de jornada.
--
-- Razón: el hook useOperatorHeartbeat ya tiene gate `if (isAdmin) return;`
-- en cliente, así que un admin nunca DEBERÍA generar pings. Pero si por
-- testing (o por una sesión simultánea como operadora) llegan filas con un
-- operator_id que también tiene role='admin' en user_roles, no queremos que
-- aparezcan en la lista "Por operadora" — el admin (Fabian) no es operadora.
--
-- Se hace en server-side para que la exclusión sea autoritativa y no dependa
-- del cliente. Filter chainable con el scope por tienda existente.

CREATE OR REPLACE FUNCTION public.operator_activity_stats(p_range text DEFAULT 'today')
RETURNS TABLE(
  operator_id uuid,
  display_name text,
  first_action_at timestamptz,
  last_active_at timestamptz,
  active_seconds bigint,
  idle_seconds bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_since date;
  v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  v_since := CASE p_range
    WHEN 'today' THEN ((NOW() AT TIME ZONE 'America/Bogota')::date)
    WHEN '7d'    THEN (((NOW() AT TIME ZONE 'America/Bogota')::date) - 6)
    WHEN '30d'   THEN (((NOW() AT TIME ZONE 'America/Bogota')::date) - 29)
    ELSE ((NOW() AT TIME ZONE 'America/Bogota')::date)
  END;

  RETURN QUERY
  SELECT
    d.operator_id,
    COALESCE(p.display_name, 'Sin nombre') AS display_name,
    MIN(d.first_action_at) AS first_action_at,
    MAX(d.last_active_at)  AS last_active_at,
    SUM(d.active_seconds)::bigint AS active_seconds,
    SUM(d.idle_seconds)::bigint   AS idle_seconds
  FROM public.operator_activity_daily d
  LEFT JOIN public.profiles p ON p.user_id = d.operator_id
  WHERE d.activity_date >= v_since
    AND (v_store IS NULL OR d.store_id = v_store)
    -- Excluir admins globales: el dashboard "Por operadora" es de operadoras,
    -- no de admins. Aunque el hook tiene gate, este filtro es el backstop.
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = d.operator_id AND ur.role = 'admin'
    )
  GROUP BY d.operator_id, p.display_name
  ORDER BY MIN(d.first_action_at) ASC;
END $$;

GRANT EXECUTE ON FUNCTION public.operator_activity_stats(text) TO authenticated;
