-- /logistica → "Rentabilidad por producto"
-- RPC que desglosa cuánta plata se gana o pierde por producto en un
-- rango de fechas, considerando entregados, devueltos, cancelados y
-- en tránsito (con proyección).
--
-- Fórmulas:
--   utilidad_real = ingresos_entregados
--                 - costo_prod_entregados
--                 - flete_inicial_entregados
--                 - costo_devolucion_total
--   utilidad_promedio_por_entrega = (ingresos - costo_prod - flete) / entregados
--   tasa_entrega = entregados / (entregados + devueltos + en_transito)
--   utilidad_proyectada = utilidad_real
--                       + en_transito * tasa_entrega * utilidad_promedio
--                       - en_transito * tasa_devolucion * costo_devol_promedio
--
-- Admin-only via has_role gate (mismo patrón que logistics_by_product).

CREATE OR REPLACE FUNCTION public.product_profitability(
  p_from_date DATE,
  p_to_date   DATE,
  p_limit     INTEGER DEFAULT 100
)
RETURNS TABLE (
  producto                  TEXT,
  total_pedidos             BIGINT,
  entregados                BIGINT,
  devueltos                 BIGINT,
  cancelados                BIGINT,
  en_transito               BIGINT,
  ingresos_entregados       NUMERIC,
  costo_prod_entregados     NUMERIC,
  flete_inicial_entregados  NUMERIC,
  costo_devolucion_total    NUMERIC,
  utilidad_real             NUMERIC,
  utilidad_proyectada       NUMERIC,
  tasa_entrega              NUMERIC,
  tasa_devolucion           NUMERIC,
  tasa_cancelacion          NUMERIC,
  ticket_promedio           NUMERIC,
  margen_pct                NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH agg AS (
    SELECT
      o.producto::TEXT AS producto,
      COUNT(*) AS total_pedidos,
      COUNT(*) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO') AS entregados,
      COUNT(*) FILTER (WHERE UPPER(o.estado) IN
        ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')) AS devueltos,
      COUNT(*) FILTER (WHERE UPPER(o.estado) IN
        ('CANCELADO', 'CANCELADO LOCALMENTE')) AS cancelados,
      COUNT(*) FILTER (WHERE UPPER(o.estado) NOT IN
        ('ENTREGADO', 'DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO',
         'CANCELADO', 'CANCELADO LOCALMENTE')) AS en_transito,
      COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'), 0) AS ingresos_entregados,
      COALESCE(SUM(o.costo_prod) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'), 0) AS costo_prod_entregados,
      COALESCE(SUM(o.flete) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'), 0) AS flete_inicial_entregados,
      COALESCE(SUM(o.costo_dev) FILTER (WHERE UPPER(o.estado) IN
        ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')), 0) AS costo_devolucion_total
    FROM public.orders o
    WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND o.producto IS NOT NULL
      AND o.producto <> ''
    GROUP BY o.producto
  ),
  with_calc AS (
    SELECT
      a.*,
      (a.ingresos_entregados - a.costo_prod_entregados - a.flete_inicial_entregados - a.costo_devolucion_total)
        AS utilidad_real_calc,
      CASE WHEN a.entregados > 0
        THEN (a.ingresos_entregados - a.costo_prod_entregados - a.flete_inicial_entregados) / a.entregados
        ELSE 0
      END AS utilidad_prom_entrega,
      CASE WHEN a.devueltos > 0
        THEN a.costo_devolucion_total / a.devueltos
        ELSE 0
      END AS costo_prom_devolucion,
      CASE WHEN (a.entregados + a.devueltos + a.en_transito) > 0
        THEN a.entregados::NUMERIC / (a.entregados + a.devueltos + a.en_transito)
        ELSE 0
      END AS tasa_entrega_dec,
      CASE WHEN (a.entregados + a.devueltos + a.en_transito) > 0
        THEN a.devueltos::NUMERIC / (a.entregados + a.devueltos + a.en_transito)
        ELSE 0
      END AS tasa_devolucion_dec
    FROM agg a
  )
  SELECT
    w.producto,
    w.total_pedidos,
    w.entregados,
    w.devueltos,
    w.cancelados,
    w.en_transito,
    w.ingresos_entregados,
    w.costo_prod_entregados,
    w.flete_inicial_entregados,
    w.costo_devolucion_total,
    w.utilidad_real_calc AS utilidad_real,
    (w.utilidad_real_calc
      + w.en_transito * w.tasa_entrega_dec * w.utilidad_prom_entrega
      - w.en_transito * w.tasa_devolucion_dec * w.costo_prom_devolucion
    ) AS utilidad_proyectada,
    ROUND(w.tasa_entrega_dec * 100, 2) AS tasa_entrega,
    ROUND(w.tasa_devolucion_dec * 100, 2) AS tasa_devolucion,
    ROUND(
      CASE WHEN w.total_pedidos > 0
        THEN w.cancelados::NUMERIC / w.total_pedidos
        ELSE 0
      END * 100, 2
    ) AS tasa_cancelacion,
    CASE WHEN w.entregados > 0
      THEN ROUND(w.ingresos_entregados / w.entregados, 0)
      ELSE 0
    END AS ticket_promedio,
    CASE WHEN w.ingresos_entregados > 0
      THEN ROUND(w.utilidad_real_calc / w.ingresos_entregados * 100, 2)
      ELSE 0
    END AS margen_pct
  FROM with_calc w
  ORDER BY w.total_pedidos DESC, w.utilidad_real_calc DESC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.product_profitability(DATE, DATE, INTEGER) TO authenticated;
