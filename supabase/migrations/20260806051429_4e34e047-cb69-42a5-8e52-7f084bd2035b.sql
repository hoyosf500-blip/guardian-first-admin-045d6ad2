CREATE OR REPLACE FUNCTION public.logistics_dashboard(
  p_from_date date, p_to_date date, p_ciudad text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS $$
DECLARE v_store uuid; v_result jsonb;
BEGIN
  v_store := public._resolve_scope_store();
  SELECT jsonb_build_object(
    'kpis', (SELECT row_to_json(t) FROM (
      SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE public._estado_bucket(o.estado)='entregado')::int AS entregados,
        COUNT(*) FILTER (WHERE public._estado_bucket(o.estado)='devuelto')::int AS devueltos,
        COUNT(*) FILTER (WHERE public._estado_bucket(o.estado)='en_transito')::int AS en_transito
      FROM public.orders o
      WHERE o.store_id=v_store AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
        AND o.fecha::date BETWEEN p_from_date AND p_to_date
        AND (p_ciudad IS NULL OR o.ciudad=p_ciudad)
        AND public._estado_bucket(o.estado) <> 'borrado') t),
    'by_transportadora', COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT o.transportadora, COUNT(*)::int AS total FROM public.orders o
      WHERE o.store_id=v_store AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
        AND o.fecha::date BETWEEN p_from_date AND p_to_date
        AND (p_ciudad IS NULL OR o.ciudad=p_ciudad)
        AND public._estado_bucket(o.estado) <> 'borrado'
        AND o.transportadora IS NOT NULL AND o.transportadora <> ''
      GROUP BY o.transportadora HAVING COUNT(*)>=5 ORDER BY COUNT(*) DESC) t), '[]'::jsonb),
    'by_transportadora_and_date', COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT o.fecha::date AS fecha, o.transportadora, COUNT(*)::int AS total
      FROM public.orders o
      WHERE o.store_id=v_store AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
        AND o.fecha::date BETWEEN p_from_date AND p_to_date
        AND (p_ciudad IS NULL OR o.ciudad=p_ciudad)
        AND public._estado_bucket(o.estado) <> 'borrado'
        AND o.transportadora IS NOT NULL AND o.transportadora <> ''
      GROUP BY o.fecha::date, o.transportadora ORDER BY o.fecha::date) t), '[]'::jsonb),
    'by_estado', COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT CASE public._estado_bucket(o.estado)
          WHEN 'entregado' THEN 'Entregada a destino'
          WHEN 'devuelto' THEN 'Devolucion a origen'
          WHEN 'en_transito' THEN 'En transito'
          WHEN 'novedad' THEN 'Novedad'
          WHEN 'rechazado' THEN 'Rechazada'
          WHEN 'preparacion' THEN 'En preparacion'
          WHEN 'pendiente' THEN 'Pendiente'
          WHEN 'cancelado' THEN 'Cancelada'
          ELSE 'Otro' END AS estado_agrupado,
        COUNT(*)::int AS total
      FROM public.orders o
      WHERE o.store_id=v_store AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
        AND o.fecha::date BETWEEN p_from_date AND p_to_date
        AND (p_ciudad IS NULL OR o.ciudad=p_ciudad)
        AND public._estado_bucket(o.estado) <> 'borrado'
      GROUP BY 1 ORDER BY 2 DESC) t), '[]'::jsonb),
    'by_date_and_estado', COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT o.fecha::date AS fecha,
        COUNT(*) FILTER (WHERE public._estado_bucket(o.estado)='entregado')::int AS entregada,
        COUNT(*) FILTER (WHERE public._estado_bucket(o.estado)='devuelto')::int AS devolucion,
        COUNT(*) FILTER (WHERE public._estado_bucket(o.estado)='en_transito')::int AS transito,
        COUNT(*) FILTER (WHERE public._estado_bucket(o.estado)='novedad')::int AS novedad,
        COUNT(*) FILTER (WHERE public._estado_bucket(o.estado)='rechazado')::int AS rechazada
      FROM public.orders o
      WHERE o.store_id=v_store AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
        AND o.fecha::date BETWEEN p_from_date AND p_to_date
        AND (p_ciudad IS NULL OR o.ciudad=p_ciudad)
        AND public._estado_bucket(o.estado) <> 'borrado'
      GROUP BY o.fecha::date ORDER BY o.fecha::date) t), '[]'::jsonb),
    'by_transportadora_and_estado', COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT o.transportadora,
        COUNT(*) FILTER (WHERE public._estado_bucket(o.estado)='entregado')::int AS entregada,
        COUNT(*) FILTER (WHERE public._estado_bucket(o.estado)='devuelto')::int AS devolucion,
        COUNT(*) FILTER (WHERE public._estado_bucket(o.estado)='en_transito')::int AS transito,
        COUNT(*) FILTER (WHERE public._estado_bucket(o.estado)='novedad')::int AS novedad,
        COUNT(*) FILTER (WHERE public._estado_bucket(o.estado)='rechazado')::int AS rechazada,
        COUNT(*)::int AS total
      FROM public.orders o
      WHERE o.store_id=v_store AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
        AND o.fecha::date BETWEEN p_from_date AND p_to_date
        AND (p_ciudad IS NULL OR o.ciudad=p_ciudad)
        AND public._estado_bucket(o.estado) <> 'borrado'
        AND o.transportadora IS NOT NULL AND o.transportadora <> ''
      GROUP BY o.transportadora HAVING COUNT(*)>=5 ORDER BY COUNT(*) DESC) t), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END; $$;

GRANT EXECUTE ON FUNCTION public.logistics_dashboard(date, date, text) TO authenticated;

NOTIFY pgrst, 'reload schema';