-- /admin → Reportes diarios: detalle de APERTURA/CIERRE por operadora.
-- Acompaña a admin_daily_reports_range (vista cohort por día) — no la
-- reemplaza. Cada panel muestra una vista distinta:
--
--   admin_daily_reports_range  → 1 fila por fecha con % cohort (negocio)
--   admin_operator_shifts_range → filas apertura/cierre por operadora
--                                 con conteos crudos + notas (operativo)
--
-- Sin columnas pct_*: el % de cohort vive en admin_daily_reports_range.
-- Acá solo conteos crudos y notas, que es lo que la operadora reporta
-- cuando abre/cierra turno.
--
-- Repuesta a request 2026-05-05: "ahora se me borro el informe de
-- abertura y cierre de las colaboraoras". Esta vista mantiene visible
-- el detalle por operadora que se había dejado afuera al pivotear el
-- panel a vista por día.

DROP FUNCTION IF EXISTS public.admin_operator_shifts_range(DATE, DATE);

CREATE OR REPLACE FUNCTION public.admin_operator_shifts_range(p_from DATE, p_to DATE)
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
  pendientes_manana INT,
  notas TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo admins';
  END IF;

  RETURN QUERY
  -- Filas de APERTURA: lo que la operadora reportó al iniciar turno.
  SELECT
    dr.report_date,
    'apertura'::text,
    COALESCE(p.display_name, 'Operador'),
    dr.opening_at,
    dr.opening_new_orders,
    dr.opening_guides_yesterday,
    dr.opening_pending_yesterday,
    NULL::int, NULL::int, NULL::int, NULL::int, NULL::int,
    dr.opening_notes
  FROM public.operator_daily_reports dr
  LEFT JOIN public.profiles p ON p.user_id = dr.user_id
  WHERE dr.report_date BETWEEN p_from AND p_to
    AND dr.opening_at IS NOT NULL

  UNION ALL

  -- Filas de CIERRE: conteos al cerrar turno (closing_noresp ya está
  -- dedupeado desde la migración 20260505200000).
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
    dr.closing_pending_tomorrow,
    dr.closing_notes
  FROM public.operator_daily_reports dr
  LEFT JOIN public.profiles p ON p.user_id = dr.user_id
  WHERE dr.report_date BETWEEN p_from AND p_to
    AND dr.closing_at IS NOT NULL

  ORDER BY 1 DESC, 3 ASC, 2 ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_operator_shifts_range(DATE, DATE) TO authenticated;
