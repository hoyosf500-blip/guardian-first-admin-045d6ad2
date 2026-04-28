CREATE OR REPLACE FUNCTION public.logistics_dashboard(p_range text DEFAULT '30d')
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since timestamptz;
  v_result jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  v_since := CASE p_range
    WHEN '7d'  THEN NOW() - INTERVAL '7 days'
    WHEN '30d' THEN NOW() - INTERVAL '30 days'
    WHEN '90d' THEN NOW() - INTERVAL '90 days'
    ELSE NOW() - INTERVAL '30 days'
  END;

  SELECT jsonb_build_object(
    'kpis', (
      SELECT row_to_json(t) FROM (
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE estado = 'ENTREGADO')::int AS entregados,
          COUNT(*) FILTER (WHERE estado IN ('DEVOLUCION','DEVOLUCION EN TRANSITO'))::int AS devueltos,
          COUNT(*) FILTER (WHERE estado IN ('EN TRANSPORTE','EN DESPACHO','EN TRASLADO NACIONAL','EN REPARTO'))::int AS en_transito
        FROM orders WHERE created_at >= v_since
      ) t
    ),
    'by_transportadora', COALESCE((
      SELECT jsonb_agg(row_to_json(t)) FROM (
        SELECT transportadora, COUNT(*)::int AS total
        FROM orders
        WHERE created_at >= v_since AND transportadora IS NOT NULL AND transportadora <> ''
        GROUP BY transportadora HAVING COUNT(*) >= 5
        ORDER BY COUNT(*) DESC
      ) t
    ), '[]'::jsonb),
    'by_transportadora_and_date', COALESCE((
      SELECT jsonb_agg(row_to_json(t)) FROM (
        SELECT DATE(created_at) AS fecha, transportadora, COUNT(*)::int AS total
        FROM orders
        WHERE created_at >= v_since AND transportadora IS NOT NULL AND transportadora <> ''
        GROUP BY DATE(created_at), transportadora
        ORDER BY DATE(created_at)
      ) t
    ), '[]'::jsonb),
    'by_estado', COALESCE((
      SELECT jsonb_agg(row_to_json(t)) FROM (
        SELECT
          CASE
            WHEN estado = 'ENTREGADO' THEN 'Entregada a destino'
            WHEN estado IN ('DEVOLUCION','DEVOLUCION EN TRANSITO') THEN 'Devolucion a origen'
            WHEN estado IN ('EN TRANSPORTE','EN DESPACHO','EN TRASLADO NACIONAL','EN REPARTO') THEN 'En transito'
            WHEN estado IN ('NOVEDAD','INTENTO DE ENTREGA') THEN 'Novedad'
            WHEN estado = 'RECHAZADO' THEN 'Rechazada'
            WHEN estado IN ('PENDIENTE CONFIRMACION','CONFIRMADO') THEN 'En preparacion'
            WHEN estado = 'CANCELADO' THEN 'Cancelada'
            ELSE 'Otro'
          END AS estado_agrupado,
          COUNT(*)::int AS total
        FROM orders WHERE created_at >= v_since
        GROUP BY 1 ORDER BY 2 DESC
      ) t
    ), '[]'::jsonb),
    'by_date_and_estado', COALESCE((
      SELECT jsonb_agg(row_to_json(t)) FROM (
        SELECT DATE(created_at) AS fecha,
          COUNT(*) FILTER (WHERE estado = 'ENTREGADO')::int AS entregada,
          COUNT(*) FILTER (WHERE estado IN ('DEVOLUCION','DEVOLUCION EN TRANSITO'))::int AS devolucion,
          COUNT(*) FILTER (WHERE estado IN ('EN TRANSPORTE','EN DESPACHO','EN TRASLADO NACIONAL','EN REPARTO'))::int AS transito,
          COUNT(*) FILTER (WHERE estado IN ('NOVEDAD','INTENTO DE ENTREGA'))::int AS novedad,
          COUNT(*) FILTER (WHERE estado = 'RECHAZADO')::int AS rechazada
        FROM orders WHERE created_at >= v_since
        GROUP BY DATE(created_at) ORDER BY DATE(created_at)
      ) t
    ), '[]'::jsonb),
    'by_transportadora_and_estado', COALESCE((
      SELECT jsonb_agg(row_to_json(t)) FROM (
        SELECT transportadora,
          COUNT(*) FILTER (WHERE estado = 'ENTREGADO')::int AS entregada,
          COUNT(*) FILTER (WHERE estado IN ('DEVOLUCION','DEVOLUCION EN TRANSITO'))::int AS devolucion,
          COUNT(*) FILTER (WHERE estado IN ('EN TRANSPORTE','EN DESPACHO','EN TRASLADO NACIONAL','EN REPARTO'))::int AS transito,
          COUNT(*) FILTER (WHERE estado IN ('NOVEDAD','INTENTO DE ENTREGA'))::int AS novedad,
          COUNT(*) FILTER (WHERE estado = 'RECHAZADO')::int AS rechazada,
          COUNT(*)::int AS total
        FROM orders
        WHERE created_at >= v_since AND transportadora IS NOT NULL AND transportadora <> ''
        GROUP BY transportadora HAVING COUNT(*) >= 5
        ORDER BY COUNT(*) DESC
      ) t
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_dashboard(text) TO authenticated;

NOTIFY pgrst, 'reload schema';