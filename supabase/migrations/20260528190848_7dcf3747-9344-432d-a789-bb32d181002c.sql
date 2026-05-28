-- Tracking de jornada operadora: hora de inicio + tiempo activo/inactivo.
CREATE TABLE IF NOT EXISTS public.operator_activity_daily (
  operator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  activity_date date NOT NULL,
  first_action_at timestamptz NOT NULL,
  last_active_at timestamptz NOT NULL,
  active_seconds int NOT NULL DEFAULT 0,
  idle_seconds int NOT NULL DEFAULT 0,
  PRIMARY KEY (operator_id, store_id, activity_date)
);

GRANT SELECT ON public.operator_activity_daily TO authenticated;
GRANT ALL ON public.operator_activity_daily TO service_role;

CREATE INDEX IF NOT EXISTS idx_operator_activity_store_date
  ON public.operator_activity_daily (store_id, activity_date DESC);

ALTER TABLE public.operator_activity_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS activity_select_scope ON public.operator_activity_daily;
CREATE POLICY activity_select_scope ON public.operator_activity_daily
  FOR SELECT TO authenticated
  USING (
    operator_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')
    OR EXISTS (
      SELECT 1 FROM public.store_members sm
      WHERE sm.store_id = operator_activity_daily.store_id
        AND sm.user_id = auth.uid()
        AND sm.role IN ('owner','supervisor')
    )
  );

CREATE OR REPLACE FUNCTION public.record_operator_heartbeat(
  p_store_id uuid,
  p_active_seconds int,
  p_idle_seconds int
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := ((NOW() AT TIME ZONE 'America/Bogota')::date);
  v_now timestamptz := NOW();
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  IF p_active_seconds < 0 OR p_active_seconds > 120 THEN RETURN; END IF;
  IF p_idle_seconds   < 0 OR p_idle_seconds   > 120 THEN RETURN; END IF;
  IF p_active_seconds = 0 AND p_idle_seconds = 0 THEN RETURN; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.store_members
    WHERE store_id = p_store_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not a member of store';
  END IF;

  INSERT INTO public.operator_activity_daily AS d (
    operator_id, store_id, activity_date,
    first_action_at, last_active_at,
    active_seconds, idle_seconds
  ) VALUES (
    auth.uid(), p_store_id, v_today,
    v_now, v_now,
    p_active_seconds, p_idle_seconds
  )
  ON CONFLICT (operator_id, store_id, activity_date) DO UPDATE
    SET active_seconds = d.active_seconds + EXCLUDED.active_seconds,
        idle_seconds   = d.idle_seconds   + EXCLUDED.idle_seconds,
        last_active_at = CASE WHEN p_active_seconds > 0 THEN v_now ELSE d.last_active_at END;
END $$;

GRANT EXECUTE ON FUNCTION public.record_operator_heartbeat(uuid, int, int) TO authenticated;

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
  GROUP BY d.operator_id, p.display_name
  ORDER BY MIN(d.first_action_at) ASC;
END $$;

GRANT EXECUTE ON FUNCTION public.operator_activity_stats(text) TO authenticated;