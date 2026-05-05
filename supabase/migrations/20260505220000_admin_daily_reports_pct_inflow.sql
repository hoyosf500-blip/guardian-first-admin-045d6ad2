-- /admin → Reportes diarios: las columnas % CONF. y % CANC. ahora se
-- calculan sobre el INFLOW del día (total de pedidos que entraron al
-- flujo de confirmación en esa fecha), no sobre lo que la operadora
-- gestionó. Espeja la lógica del RPC operator_productivity_stats v
-- 20260505184140 — la misión de la operadora es gestionar TODO el
-- inflow, así que el denominador debe ser el inflow.
--
-- Ejemplo: si entraron 100 pedidos el día y la operadora confirmó
-- 50 (sin gestionar los otros 50), antes mostraba 100% (50/50 lo
-- gestionado), ahora muestra 50% (50/100 lo entrante). Refleja
-- productividad real, no solo conversión.
--
-- Reportado por usuario 2026-05-05: "el % de confirmacion debe ser
-- con el total de pedidos no con lo que las operadoras gestionan la
-- metrica estandar o la mision es que gestionen todo".

DROP FUNCTION IF EXISTS public.admin_daily_reports_range(DATE, DATE);

CREATE OR REPLACE FUNCTION public.admin_daily_reports_range(p_from DATE, p_to DATE)
RETURNS TABLE (
  fecha DATE,
  tipo TEXT,
  operadora TEXT,
  hora TIMESTAMPTZ,
  pedidos_nuevos INT,
  guias_apertura INT,
  pendientes_ayer INT,
  confirmados INT,
  noresp INT,
  cancelados INT,
  total_gestionados INT,
  pct_confirmacion NUMERIC,
  pct_cancelados NUMERIC,
  pendientes_manana INT,
  notas TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo admins';
  END IF;

  RETURN QUERY
  -- ── Filas de APERTURA: sin cambio. Los % no aplican.
  SELECT
    dr.report_date,
    'apertura'::text,
    COALESCE(p.display_name, 'Operador'),
    dr.opening_at,
    dr.opening_new_orders,
    dr.opening_guides_yesterday,
    dr.opening_pending_yesterday,
    NULL::int, NULL::int, NULL::int, NULL::int,
    NULL::numeric, NULL::numeric, NULL::int,
    dr.opening_notes
  FROM public.operator_daily_reports dr
  LEFT JOIN public.profiles p ON p.user_id = dr.user_id
  WHERE dr.report_date BETWEEN p_from AND p_to
    AND dr.opening_at IS NOT NULL

  UNION ALL

  -- ── Filas de CIERRE: % sobre INFLOW del día (no sobre gestionado).
  -- LATERAL JOIN computa el inflow para esa report_date — total de
  -- pedidos creados ese día (en hora Bogotá) que entraron al flujo
  -- de confirmación. Excluye pedidos sincronizados desde Dropi en
  -- estados ya avanzados (ENTREGADO directo, etc.) que nunca pasaron
  -- por la cola de confirmación de Guardian.
  SELECT
    dr.report_date,
    'cierre'::text,
    COALESCE(p.display_name, 'Operador'),
    dr.closing_at,
    NULL::int, NULL::int, NULL::int,
    dr.closing_confirmados,
    dr.closing_noresp,
    dr.closing_cancelados,
    COALESCE(dr.closing_confirmados, 0)
      + COALESCE(dr.closing_cancelados, 0)
      + COALESCE(dr.closing_noresp, 0),
    CASE
      WHEN COALESCE(inflow.total, 0) = 0 THEN 0
      ELSE ROUND(
        (COALESCE(dr.closing_confirmados, 0)::numeric / inflow.total::numeric) * 100,
        0
      )
    END,
    CASE
      WHEN COALESCE(inflow.total, 0) = 0 THEN 0
      ELSE ROUND(
        (COALESCE(dr.closing_cancelados, 0)::numeric / inflow.total::numeric) * 100,
        0
      )
    END,
    dr.closing_pending_tomorrow,
    dr.closing_notes
  FROM public.operator_daily_reports dr
  LEFT JOIN public.profiles p ON p.user_id = dr.user_id
  LEFT JOIN LATERAL (
    SELECT COUNT(DISTINCT o.id) AS total
    FROM public.orders o
    WHERE (o.created_at AT TIME ZONE 'America/Bogota')::date = dr.report_date
      AND (
        o.estado = 'PENDIENTE CONFIRMACION'
        OR EXISTS (
          SELECT 1
          FROM public.order_results r
          WHERE r.order_id = o.id
            AND r.module = 'confirmar'
        )
      )
  ) inflow ON true
  WHERE dr.report_date BETWEEN p_from AND p_to
    AND dr.closing_at IS NOT NULL

  ORDER BY 1 ASC, 3 ASC, 2 ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_daily_reports_range(DATE, DATE) TO authenticated;
