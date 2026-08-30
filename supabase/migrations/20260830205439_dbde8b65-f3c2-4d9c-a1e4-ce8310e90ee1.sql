CREATE OR REPLACE FUNCTION public.operator_today_tasa()
 RETURNS TABLE(confirmados bigint, cancelados bigint, noresp bigint, total bigint, tasa_confirmacion numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
  v_store uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  -- ── ÚNICO CAMBIO respecto a la versión desplegada ──
  IF public.has_role(v_uid, 'admin') THEN
    v_store := public._resolve_scope_store();
  ELSE
    SELECT p.active_store_id INTO v_store
      FROM public.profiles p
     WHERE p.user_id = v_uid
       AND p.active_store_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM public.store_members m
          WHERE m.user_id = v_uid AND m.store_id = p.active_store_id
       );

    IF v_store IS NULL THEN
      SELECT m.store_id INTO v_store
        FROM public.store_members m
       WHERE m.user_id = v_uid
       ORDER BY m.store_id
       LIMIT 1;
    END IF;

    -- Ni miembro de una sola tienda: no hay nada suyo que mostrar.
    IF v_store IS NULL THEN
      RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.result = 'conf')   AS confirmados,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.result = 'canc')   AS cancelados,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.result = 'noresp') AS noresp,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.result IN ('conf','canc','noresp')) AS gestionados
    FROM public.order_results r
    WHERE r.operator_id = v_uid
      AND r.module = 'confirmar'
      AND r.result_date = v_today
      AND (v_store IS NULL OR r.store_id = v_store)
  )
  SELECT
    b.confirmados,
    b.cancelados,
    b.noresp,
    b.gestionados AS total,
    CASE WHEN (b.confirmados + b.cancelados) = 0 THEN 0
         ELSE ROUND((b.confirmados::numeric / (b.confirmados + b.cancelados)::numeric) * 100, 1)
    END AS tasa_confirmacion
  FROM base b;
END;
$function$;