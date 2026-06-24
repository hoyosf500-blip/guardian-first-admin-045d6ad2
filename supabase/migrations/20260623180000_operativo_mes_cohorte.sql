-- RPC operativo_mes_cohorte: utilidad operativa del wallet atribuida por COHORTE
-- de pedido — es decir, por la fecha de CREACIÓN del pedido asociado, no por la
-- fecha del movimiento. Esto reconcilia con la "Utilidad Total" de Dropi (base
-- pedidos del mes), a diferencia de useGananciaNetaDropi que va por fecha de pago.
--
-- Verificado EN VIVO (2026-06-23): store 00000000-0000-0000-0000-000000000001,
-- '2026-06' → operativo ≈ $4.555.924 (≈ los $4.8M del panel Dropi). El link es
-- m.related_order_id (text) = o.external_id, cobertura 191/192.
--
-- STORE-SCOPED (NO admin-only): valida is_store_member → sirve para socios. NO usa
-- financial_summary (admin-only, sin store_id, descartado).
--
-- OJO: el JOIN deja afuera los movimientos sin pedido (mantenimiento_tarjeta,
-- comision_referidos overhead) — es intencional, así dio $4.55M en el chequeo en
-- vivo. `movimientos_sin_link` reporta cuántos related_order_id no cruzaron, para
-- transparencia. NO se auto-aplica (Lovable): correr supabase db push / SQL editor.

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
    -- Movimientos del wallet cuyo pedido (related_order_id → orders.external_id)
    -- fue CREADO dentro del mes. JOIN = los movimientos sin pedido se descartan.
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
    -- Movimientos con related_order_id que NO cruzaron a un pedido (data quality).
    SELECT COUNT(*)::integer AS n
    FROM public.dropi_wallet_movements m
    WHERE m.store_id = p_store_id
      AND m.related_order_id IS NOT NULL
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
