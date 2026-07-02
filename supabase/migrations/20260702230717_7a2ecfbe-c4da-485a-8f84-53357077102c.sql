-- FIX paridad 2026-07-02: `movimientos_sin_link` de operativo_mes_cohorte contaba
-- los movimientos no-cruzados de TODA la historia de la tienda, pero la card lo
-- muestra en el contexto de "Neto real DEL MES" — un usuario razonable lee
-- "8 movimientos de mayo" y eso no era cierto (eran de toda la vida de la tienda).
-- Ahora el conteo se limita a movimientos cuya FECHA DE PAGO cae dentro del mes
-- consultado. El cálculo del operativo NO cambia (auditado 2026-07-02: 621.78
-- exacto contra el wallet para mayo EC).

CREATE OR REPLACE FUNCTION public.operativo_mes_cohorte(
  p_store_id   uuid,
  p_year_month text
)
RETURNS TABLE (
  operativo            numeric,
  total_entradas       numeric,
  total_salidas        numeric,
  movimientos_sin_link integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_from date;
  v_to   date;
BEGIN
  IF NOT public.is_store_member(p_store_id) THEN
    RAISE EXCEPTION 'No sos miembro de esta tienda' USING ERRCODE = '42501';
  END IF;
  IF p_year_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'year_month inválido (esperado YYYY-MM): %', p_year_month USING ERRCODE = '22007';
  END IF;
  v_from := (p_year_month || '-01')::date;
  v_to   := v_from + INTERVAL '1 month';

  RETURN QUERY
  WITH linked AS (
    SELECT m.categoria AS cat, ABS(COALESCE(m.monto, 0)) AS monto
    FROM public.dropi_wallet_movements m
    JOIN public.orders o
      ON o.external_id = m.related_order_id
     AND o.store_id   = m.store_id
    WHERE m.store_id = p_store_id
      AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date >= v_from
      AND o.fecha::date <  v_to
  ),
  sin_link AS (
    SELECT COUNT(*)::integer AS n
    FROM public.dropi_wallet_movements m
    WHERE m.store_id = p_store_id
      AND m.related_order_id IS NOT NULL
      AND m.fecha >= v_from
      AND m.fecha <  v_to
      AND NOT EXISTS (
        SELECT 1 FROM public.orders o
        WHERE o.external_id = m.related_order_id AND o.store_id = m.store_id
      )
  )
  SELECT
    COALESCE(SUM(monto) FILTER (WHERE cat IN
      ('ganancia_dropshipper','ganancia_proveedor','reembolso_flete','indemnizacion')), 0)
    - COALESCE(SUM(monto) FILTER (WHERE cat IN
      ('flete_inicial','costo_devolucion','comision_referidos','mantenimiento_tarjeta','orden_sin_recaudo')), 0)
      AS operativo,
    COALESCE(SUM(monto) FILTER (WHERE cat IN
      ('ganancia_dropshipper','ganancia_proveedor','reembolso_flete','indemnizacion')), 0)
      AS total_entradas,
    COALESCE(SUM(monto) FILTER (WHERE cat IN
      ('flete_inicial','costo_devolucion','comision_referidos','mantenimiento_tarjeta','orden_sin_recaudo')), 0)
      AS total_salidas,
    (SELECT n FROM sin_link) AS movimientos_sin_link
  FROM linked;
END;
$func$;

GRANT EXECUTE ON FUNCTION public.operativo_mes_cohorte(uuid, text) TO authenticated;