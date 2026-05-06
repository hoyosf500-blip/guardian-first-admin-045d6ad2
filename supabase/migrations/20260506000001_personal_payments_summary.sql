-- /cfo → bloque "Pagado vs Pendiente"
--
-- Dos RPCs admin-only para el componente CfoPaymentsVsDebt:
--   personal_payments_summary  → flujo mensual (compras vs pagos vs intereses
--                                vs avances), separando COP y USD
--   personal_residual_debt     → snapshot actual de deuda residual por
--                                tarjeta+moneda, basado en saldo_pendiente
--                                de la cuota más reciente conocida.
--
-- No hay conversión USD→COP en el server (la TRM cambia diario, mejor que
-- la UI use la que prefiera). Lectura sobre personal_card_movements.

CREATE OR REPLACE FUNCTION public.personal_payments_summary(
  p_from_date DATE DEFAULT (CURRENT_DATE - INTERVAL '12 months')::DATE,
  p_to_date   DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  year_month        TEXT,
  compras_cop       NUMERIC,
  compras_usd       NUMERIC,
  pagos_cop         NUMERIC,        -- valor absoluto (abonos vienen con monto negativo)
  pagos_usd         NUMERIC,
  intereses_cop     NUMERIC,
  intereses_usd     NUMERIC,
  avances_cop       NUMERIC,
  avances_usd       NUMERIC,
  comisiones_cop    NUMERIC,
  count_movimientos INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    TO_CHAR(m.fecha, 'YYYY-MM') AS year_month,

    COALESCE(SUM(m.monto) FILTER (WHERE m.tipo = 'compra' AND m.moneda = 'COP'
                                    AND (m.cuota_numero IS NULL OR m.cuota_numero = 1)), 0) AS compras_cop,
    COALESCE(SUM(m.monto) FILTER (WHERE m.tipo = 'compra' AND m.moneda = 'USD'
                                    AND (m.cuota_numero IS NULL OR m.cuota_numero = 1)), 0) AS compras_usd,

    COALESCE(SUM(ABS(m.monto)) FILTER (WHERE m.tipo = 'abono' AND m.moneda = 'COP'), 0) AS pagos_cop,
    COALESCE(SUM(ABS(m.monto)) FILTER (WHERE m.tipo = 'abono' AND m.moneda = 'USD'), 0) AS pagos_usd,

    COALESCE(SUM(m.monto) FILTER (WHERE m.tipo = 'intereses' AND m.moneda = 'COP'), 0) AS intereses_cop,
    COALESCE(SUM(m.monto) FILTER (WHERE m.tipo = 'intereses' AND m.moneda = 'USD'), 0) AS intereses_usd,

    COALESCE(SUM(m.monto) FILTER (WHERE m.tipo = 'avance' AND m.moneda = 'COP'), 0) AS avances_cop,
    COALESCE(SUM(m.monto) FILTER (WHERE m.tipo = 'avance' AND m.moneda = 'USD'), 0) AS avances_usd,

    COALESCE(SUM(m.monto) FILTER (WHERE m.tipo = 'comision'), 0) AS comisiones_cop,

    COUNT(*)::INT AS count_movimientos
    FROM public.personal_card_movements m
   WHERE m.fecha BETWEEN p_from_date AND p_to_date
   GROUP BY 1
   ORDER BY 1 DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.personal_payments_summary(DATE, DATE) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- Deuda residual ACTUAL por tarjeta+moneda. Toma el saldo_pendiente
-- de la cuota más reciente conocida por compra (tarjeta+fecha+desc+
-- monto+moneda) — eso es lo que el banco dice que te queda.
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.personal_residual_debt()
RETURNS TABLE (
  tarjeta          TEXT,
  marca            TEXT,
  moneda           TEXT,
  saldo_pendiente  NUMERIC,
  num_compras      INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH ultima_cuota AS (
    SELECT DISTINCT ON (m.tarjeta, m.fecha, m.descripcion, m.monto, m.moneda)
      m.tarjeta, m.marca, m.moneda,
      COALESCE(m.saldo_pendiente, 0) AS saldo_pendiente
      FROM public.personal_card_movements m
     WHERE m.tipo = 'compra'
       AND m.cuotas_total IS NOT NULL
       AND m.cuotas_total > 1
       AND m.saldo_pendiente IS NOT NULL
     ORDER BY m.tarjeta, m.fecha, m.descripcion, m.monto, m.moneda,
              m.periodo_corte_to DESC NULLS LAST,
              m.cuota_numero DESC NULLS LAST
  )
  SELECT
    u.tarjeta,
    u.marca,
    u.moneda,
    SUM(u.saldo_pendiente) AS saldo_pendiente,
    COUNT(*)::INT          AS num_compras
    FROM ultima_cuota u
   WHERE u.saldo_pendiente > 0
   GROUP BY u.tarjeta, u.marca, u.moneda
   ORDER BY u.tarjeta, u.moneda;
END;
$$;

GRANT EXECUTE ON FUNCTION public.personal_residual_debt() TO authenticated;
