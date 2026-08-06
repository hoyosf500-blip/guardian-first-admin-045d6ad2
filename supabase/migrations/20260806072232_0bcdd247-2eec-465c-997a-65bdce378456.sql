CREATE OR REPLACE FUNCTION public.costos_unitarios(
  p_from_date date,
  p_to_date   date,
  p_ciudad    text DEFAULT NULL
)
RETURNS TABLE(
  entregados                bigint,
  devueltos                 bigint,
  ingresos_entregados       numeric,
  cogs_entregados           numeric,
  flete_entregados          numeric,
  flete_devueltos           numeric,
  cargo_devolucion_total    numeric,
  devoluciones_con_cargo    bigint,
  pauta_periodo             numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH pedidos AS (
    SELECT public._estado_bucket(o.estado) AS b, o.valor, o.costo_prod, o.flete
    FROM public.orders o
    WHERE o.store_id = v_store
      AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
      AND public._estado_bucket(o.estado) <> 'borrado'
  ),
  cargos AS (
    SELECT COALESCE(SUM(w.monto), 0)::numeric AS total,
           COUNT(*)::bigint                   AS n
    FROM public.dropi_wallet_movements w
    WHERE w.store_id = v_store
      AND w.categoria = 'costo_devolucion'
      AND w.fecha::date BETWEEN p_from_date AND p_to_date
  ),
  ads AS (
    SELECT COALESCE(SUM(amount), 0)::numeric AS total
    FROM public.store_ad_spend_daily
    WHERE store_id = v_store
      AND spend_date BETWEEN p_from_date AND p_to_date
  )
  SELECT
    COUNT(*) FILTER (WHERE b = 'entregado')::bigint,
    COUNT(*) FILTER (WHERE b = 'devuelto')::bigint,
    COALESCE(SUM(valor)      FILTER (WHERE b = 'entregado'), 0)::numeric,
    COALESCE(SUM(costo_prod) FILTER (WHERE b = 'entregado'), 0)::numeric,
    COALESCE(SUM(flete)      FILTER (WHERE b = 'entregado'), 0)::numeric,
    COALESCE(SUM(flete)      FILTER (WHERE b = 'devuelto'), 0)::numeric,
    (SELECT total FROM cargos),
    (SELECT n     FROM cargos),
    (SELECT total FROM ads)
  FROM pedidos;
END;
$$;

GRANT EXECUTE ON FUNCTION public.costos_unitarios(date, date, text) TO authenticated;

NOTIFY pgrst, 'reload schema';