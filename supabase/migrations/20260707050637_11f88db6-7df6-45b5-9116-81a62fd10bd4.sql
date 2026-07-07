-- ============================================================
-- Migration 1/3: 20260526150000_wallet_ganancia_neta_rpc.sql
-- ============================================================
CREATE OR REPLACE FUNCTION public.wallet_ganancia_neta(
  p_from timestamptz,
  p_to   timestamptz
)
RETURNS TABLE (
  total_entradas        numeric,
  total_salidas         numeric,
  ganancia_neta         numeric,
  movimientos_count     bigint,
  ganancia_dropshipper  numeric,
  ganancia_proveedor    numeric,
  reembolso_flete       numeric,
  indemnizacion         numeric,
  flete_inicial         numeric,
  costo_devolucion      numeric,
  comision_referidos    numeric,
  mantenimiento_tarjeta numeric,
  orden_sin_recaudo     numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  RETURN QUERY
  WITH base AS (
    SELECT m.categoria AS cat, ABS(COALESCE(m.monto, 0)) AS monto
    FROM public.dropi_wallet_movements m
    WHERE m.fecha >= p_from AND m.fecha <= p_to
      AND (v_store IS NULL OR m.store_id = v_store)
      AND m.categoria IN (
        'ganancia_dropshipper','ganancia_proveedor','reembolso_flete','indemnizacion',
        'flete_inicial','costo_devolucion','comision_referidos','mantenimiento_tarjeta','orden_sin_recaudo'
      )
  ),
  agg AS (
    SELECT
      COALESCE(SUM(monto) FILTER (WHERE cat = 'ganancia_dropshipper'),  0) AS ganancia_dropshipper,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'ganancia_proveedor'),    0) AS ganancia_proveedor,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'reembolso_flete'),       0) AS reembolso_flete,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'indemnizacion'),         0) AS indemnizacion,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'flete_inicial'),         0) AS flete_inicial,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'costo_devolucion'),      0) AS costo_devolucion,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'comision_referidos'),    0) AS comision_referidos,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'mantenimiento_tarjeta'), 0) AS mantenimiento_tarjeta,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'orden_sin_recaudo'),     0) AS orden_sin_recaudo,
      COUNT(*) AS movimientos_count
    FROM base
  )
  SELECT
    (a.ganancia_dropshipper + a.ganancia_proveedor + a.reembolso_flete + a.indemnizacion)::numeric AS total_entradas,
    (a.flete_inicial + a.costo_devolucion + a.comision_referidos + a.mantenimiento_tarjeta + a.orden_sin_recaudo)::numeric AS total_salidas,
    (a.ganancia_dropshipper + a.ganancia_proveedor + a.reembolso_flete + a.indemnizacion
      - a.flete_inicial - a.costo_devolucion - a.comision_referidos - a.mantenimiento_tarjeta - a.orden_sin_recaudo)::numeric AS ganancia_neta,
    a.movimientos_count,
    a.ganancia_dropshipper, a.ganancia_proveedor, a.reembolso_flete, a.indemnizacion,
    a.flete_inicial, a.costo_devolucion, a.comision_referidos, a.mantenimiento_tarjeta, a.orden_sin_recaudo
  FROM agg a;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.wallet_ganancia_neta(timestamptz, timestamptz) TO authenticated;

-- ============================================================
-- Migration 2/3: 20260703001000_logistica_multitienda_fixes.sql
-- ============================================================
CREATE OR REPLACE FUNCTION public._resolve_scope_store()
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_store uuid;
BEGIN
  IF public.has_role(auth.uid(), 'admin') THEN
    SELECT active_store_id INTO v_store FROM public.profiles WHERE user_id = auth.uid();
    RETURN v_store;
  END IF;

  SELECT p.active_store_id INTO v_store
  FROM public.profiles p
  WHERE p.user_id = auth.uid()
    AND p.active_store_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.store_members m
      WHERE m.user_id = auth.uid()
        AND m.store_id = p.active_store_id
        AND m.role IN ('owner','supervisor')
    );
  IF v_store IS NOT NULL THEN
    RETURN v_store;
  END IF;

  SELECT store_id INTO v_store FROM public.store_members
   WHERE user_id = auth.uid() AND role IN ('owner','supervisor')
   ORDER BY store_id ASC
   LIMIT 1;
  IF v_store IS NULL THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  RETURN v_store;
END;
$$;

