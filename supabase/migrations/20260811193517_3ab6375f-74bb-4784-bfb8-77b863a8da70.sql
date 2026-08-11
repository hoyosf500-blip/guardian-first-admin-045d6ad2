CREATE OR REPLACE FUNCTION public.assign_order_to_operator()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count INT;
  v_slot INT;
  v_user UUID;
BEGIN
  -- Only auto-assign if not already assigned
  IF NEW.assigned_to IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Multi-tienda: el pool DEBE filtrarse por la tienda del pedido. Sin esto un
  -- pedido de la tienda A podia quedar asignado a una asesora de la tienda B.
  IF NEW.store_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO v_count FROM public.operator_pool
   WHERE active AND store_id = NEW.store_id;
  IF v_count = 0 THEN
    RETURN NEW; -- no operators available, leave unassigned
  END IF;

  -- Use external_id for determinism; fall back to id if external_id is null
  v_slot := abs(hashtext(COALESCE(NEW.external_id, NEW.id::text))) % v_count;

  SELECT user_id INTO v_user
  FROM (
    SELECT user_id, ROW_NUMBER() OVER (ORDER BY slot) - 1 AS pos
    FROM public.operator_pool
    WHERE active AND store_id = NEW.store_id
  ) ranked
  WHERE pos = v_slot;

  NEW.assigned_to := v_user;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.pending_tomorrow_count()
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
  v_count INT;
BEGIN
  WITH dedup AS (
    SELECT DISTINCT ON (COALESCE(NULLIF(o.external_id,''), o.phone || '|' || COALESCE(o.producto,'')))
      o.id
    FROM public.orders o
    WHERE UPPER(COALESCE(o.estado,'')) = 'PENDIENTE CONFIRMACION'
      AND o.phone IS NOT NULL AND o.phone <> ''
      -- SECURITY DEFINER: sin este filtro el contador sumaba pedidos de TODAS
      -- las tiendas de la plataforma para cualquier usuario firmado.
      AND o.store_id IN (SELECT public.auth_store_ids())
    ORDER BY COALESCE(NULLIF(o.external_id,''), o.phone || '|' || COALESCE(o.producto,'')), o.created_at DESC
  )
  SELECT COUNT(*) INTO v_count
  FROM dedup d
  WHERE NOT EXISTS (
    SELECT 1 FROM public.order_results r
    WHERE r.order_id = d.id
      AND r.module = 'confirmar'
      AND r.result IN ('conf','canc')
  )
  AND COALESCE((
    SELECT COUNT(*) FROM public.order_results r2
    WHERE r2.order_id = d.id
      AND r2.module = 'confirmar'
      AND r2.result = 'noresp'
      AND r2.result_date = v_today
  ), 0) < 3;
  RETURN COALESCE(v_count, 0);
END; $function$;

REVOKE EXECUTE ON FUNCTION public.dropi_fingerprint(text) FROM authenticated;

DROP POLICY IF EXISTS "Anyone can view profiles" ON public.profiles;
CREATE POLICY "profiles_visible_to_store_peers"
ON public.profiles FOR SELECT TO authenticated
USING (
  user_id = auth.uid()
  OR public.has_role(auth.uid(), 'admin'::app_role)
  OR EXISTS (
    SELECT 1 FROM public.store_members sm
    WHERE sm.user_id = profiles.user_id
      AND sm.store_id IN (SELECT public.auth_store_ids())
  )
);

DROP POLICY IF EXISTS autocomplete_cache_select ON public.address_autocomplete_cache;
DROP POLICY IF EXISTS autocomplete_cache_insert ON public.address_autocomplete_cache;
DROP POLICY IF EXISTS autocomplete_cache_update ON public.address_autocomplete_cache;
REVOKE ALL ON public.address_autocomplete_cache FROM authenticated;