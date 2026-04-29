-- COST-2: Agregados server-side para BilleteraTab.
-- Antes el frontend traía hasta 10.000 filas para sumar y agrupar.
-- Ahora Postgres devuelve solo el resultado.

CREATE OR REPLACE FUNCTION public.wallet_summary(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  total_entradas numeric,
  total_salidas  numeric,
  count_total    bigint,
  ultimo_saldo   numeric,
  categorias     text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT tipo, monto, categoria, saldo_despues, fecha
    FROM public.dropi_wallet_movements
    WHERE fecha >= p_from AND fecha <= p_to
  ),
  ult AS (
    SELECT saldo_despues
    FROM base
    WHERE saldo_despues IS NOT NULL
    ORDER BY fecha DESC
    LIMIT 1
  )
  SELECT
    COALESCE(SUM(CASE WHEN tipo = 'ENTRADA' THEN monto ELSE 0 END), 0)::numeric AS total_entradas,
    COALESCE(SUM(CASE WHEN tipo = 'SALIDA'  THEN monto ELSE 0 END), 0)::numeric AS total_salidas,
    COUNT(*)::bigint AS count_total,
    (SELECT saldo_despues FROM ult) AS ultimo_saldo,
    COALESCE(ARRAY_AGG(DISTINCT categoria) FILTER (WHERE categoria IS NOT NULL), '{}') AS categorias
  FROM base;
$$;

CREATE OR REPLACE FUNCTION public.wallet_daily_series(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  fecha    date,
  entrada  numeric,
  salida   numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (fecha AT TIME ZONE 'UTC')::date AS fecha,
    COALESCE(SUM(CASE WHEN tipo = 'ENTRADA' THEN monto ELSE 0 END), 0)::numeric AS entrada,
    COALESCE(SUM(CASE WHEN tipo = 'SALIDA'  THEN monto ELSE 0 END), 0)::numeric AS salida
  FROM public.dropi_wallet_movements
  WHERE fecha >= p_from AND fecha <= p_to
  GROUP BY 1
  ORDER BY 1;
$$;

GRANT EXECUTE ON FUNCTION public.wallet_summary(timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_daily_series(timestamptz, timestamptz) TO authenticated;
