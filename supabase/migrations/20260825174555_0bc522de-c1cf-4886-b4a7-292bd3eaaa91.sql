DROP FUNCTION IF EXISTS public.novedades_root_cause(date, date);

CREATE OR REPLACE FUNCTION public.novedades_root_cause(p_from date, p_to date)
 RETURNS TABLE(order_id uuid, novedad text, validation_decision text, address_kind text, validacion_al_despachar text, address_kind_al_despachar text, valor numeric, transportadora text, ciudad text, confirmer_id uuid, confirmer_name text, tiene_novedad boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT
    o.id,
    o.novedad,
    o.validation_decision,
    o.address_kind,
    o.validacion_al_despachar,
    o.address_kind_al_despachar,
    o.valor,
    o.transportadora,
    o.ciudad,
    conf.operator_id,
    p.display_name,
    (o.novedad IS NOT NULL AND btrim(o.novedad) <> '')
  FROM public.orders o
  LEFT JOIN LATERAL (
    SELECT r.operator_id
    FROM public.order_results r
    WHERE r.order_id = o.id
      AND r.module = 'confirmar'
      AND r.result = 'conf'
      AND (v_store IS NULL OR r.store_id = v_store)
    ORDER BY r.created_at DESC
    LIMIT 1
  ) conf ON true
  LEFT JOIN public.profiles p ON p.user_id = conf.operator_id
  WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND o.fecha::date BETWEEN p_from AND p_to
    AND (v_store IS NULL OR o.store_id = v_store)
    AND (
      o.estado ILIKE '%DEVUELT%'
      OR o.estado ILIKE '%RECHAZ%'
      OR o.estado ILIKE '%DEVOLUC%'
    )
  ORDER BY o.valor DESC NULLS LAST
  LIMIT 5000;
END;
$function$
