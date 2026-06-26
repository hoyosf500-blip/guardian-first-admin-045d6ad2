-- Alertas de inactividad de operadora: tabla de advertencias + RPCs.
-- Backing del feature useInactivityGuard / InactivityWarningModal.
-- Sigue el patrón del heartbeat (20260528190848): RLS self/admin/manager,
-- record-RPC con validación de membresía, read-RPC store-scoped via
-- _resolve_scope_store(). Idempotente (IF NOT EXISTS / CREATE OR REPLACE).

CREATE TABLE IF NOT EXISTS public.operator_inactivity_warnings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  store_id       uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  warning_date   date NOT NULL,
  warning_number int NOT NULL,            -- 1,2,3… acumulativo del día
  lost_seconds   int NOT NULL DEFAULT 0,  -- tiempo inactiva que disparó el aviso
  created_at     timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.operator_inactivity_warnings TO authenticated;
GRANT ALL    ON public.operator_inactivity_warnings TO service_role;

CREATE INDEX IF NOT EXISTS idx_inactivity_store_date
  ON public.operator_inactivity_warnings (store_id, warning_date DESC);

ALTER TABLE public.operator_inactivity_warnings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inactivity_select_scope ON public.operator_inactivity_warnings;
CREATE POLICY inactivity_select_scope ON public.operator_inactivity_warnings
  FOR SELECT TO authenticated
  USING (
    operator_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')
    OR EXISTS (
      SELECT 1 FROM public.store_members sm
      WHERE sm.store_id = operator_inactivity_warnings.store_id
        AND sm.user_id = auth.uid()
        AND sm.role IN ('owner','supervisor')
    )
  );

-- Registrar un aviso (lo llama el cliente cuando la operadora toca "Entendido").
-- Devuelve el warning_number del día (autoritativo, contado en DB).
CREATE OR REPLACE FUNCTION public.record_inactivity_warning(
  p_store_id uuid,
  p_lost_seconds int
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today  date := ((NOW() AT TIME ZONE 'America/Bogota')::date);
  v_number int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  IF p_lost_seconds < 0 THEN p_lost_seconds := 0; END IF;
  IF p_lost_seconds > 43200 THEN p_lost_seconds := 43200; END IF; -- cap defensivo 12h

  IF NOT EXISTS (
    SELECT 1 FROM public.store_members
    WHERE store_id = p_store_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not a member of store';
  END IF;

  SELECT COALESCE(COUNT(*), 0) + 1 INTO v_number
  FROM public.operator_inactivity_warnings
  WHERE operator_id = auth.uid() AND store_id = p_store_id AND warning_date = v_today;

  INSERT INTO public.operator_inactivity_warnings
    (operator_id, store_id, warning_date, warning_number, lost_seconds)
  VALUES (auth.uid(), p_store_id, v_today, v_number, p_lost_seconds);

  RETURN v_number;
END $$;

GRANT EXECUTE ON FUNCTION public.record_inactivity_warning(uuid, int) TO authenticated;

-- Lectura para el dashboard/reporte (admin/owner/supervisor): conteo + tiempo
-- perdido por operadora, store-scoped y con ventanas Bogotá.
CREATE OR REPLACE FUNCTION public.operator_inactivity_stats(p_range text DEFAULT 'today')
RETURNS TABLE(
  operator_id uuid,
  display_name text,
  warnings_count bigint,
  total_lost_seconds bigint,
  last_warning_at timestamptz
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
    w.operator_id,
    COALESCE(p.display_name, 'Sin nombre') AS display_name,
    COUNT(*)::bigint AS warnings_count,
    COALESCE(SUM(w.lost_seconds), 0)::bigint AS total_lost_seconds,
    MAX(w.created_at) AS last_warning_at
  FROM public.operator_inactivity_warnings w
  LEFT JOIN public.profiles p ON p.user_id = w.operator_id
  WHERE w.warning_date >= v_since
    AND (v_store IS NULL OR w.store_id = v_store)
  GROUP BY w.operator_id, p.display_name
  ORDER BY warnings_count DESC;
END $$;

GRANT EXECUTE ON FUNCTION public.operator_inactivity_stats(text) TO authenticated;
