-- Los KPIs de la Billetera no respondían a los filtros de Tipo ni de Categoría.
--
-- Medido en producción el 4-sep-2026 sobre agosto de Ecuador: con "Tipo:
-- Salida" puesto, la tabla mostraba 276 movimientos y las tarjetas de arriba
-- seguían diciendo $12.607,01 de entradas, $4.956,84 de salidas y 943
-- movimientos — los del rango entero. Peor: el KPI "Movimientos" decía 943
-- tres centímetros encima de una línea que decía "276 movimientos". La misma
-- pantalla dando dos respuestas al mismo número.
--
-- La causa NO está en la función desplegada: está en el cliente.
-- `useWalletMovements` aplica los dos filtros a la consulta de la TABLA y
-- después llama a `wallet_summary(p_from, p_to)` SIN ellos. La función ni
-- siquiera los acepta — probada con `p_tipo` devuelve PGRST202.
--
-- ⛔ REGLA #1: `wallet_summary` NO se toca. Esta es una función NUEVA. El
-- bloque de scope está copiado PALABRA POR PALABRA del `pg_get_functiondef` de
-- la desplegada (leído el 4-sep-2026), no del repo: mismo `_resolve_scope_store()`,
-- mismo SECURITY DEFINER, mismo fail-closed cuando la tienda no se resuelve
-- (migración 20260721120000_scope_admin_fail_closed). Así el permiso de quien
-- puede ver la plata es EXACTAMENTE el de hoy: esta función no abre nada nuevo.
--
-- ⛔ REGLA #0: cero DDL sobre tablas calientes. Esto solo crea una función.

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.wallet_summary_filtrado(
  p_from      timestamptz,
  p_to        timestamptz,
  p_tipo      text DEFAULT NULL,
  p_categoria text DEFAULT NULL
)
RETURNS TABLE (
  total_entradas numeric,
  total_salidas  numeric,
  count_total    bigint,
  ultimo_saldo   numeric,
  categorias     text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  -- Idéntico a wallet_summary. Si no hay tienda resuelta se devuelve VACÍO, no
  -- "todas las tiendas": mezclar países está prohibido en esta operación.
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH base AS (
    -- SIN los filtros. De acá salen dos cosas que NO se pueden recortar:
    --
    --  · `categorias` es la lista del desplegable. Si se filtrara, al elegir
    --    "retiro" el desplegable se quedaría con "retiro" como única opción y
    --    no habría forma de volver a "Todas" — la pantalla se cerraría sola.
    --  · `ultimo_saldo` es un hecho del momento, no una suma. El saldo de la
    --    billetera no cambia porque el dueño esté mirando solo las salidas.
    SELECT m.tipo, m.monto, m.categoria, m.saldo_despues, m.fecha
    FROM public.dropi_wallet_movements m
    WHERE m.fecha >= p_from AND m.fecha <= p_to
      AND m.store_id = v_store
  ),
  filtrado AS (
    -- CON los filtros. De acá salen las tres cifras que la pantalla mostraba
    -- mintiendo. 'ALL' se acepta además de NULL porque es el valor literal que
    -- manda el desplegable cuando no hay filtro puesto.
    SELECT b.tipo, b.monto
    FROM base b
    WHERE (p_tipo      IS NULL OR p_tipo      = 'ALL' OR b.tipo      = p_tipo)
      AND (p_categoria IS NULL OR p_categoria = 'ALL' OR b.categoria = p_categoria)
  ),
  ult AS (
    SELECT b.saldo_despues
    FROM base b
    WHERE b.saldo_despues IS NOT NULL
    ORDER BY b.fecha DESC
    LIMIT 1
  ),
  cats AS (
    -- El '{}' va casteado: acá el CTE está solo y Postgres no tiene de dónde
    -- deducir el tipo del array vacío (en wallet_summary lo deducía del
    -- RETURNS TABLE porque estaba en el SELECT final).
    SELECT COALESCE(
             ARRAY_AGG(DISTINCT b.categoria) FILTER (WHERE b.categoria IS NOT NULL),
             '{}'::text[]
           ) AS lista
    FROM base b
  )
  SELECT
    COALESCE(SUM(CASE WHEN f.tipo = 'ENTRADA' THEN f.monto ELSE 0 END), 0)::numeric,
    COALESCE(SUM(CASE WHEN f.tipo = 'SALIDA'  THEN f.monto ELSE 0 END), 0)::numeric,
    COUNT(*)::bigint,
    (SELECT u.saldo_despues FROM ult u),
    (SELECT c.lista FROM cats c)
  FROM filtrado f;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.wallet_summary_filtrado(timestamptz, timestamptz, text, text)
  TO authenticated;

COMMENT ON FUNCTION public.wallet_summary_filtrado(timestamptz, timestamptz, text, text) IS
  'Agregados de la billetera respetando los filtros de Tipo y Categoría de la pantalla. Las sumas y el conteo se filtran; el saldo y la lista de categorías NO (el saldo es un hecho del momento y la lista es el desplegable, que se cerraría sobre sí mismo). Hermana de wallet_summary, que se deja intacta: mismo scope, mismo permiso.';