CREATE OR REPLACE FUNCTION public.logistics_timeline(
  p_from_date      DATE,
  p_to_date        DATE,
  p_estados        TEXT[] DEFAULT NULL,
  p_transportadora TEXT   DEFAULT NULL,
  p_search         TEXT   DEFAULT NULL,
  p_limit          INTEGER DEFAULT 50,
  p_offset         INTEGER DEFAULT 0
)
RETURNS TABLE (
  id              UUID,
  fecha           DATE,
  guia            TEXT,
  external_id     TEXT,
  estado          TEXT,
  transportadora  TEXT,
  ciudad          TEXT,
  producto        TEXT,
  valor           NUMERIC,
  total_count     BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_store uuid;
  v_search_pattern TEXT;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;

  v_search_pattern := CASE
    WHEN p_search IS NULL OR p_search = '' THEN NULL
    ELSE '%' || p_search || '%'
  END;

  RETURN QUERY
  WITH filtered AS (
    SELECT o.id, o.fecha, o.guia, o.external_id, o.estado,
           o.transportadora, o.ciudad, o.producto, o.valor, o.created_at
    FROM public.orders o
    WHERE o.store_id = v_store
      AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND (p_estados IS NULL OR UPPER(COALESCE(o.estado, '')) = ANY(p_estados))
      AND (p_transportadora IS NULL OR p_transportadora = '' OR o.transportadora = p_transportadora)
      AND (
        v_search_pattern IS NULL
        OR o.guia ILIKE v_search_pattern
        OR o.external_id ILIKE v_search_pattern
      )
  ),
  counted AS (
    SELECT COUNT(*) AS n FROM filtered
  )
  SELECT
    f.id,
    f.fecha::date,
    COALESCE(f.guia, '')::TEXT,
    COALESCE(f.external_id, '')::TEXT,
    COALESCE(f.estado, '')::TEXT,
    COALESCE(f.transportadora, '')::TEXT,
    COALESCE(f.ciudad, '')::TEXT,
    COALESCE(f.producto, '')::TEXT,
    COALESCE(f.valor, 0)::NUMERIC,
    counted.n AS total_count
  FROM filtered f, counted
  ORDER BY f.fecha::date DESC, f.created_at DESC NULLS LAST
  LIMIT p_limit OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_timeline(DATE, DATE, TEXT[], TEXT, TEXT, INTEGER, INTEGER) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_top_cities(
  p_limit INTEGER DEFAULT 200
)
RETURNS TABLE (
  ciudad        TEXT,
  departamento  TEXT,
  total_pedidos BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT
    o.ciudad::TEXT,
    COALESCE(o.departamento, '')::TEXT AS departamento,
    COUNT(*) AS total_pedidos
  FROM public.orders o
  WHERE o.store_id = v_store
    AND o.ciudad IS NOT NULL AND o.ciudad <> ''
  GROUP BY o.ciudad, COALESCE(o.departamento, '')
  ORDER BY total_pedidos DESC
  LIMIT p_limit;
END;
$func$;

GRANT EXECUTE ON FUNCTION public.get_top_cities(INTEGER) TO authenticated;

CREATE OR REPLACE FUNCTION public.logistics_by_city_carrier(p_from_date date, p_to_date date, p_min_orders integer DEFAULT 20, p_top_cities integer DEFAULT 20)
 RETURNS TABLE(ciudad text, departamento text, transportadora text, total_pedidos bigint, entregados bigint, devueltos bigint, tasa_entrega numeric, tasa_devolucion numeric, ciudad_total bigint)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH base AS (
    SELECT o.ciudad, COALESCE(o.departamento,'') AS departamento, o.transportadora, o.estado
    FROM public.orders o
    WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND o.ciudad IS NOT NULL AND o.ciudad <> ''
      AND o.transportadora IS NOT NULL AND o.transportadora <> ''
      AND UPPER(COALESCE(o.estado,'')) NOT LIKE '%CANCEL%'
      AND o.store_id = v_store
  ),
  city_volumes AS (
    SELECT b.ciudad, COUNT(*) AS total FROM base b
    GROUP BY b.ciudad HAVING COUNT(*) >= p_min_orders
    ORDER BY total DESC LIMIT p_top_cities
  )
  SELECT
    b.ciudad::TEXT, b.departamento::TEXT, b.transportadora::TEXT,
    COUNT(*),
    COUNT(*) FILTER (WHERE UPPER(b.estado)='ENTREGADO'),
    COUNT(*) FILTER (WHERE UPPER(b.estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')),
    ROUND((COUNT(*) FILTER (WHERE UPPER(b.estado)='ENTREGADO'))::numeric*100.0/NULLIF(COUNT(*),0),2),
    ROUND((COUNT(*) FILTER (WHERE UPPER(b.estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')))::numeric*100.0/NULLIF(COUNT(*),0),2),
    cv.total
  FROM base b INNER JOIN city_volumes cv ON cv.ciudad = b.ciudad
  GROUP BY b.ciudad, b.departamento, b.transportadora, cv.total
  HAVING COUNT(*) >= 5
  ORDER BY cv.total DESC, b.ciudad ASC, 4 DESC;
END;
$function$;

-- ============================================================
-- Migration 3/3: 20260703210000_store_work_schedule.sql
-- ============================================================
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