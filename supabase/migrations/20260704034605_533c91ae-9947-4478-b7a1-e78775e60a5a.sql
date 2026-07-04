-- Migration 20260703200000_operator_worked_blocks.sql
CREATE OR REPLACE FUNCTION public.operator_worked_blocks(p_range text DEFAULT 'today')
RETURNS TABLE(
  operator_id uuid,
  display_name text,
  worked_seconds bigint,
  block_count int,
  first_event timestamptz,
  last_event timestamptz,
  blocks jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_since date;
  v_store uuid;
  c_gap_sec       constant int := 15 * 60;
  c_min_block_sec constant int := 120;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN
    RETURN;
  END IF;

  v_since := CASE p_range
    WHEN 'today' THEN ((NOW() AT TIME ZONE 'America/Bogota')::date)
    WHEN '7d'    THEN (((NOW() AT TIME ZONE 'America/Bogota')::date) - 6)
    WHEN '30d'   THEN (((NOW() AT TIME ZONE 'America/Bogota')::date) - 29)
    ELSE ((NOW() AT TIME ZONE 'America/Bogota')::date)
  END;

  RETURN QUERY
  WITH ev AS (
    SELECT r.operator_id AS op, r.created_at AS ts
    FROM public.order_results r
    WHERE r.store_id = v_store
      AND r.operator_id IS NOT NULL
      AND (r.created_at AT TIME ZONE 'America/Bogota')::date >= v_since
    UNION ALL
    SELECT t.operator_id AS op, t.created_at AS ts
    FROM public.touchpoints t
    WHERE t.store_id = v_store
      AND t.operator_id IS NOT NULL
      AND (t.created_at AT TIME ZONE 'America/Bogota')::date >= v_since
  ),
  ev2 AS (
    SELECT e.op, e.ts
    FROM ev e
    WHERE NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = e.op AND ur.role = 'admin'
    )
  ),
  flagged AS (
    SELECT op, ts,
      CASE
        WHEN LAG(ts) OVER (PARTITION BY op ORDER BY ts) IS NULL
          OR ts - LAG(ts) OVER (PARTITION BY op ORDER BY ts) > make_interval(secs => c_gap_sec)
        THEN 1 ELSE 0
      END AS new_block
    FROM ev2
  ),
  grouped AS (
    SELECT op, ts,
      SUM(new_block) OVER (PARTITION BY op ORDER BY ts ROWS UNBOUNDED PRECEDING) AS block_id
    FROM flagged
  ),
  blocks_agg AS (
    SELECT op, block_id,
      MIN(ts) AS b_start,
      MAX(ts) AS b_end,
      COUNT(*)::int AS events,
      GREATEST(
        EXTRACT(EPOCH FROM (MAX(ts) - MIN(ts)))::int,
        c_min_block_sec
      ) AS dur_sec
    FROM grouped
    GROUP BY op, block_id
  )
  SELECT
    b.op AS operator_id,
    COALESCE(p.display_name, 'Sin nombre') AS display_name,
    SUM(b.dur_sec)::bigint AS worked_seconds,
    COUNT(*)::int AS block_count,
    MIN(b.b_start) AS first_event,
    MAX(b.b_end)   AS last_event,
    jsonb_agg(
      jsonb_build_object(
        'start', b.b_start,
        'end',   b.b_end,
        'events', b.events,
        'sec',   b.dur_sec
      ) ORDER BY b.b_start
    ) AS blocks
  FROM blocks_agg b
  LEFT JOIN public.profiles p ON p.user_id = b.op
  GROUP BY b.op, p.display_name
  ORDER BY MIN(b.b_start) ASC;
END $$;

GRANT EXECUTE ON FUNCTION public.operator_worked_blocks(text) TO authenticated;

-- Migration 20260703210000_store_work_schedule.sql
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS work_start_min  smallint NOT NULL DEFAULT 540,
  ADD COLUMN IF NOT EXISTS work_end_min    smallint NOT NULL DEFAULT 1020,
  ADD COLUMN IF NOT EXISTS lunch_start_min smallint NOT NULL DEFAULT 750,
  ADD COLUMN IF NOT EXISTS lunch_end_min   smallint NOT NULL DEFAULT 810;

CREATE OR REPLACE FUNCTION public.update_store_schedule(
  p_store_id        uuid,
  p_work_start_min  int,
  p_work_end_min    int,
  p_lunch_start_min int,
  p_lunch_end_min   int
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;

  IF NOT (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (
      SELECT 1 FROM public.store_members
      WHERE store_id = p_store_id
        AND user_id = auth.uid()
        AND role IN ('owner','supervisor')
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;

  IF p_work_start_min < 0 OR p_work_end_min > 1440 OR p_work_start_min >= p_work_end_min THEN
    RAISE EXCEPTION 'Horario laboral inválido (inicio < fin, 0..1440)';
  END IF;
  IF p_lunch_start_min < 0 OR p_lunch_end_min > 1440 OR p_lunch_start_min > p_lunch_end_min THEN
    RAISE EXCEPTION 'Almuerzo inválido (inicio <= fin, 0..1440)';
  END IF;

  UPDATE public.stores
  SET work_start_min  = p_work_start_min,
      work_end_min    = p_work_end_min,
      lunch_start_min = p_lunch_start_min,
      lunch_end_min   = p_lunch_end_min
  WHERE id = p_store_id;
END $$;

GRANT EXECUTE ON FUNCTION public.update_store_schedule(uuid, int, int, int, int) TO authenticated;