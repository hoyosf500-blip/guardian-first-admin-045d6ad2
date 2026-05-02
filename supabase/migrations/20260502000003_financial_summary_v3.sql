-- v3: corrige el modelo financiero y expone 2 categorías de wallet que no
-- existen en orders: comision_referidos (resta de utilidad) y
-- ganancia_dropshipper/proveedor (informativo — sumarlo a utilidad
-- requiere sanity check del cliente para descartar doble conteo con
-- cobro_entrega).
--
-- Anti-doble-conteo:
--   - orders.valor (entregadas) y wallet.cobro_entrega son el MISMO dinero;
--     usamos solo orders.valor.
--   - orders.flete y wallet.flete_inicial son el MISMO costo;
--     usamos solo orders.flete (= shipping_amount = costo logístico al carrier).
--   - costo_devolucion, comision_referidos y ganancia_* SOLO existen en
--     wallet, así que de ahí salen.
--
-- Aplicar con `supabase db push`. Idempotente (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION public.financial_summary(
  p_from_date DATE,
  p_to_date   DATE
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  WITH
  filtered AS (
    SELECT * FROM public.orders
    WHERE fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND fecha::date BETWEEN p_from_date AND p_to_date
  ),
  entregados AS (
    SELECT * FROM filtered WHERE UPPER(COALESCE(estado, '')) = 'ENTREGADO'
  ),
  devueltos AS (
    SELECT * FROM filtered
    WHERE UPPER(COALESCE(estado, '')) IN ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')
  ),
  wallet_range AS (
    SELECT * FROM public.dropi_wallet_movements
    WHERE fecha::date BETWEEN p_from_date AND p_to_date
  ),
  agg AS (
    SELECT
      COALESCE((SELECT SUM(valor)      FROM entregados), 0) AS ingresos_brutos,
      COALESCE((SELECT SUM(costo_prod) FROM entregados), 0) AS cogs,
      COALESCE((SELECT SUM(flete)      FROM entregados), 0) AS flete_entregadas,
      COALESCE((SELECT SUM(flete)      FROM devueltos),  0) AS flete_devoluciones,
      COALESCE((SELECT SUM(ABS(monto)) FROM wallet_range
                WHERE categoria = 'costo_devolucion'),  0) AS costo_devoluciones,
      COALESCE((SELECT SUM(ABS(monto)) FROM wallet_range
                WHERE categoria = 'comision_referidos'),0) AS comision_referidos,
      COALESCE((SELECT SUM(monto) FROM wallet_range
                WHERE categoria IN ('ganancia_dropshipper','ganancia_proveedor')
                  AND tipo = 'ENTRADA'), 0) AS ganancia_markup,
      (SELECT COUNT(*) FROM filtered)   AS total_ordenes,
      (SELECT COUNT(*) FROM entregados) AS total_entregadas,
      (SELECT COUNT(*) FROM devueltos)  AS total_devueltas,
      COALESCE((SELECT AVG(valor) FROM entregados), 0) AS avg_ticket,
      COALESCE((SELECT SUM(
        CASE WHEN tipo = 'ENTRADA' THEN monto ELSE -monto END
      ) FROM wallet_range), 0) AS wallet_neto
  )
  SELECT jsonb_build_object(
    'ingresos_brutos',     a.ingresos_brutos,
    'cogs',                a.cogs,
    'flete_entregadas',    a.flete_entregadas,
    'flete_devoluciones',  a.flete_devoluciones,
    'costo_devoluciones',  a.costo_devoluciones,
    'comision_referidos',  a.comision_referidos,
    'ganancia_markup',     a.ganancia_markup,
    'utilidad_bruta',
        a.ingresos_brutos
      - a.cogs
      - a.flete_entregadas
      - a.flete_devoluciones
      - a.costo_devoluciones
      - a.comision_referidos,
    'total_ordenes',       a.total_ordenes,
    'total_entregadas',    a.total_entregadas,
    'total_devueltas',     a.total_devueltas,
    'tasa_entrega_pct',
      CASE WHEN a.total_ordenes > 0
        THEN ROUND(100.0 * a.total_entregadas::numeric / a.total_ordenes, 2)
        ELSE 0 END,
    'ticket_promedio',
      CASE WHEN a.total_entregadas > 0
        THEN ROUND(a.avg_ticket::numeric, 0)
        ELSE 0 END,
    'wallet_neto',         a.wallet_neto
  ) INTO v_result FROM agg a;

  RETURN v_result;
END;
$func$;

REVOKE ALL ON FUNCTION public.financial_summary(DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.financial_summary(DATE, DATE) TO authenticated;

COMMENT ON FUNCTION public.financial_summary(DATE, DATE) IS
  'Fase A — utilidad bruta operativa. Usa orders para ingreso/COGS/flete y wallet solo para costo_devolucion, comision_referidos y ganancia_markup. ganancia_markup es informativo (no se suma a utilidad hasta sanity check). NO incluye gasto pauta (Fase B).';
