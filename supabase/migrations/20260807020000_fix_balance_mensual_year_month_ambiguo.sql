-- Arregla balance_mensual: `column reference "year_month" is ambiguous` (42702).
--
-- La función declara `RETURNS TABLE(year_month TEXT, ...)`, así que `year_month` es
-- una variable de salida dentro del cuerpo PL/pgSQL. El CTE `costos` la referenciaba
-- SIN CALIFICAR:
--
--     SELECT year_month AS ym FROM public.logistica_monthly_costs
--
-- y `logistica_monthly_costs` también tiene una columna `year_month` → Postgres no
-- puede decidir cuál es y aborta la función entera. La pestaña /logistica → Balance
-- nunca funcionó, en NINGUNA de las dos tiendas, desde que se creó (2026-08-06).
--
-- El arreglo es una calificación: alias `lmc` en el FROM y `lmc.year_month` en el
-- SELECT. Ninguna otra referencia del cuerpo colisiona — los demás CTE ya califican
-- (`r.fecha`, `o.fecha`, `i.monto`) o usan columnas sin homónimo entre los parámetros
-- de salida (`spend_date`, `amount`, `costos_admin`, `pauta_meta`, `pauta_tiktok`).
-- Los alias de salida (`AS pauta`, `AS admin`, `AS retirado`) NO generan ambigüedad:
-- solo la generan los identificadores desnudos dentro de una expresión.
--
-- ⛔ REGLA #1: este cuerpo NO se copió del repo. Se partió del `pg_get_functiondef`
-- de la función que está corriendo en producción (leído 2026-08-07), y el único
-- cambio respecto de esa versión viva son las tres calificaciones `lmc.` del CTE
-- `costos`. Verificado: la versión desplegada era idéntica a la del repo.

CREATE OR REPLACE FUNCTION public.balance_mensual(p_store_id uuid, p_desde text, p_hasta text)
 RETURNS TABLE(year_month text, operativo numeric, pauta numeric, admin numeric, retirado numeric, rendido numeric, pedidos bigint, entregados bigint, devueltos bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'Sin permiso sobre esta tienda' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH meses AS (
    SELECT to_char(d, 'YYYY-MM') AS ym,
           d::date               AS mes_ini,
           (d + INTERVAL '1 month - 1 day')::date AS mes_fin
    FROM generate_series(
      to_date(p_desde || '-01', 'YYYY-MM-DD'),
      to_date(p_hasta || '-01', 'YYYY-MM-DD'),
      INTERVAL '1 month'
    ) AS d
  ),
  ads AS (
    SELECT to_char(spend_date, 'YYYY-MM') AS ym, SUM(amount) AS pauta
    FROM public.store_ad_spend_daily
    WHERE store_id = p_store_id
    GROUP BY 1
  ),
  costos AS (
    -- `lmc.` es EL arreglo: sin el alias, `year_month` choca con el parámetro OUT.
    SELECT lmc.year_month AS ym,
           SUM(lmc.costos_admin) AS admin,
           SUM(COALESCE(lmc.pauta_meta, 0) + COALESCE(lmc.pauta_tiktok, 0)) AS pauta_mensual
    FROM public.logistica_monthly_costs lmc
    WHERE lmc.store_id = p_store_id
    GROUP BY 1
  ),
  retiros AS (
    SELECT to_char(fecha, 'YYYY-MM') AS ym, SUM(monto) AS retirado
    FROM public.dropi_wallet_movements
    WHERE store_id = p_store_id AND categoria = 'retiro'
    GROUP BY 1
  ),
  rend AS (
    SELECT to_char(r.fecha, 'YYYY-MM') AS ym, SUM(i.monto) AS rendido
    FROM public.store_rendiciones r
    JOIN public.store_rendicion_items i ON i.rendicion_id = r.id
    WHERE r.store_id = p_store_id
    GROUP BY 1
  ),
  pedidos_mes AS (
    SELECT to_char(o.fecha::date, 'YYYY-MM') AS ym,
           COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) <> 'cancelado') AS pedidos,
           COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'entregado')  AS entregados,
           COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'devuelto')   AS devueltos
    FROM public.orders o
    WHERE o.store_id = p_store_id
      AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND public._estado_bucket(o.estado) <> 'borrado'
    GROUP BY 1
  )
  SELECT m.ym,
         COALESCE(oc.operativo, 0),
         CASE WHEN COALESCE(ads.pauta, 0) > 0
              THEN ads.pauta
              ELSE COALESCE(costos.pauta_mensual, 0) END,
         COALESCE(costos.admin, 0),
         COALESCE(retiros.retirado, 0),
         COALESCE(rend.rendido, 0),
         COALESCE(pedidos_mes.pedidos, 0),
         COALESCE(pedidos_mes.entregados, 0),
         COALESCE(pedidos_mes.devueltos, 0)
  FROM meses m
  LEFT JOIN LATERAL (
    SELECT * FROM public.operativo_mes_cohorte(p_store_id, m.ym)
  ) oc ON TRUE
  LEFT JOIN ads         ON ads.ym = m.ym
  LEFT JOIN costos      ON costos.ym = m.ym
  LEFT JOIN retiros     ON retiros.ym = m.ym
  LEFT JOIN rend        ON rend.ym = m.ym
  LEFT JOIN pedidos_mes ON pedidos_mes.ym = m.ym
  ORDER BY m.ym;
END;
$function$;
