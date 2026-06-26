-- BLOQUE 1
DELETE FROM public.operator_inactivity_warnings a
USING public.operator_inactivity_warnings b
WHERE a.operator_id = b.operator_id AND a.store_id = b.store_id
  AND a.warning_date = b.warning_date AND a.warning_number = b.warning_number
  AND a.ctid > b.ctid;

ALTER TABLE public.operator_inactivity_warnings
  DROP CONSTRAINT IF EXISTS uq_inactivity_operator_store_date_number;
ALTER TABLE public.operator_inactivity_warnings
  ADD CONSTRAINT uq_inactivity_operator_store_date_number
  UNIQUE (operator_id, store_id, warning_date, warning_number);

CREATE OR REPLACE FUNCTION public.record_inactivity_warning(p_store_id uuid, p_lost_seconds int)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today date := ((NOW() AT TIME ZONE 'America/Bogota')::date); v_number int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  IF p_lost_seconds < 0 THEN p_lost_seconds := 0; END IF;
  IF p_lost_seconds > 43200 THEN p_lost_seconds := 43200; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.store_members WHERE store_id = p_store_id AND user_id = auth.uid())
    THEN RAISE EXCEPTION 'not a member of store'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(auth.uid()::text || ':' || p_store_id::text || ':' || v_today::text)::bigint);
  SELECT COALESCE(COUNT(*), 0) + 1 INTO v_number FROM public.operator_inactivity_warnings
    WHERE operator_id = auth.uid() AND store_id = p_store_id AND warning_date = v_today;
  INSERT INTO public.operator_inactivity_warnings (operator_id, store_id, warning_date, warning_number, lost_seconds)
    VALUES (auth.uid(), p_store_id, v_today, v_number, p_lost_seconds)
    ON CONFLICT (operator_id, store_id, warning_date, warning_number) DO NOTHING;
  RETURN v_number;
END $$;
GRANT EXECUTE ON FUNCTION public.record_inactivity_warning(uuid, int) TO authenticated;

CREATE OR REPLACE FUNCTION public.operator_inactivity_stats(p_range text DEFAULT 'today')
RETURNS TABLE(operator_id uuid, display_name text, warnings_count bigint, total_lost_seconds bigint, last_warning_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_since date; v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  v_since := CASE p_range WHEN 'today' THEN ((NOW() AT TIME ZONE 'America/Bogota')::date)
    WHEN '7d' THEN (((NOW() AT TIME ZONE 'America/Bogota')::date) - 6)
    WHEN '30d' THEN (((NOW() AT TIME ZONE 'America/Bogota')::date) - 29)
    ELSE ((NOW() AT TIME ZONE 'America/Bogota')::date) END;
  RETURN QUERY
  SELECT w.operator_id, COALESCE(p.display_name, 'Sin nombre'),
    COUNT(*)::bigint, COALESCE(SUM(w.lost_seconds), 0)::bigint, MAX(w.created_at)
  FROM public.operator_inactivity_warnings w
  LEFT JOIN public.profiles p ON p.user_id = w.operator_id
  WHERE w.warning_date >= v_since AND w.store_id = v_store
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = w.operator_id AND ur.role = 'admin')
  GROUP BY w.operator_id, p.display_name ORDER BY 3 DESC;
END $$;
GRANT EXECUTE ON FUNCTION public.operator_inactivity_stats(text) TO authenticated;

DROP FUNCTION IF EXISTS public.admin_inactivity_details(text, text, uuid);
CREATE OR REPLACE FUNCTION public.admin_inactivity_details(p_operadora text, p_range text DEFAULT 'today', p_store_id uuid DEFAULT NULL)
RETURNS TABLE(numero int, lost_seconds int, warning_date date, hora timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_store uuid; v_since date;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL AND p_store_id IS NULL THEN RETURN; END IF;
  v_since := CASE p_range WHEN 'today' THEN ((NOW() AT TIME ZONE 'America/Bogota')::date)
    WHEN '7d' THEN (((NOW() AT TIME ZONE 'America/Bogota')::date) - 6)
    WHEN '30d' THEN (((NOW() AT TIME ZONE 'America/Bogota')::date) - 29)
    ELSE ((NOW() AT TIME ZONE 'America/Bogota')::date) END;
  RETURN QUERY
  SELECT w.warning_number, w.lost_seconds, w.warning_date, w.created_at
  FROM public.operator_inactivity_warnings w
  JOIN public.profiles p ON p.user_id = w.operator_id
  WHERE p.display_name = p_operadora AND w.warning_date >= v_since
    AND (p_store_id IS NULL OR w.store_id = p_store_id)
    AND (v_store IS NULL OR w.store_id = v_store)
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = w.operator_id AND ur.role = 'admin')
  ORDER BY w.warning_date, w.warning_number;
