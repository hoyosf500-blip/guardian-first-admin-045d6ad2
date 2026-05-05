-- /admin → Reportes diarios: vista de NEGOCIO por día (no por cierre
-- de operadora). Una fila por fecha con la métrica de cohort:
--   entrantes  = pedidos creados ese día que entraron al flujo
--   confirmados = pedidos del cohort cuyo resultado FINAL es conf
--   cancelados = pedidos del cohort cuyo resultado FINAL es canc
--   noresp     = pedidos del cohort que solo tuvieron noresp (nunca
--                terminaron conf/canc — backlog real)
--   pendientes = pedidos del cohort sin ningún order_result (todavía
--                en cola)
--   pct_*      = ratio sobre entrantes — siempre ≤ 100% por construcción
--
-- Reportado 2026-05-05: la versión anterior (20260505220000) calculaba
-- % por fila de cierre de operadora y mostraba >100% (ej. 275%) cuando
-- la operadora confirmaba pedidos del backlog (creados días atrás)
-- contra el inflow del día en curso. Esta versión arregla la métrica
-- agregando por día y matcheando cohort estrictamente.
--
-- ⚠️ Cambia la estructura RETURNS — el frontend DailyReportsView.tsx
-- también se actualiza en el mismo commit.

DROP FUNCTION IF EXISTS public.admin_daily_reports_range(DATE, DATE);

CREATE OR REPLACE FUNCTION public.admin_daily_reports_range(p_from DATE, p_to DATE)
RETURNS TABLE (
  fecha DATE,
  entrantes INT,
  confirmados INT,
  cancelados INT,
  noresp INT,
  pendientes INT,
  pct_confirmacion NUMERIC,
  pct_cancelados NUMERIC
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo admins';
  END IF;

  RETURN QUERY
  WITH days AS (
    -- Genera UNA fila por cada fecha del rango, así también aparecen
    -- los días sin actividad (todos los conteos en 0).
    SELECT (p_from + (n || ' day')::interval)::date AS fecha
    FROM generate_series(0, (p_to - p_from)::int) AS n
  ),
  inflow_cohort AS (
    -- Pedidos creados en el rango que entraron al flujo de confirmación.
    -- created_at se mapea a fecha Bogotá para alinear con report_date
    -- y con el resto de RPCs (today_call_stats, operator_productivity_stats).
    SELECT
      (o.created_at AT TIME ZONE 'America/Bogota')::date AS fecha,
      o.id
    FROM public.orders o
    WHERE (o.created_at AT TIME ZONE 'America/Bogota')::date BETWEEN p_from AND p_to
      AND (
        o.estado = 'PENDIENTE CONFIRMACION'
        OR EXISTS (
          SELECT 1 FROM public.order_results r
          WHERE r.order_id = o.id AND r.module = 'confirmar'
        )
      )
  ),
  final_status AS (
    -- Para cada pedido del cohort, determina su resultado final:
    -- conf > canc > noresp > pendiente. Si tiene múltiples results
    -- (caso noresp+conf por reintentos), gana el más definitivo.
    SELECT
      ic.fecha,
      ic.id AS order_id,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM public.order_results r
          WHERE r.order_id = ic.id AND r.module = 'confirmar' AND r.result = 'conf'
        ) THEN 'conf'
        WHEN EXISTS (
          SELECT 1 FROM public.order_results r
          WHERE r.order_id = ic.id AND r.module = 'confirmar' AND r.result = 'canc'
        ) THEN 'canc'
        WHEN EXISTS (
          SELECT 1 FROM public.order_results r
          WHERE r.order_id = ic.id AND r.module = 'confirmar' AND r.result = 'noresp'
        ) THEN 'noresp'
        ELSE 'pendiente'
      END AS estado_final
    FROM inflow_cohort ic
  )
  SELECT
    d.fecha,
    COALESCE(COUNT(fs.order_id), 0)::int AS entrantes,
    COALESCE(
      COUNT(fs.order_id) FILTER (WHERE fs.estado_final = 'conf'), 0
    )::int AS confirmados,
    COALESCE(
      COUNT(fs.order_id) FILTER (WHERE fs.estado_final = 'canc'), 0
    )::int AS cancelados,
    COALESCE(
      COUNT(fs.order_id) FILTER (WHERE fs.estado_final = 'noresp'), 0
    )::int AS noresp,
    COALESCE(
      COUNT(fs.order_id) FILTER (WHERE fs.estado_final = 'pendiente'), 0
    )::int AS pendientes,
    CASE WHEN COUNT(fs.order_id) = 0 THEN 0
         ELSE ROUND(
           COUNT(fs.order_id) FILTER (WHERE fs.estado_final = 'conf')::numeric
             / COUNT(fs.order_id)::numeric * 100, 0
         )
    END AS pct_confirmacion,
    CASE WHEN COUNT(fs.order_id) = 0 THEN 0
         ELSE ROUND(
           COUNT(fs.order_id) FILTER (WHERE fs.estado_final = 'canc')::numeric
             / COUNT(fs.order_id)::numeric * 100, 0
         )
    END AS pct_cancelados
  FROM days d
  LEFT JOIN final_status fs ON fs.fecha = d.fecha
  GROUP BY d.fecha
  ORDER BY d.fecha DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_daily_reports_range(DATE, DATE) TO authenticated;