END $$;
GRANT EXECUTE ON FUNCTION public.admin_inactivity_details(text, text, uuid) TO authenticated;

-- BLOQUE 2
CREATE OR REPLACE FUNCTION public.operator_activity_stats(p_range text DEFAULT 'today')
RETURNS TABLE(operator_id uuid, display_name text, first_action_at timestamptz, last_active_at timestamptz, active_seconds bigint, idle_seconds bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_since date; v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  v_since := CASE p_range WHEN 'today' THEN ((NOW() AT TIME ZONE 'America/Bogota')::date)
    WHEN '7d' THEN (((NOW() AT TIME ZONE 'America/Bogota')::date) - 6)
    WHEN '30d' THEN (((NOW() AT TIME ZONE 'America/Bogota')::date) - 29)
    ELSE ((NOW() AT TIME ZONE 'America/Bogota')::date) END;
  RETURN QUERY
  SELECT d.operator_id, COALESCE(p.display_name, 'Sin nombre'),
    MIN(d.first_action_at), MAX(d.last_active_at), SUM(d.active_seconds)::bigint, SUM(d.idle_seconds)::bigint
  FROM public.operator_activity_daily d
  LEFT JOIN public.profiles p ON p.user_id = d.operator_id
  WHERE d.activity_date >= v_since AND d.store_id = v_store
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = d.operator_id AND ur.role = 'admin')
  GROUP BY d.operator_id, p.display_name ORDER BY MIN(d.first_action_at) ASC;
END $$;
GRANT EXECUTE ON FUNCTION public.operator_activity_stats(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_cancelled_details(p_operadora text, p_fecha date, p_store_id uuid DEFAULT NULL)
RETURNS TABLE(external_id text, nombre text, phone text, reason text, hora timestamptz, module text, order_fecha date, dias int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN v_store := p_store_id; END IF;
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT o.external_id::text, o.nombre::text, r.phone::text,
    COALESCE(NULLIF(TRIM(r.reason), ''), '(sin motivo)'), r.created_at, COALESCE(r.module, 'confirmar'),
    CASE WHEN o.fecha ~ '^\d{4}-\d{2}-\d{2}$' THEN o.fecha::date ELSE NULL END,
    CASE WHEN o.fecha ~ '^\d{4}-\d{2}-\d{2}$' THEN GREATEST((p_fecha - o.fecha::date), 0)
      WHEN o.dias IS NOT NULL THEN GREATEST(o.dias, 0)
      WHEN o.created_at IS NOT NULL THEN GREATEST((p_fecha - o.created_at::date), 0)
      ELSE NULL END
  FROM public.order_results r
  JOIN public.profiles p ON p.user_id = r.operator_id
  LEFT JOIN public.orders o ON o.id = r.order_id
  WHERE r.result = 'canc' AND r.result_date = p_fecha AND p.display_name = p_operadora AND r.store_id = v_store
  ORDER BY r.created_at;
END $$;
GRANT EXECUTE ON FUNCTION public.admin_cancelled_details(text, date, uuid) TO authenticated;

-- BLOQUE 3
CREATE OR REPLACE FUNCTION public.get_daily_operator_stats(p_date date)
RETURNS TABLE(operator_id uuid, display_name text, conf bigint, canc bigint, noresp bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT r.operator_id, COALESCE(p.display_name, 'Operador'),
    COUNT(*) FILTER (WHERE r.result = 'conf'), COUNT(*) FILTER (WHERE r.result = 'canc'), COUNT(*) FILTER (WHERE r.result = 'noresp')
  FROM public.order_results r
  LEFT JOIN public.profiles p ON p.user_id = r.operator_id
  WHERE r.result_date = p_date AND r.store_id = v_store
  GROUP BY r.operator_id, p.display_name;
END $$;
GRANT EXECUTE ON FUNCTION public.get_daily_operator_stats(date) TO authenticated;