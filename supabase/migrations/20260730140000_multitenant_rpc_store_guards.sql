-- ─────────────────────────────────────────────────────────────────────────────
-- Cierre de fugas cross-tienda en RPCs (2026-07-30) — PRE-REQUISITO para abrir
-- Guardian a terceros.
--
-- Auditoría de aislamiento multi-tenant (5 auditores). Los cuerpos de acá NO
-- salen del repo: se copiaron del `pg_get_functiondef` de la BASE DESPLEGADA
-- (regla #1 de CLAUDE.md) y solo se les AGREGA el guard de tienda. Todo lo demás
-- —gates de rol, locks de 15 min, ON CONFLICT, IS DISTINCT FROM— queda idéntico.
--
-- Qué estaba abierto (verificado en la definición desplegada):
--   1. upsert_orders_from_dropi: SECURITY DEFINER, SIN ningún gate de auth, y
--      `store_id = COALESCE(EXCLUDED.store_id, orders.store_id)` en el ON
--      CONFLICT (external_id). Un usuario logueado podía MOVER a su tienda el
--      pedido de otro tenant enumerando external_id (7-8 dígitos secuenciales)
--      y después leerlo legítimamente. No se llama desde el cliente (solo
--      dropi-cron / dropi-sync / dropi-nightly-reconcile, todas con service
--      role) → se revoca a authenticated en vez de tocar el cuerpo.
--   2. claim_order: lockeaba POR TELÉFONO en TODAS las tiendas y hacía
--      RETURNING * (filas completas, saltándose RLS). Con un cliente COD que le
--      compró a dos tiendas de la plataforma, la asesora de A veía el pedido de
--      B y se lo congelaba 15 min. Pasaba en uso NORMAL, sin mala intención.
--   3. claim_seg_order: SIN gate alguno — cualquiera se auto-asignaba un pedido
--      ajeno y, vía la policy `assigned_to = auth.uid()`, ganaba UPDATE sobre él.
--   4/5. confirm_order_locally / cancel_order_locally: gate por rol GLOBAL
--      ('operator', que hoy recibe todo usuario nuevo) sin mirar la tienda →
--      sabotaje cruzado (cancelar/confirmar pedidos de otro tenant).
--
-- Criterio: FAIL-CLOSED por membresía. El admin de plataforma no recibe bypass
-- (es miembro de sus propias tiendas; para operar otra, que se agregue como
-- miembro). Mismo criterio que 20260721120000_scope_admin_fail_closed.sql.
-- ─────────────────────────────────────────────────────────────────────────────

-- Helper NUEVO (no reemplaza nada desplegado): ¿el usuario actual es miembro?
CREATE OR REPLACE FUNCTION public.is_store_member(p_store_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_store_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.store_members sm
    WHERE sm.store_id = p_store_id
      AND sm.user_id = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.is_store_member(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_store_member(uuid) TO authenticated, service_role;

-- ── 1. upsert_orders_from_dropi: fuera del alcance del cliente ───────────────
-- Cuerpo intacto. Solo deja de ser invocable con un JWT de usuario.
REVOKE ALL ON FUNCTION public.upsert_orders_from_dropi(jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_orders_from_dropi(jsonb) TO service_role;

-- ── 2. claim_order: el lock por teléfono NO cruza tiendas ────────────────────
CREATE OR REPLACE FUNCTION public.claim_order(p_order_id uuid)
 RETURNS SETOF orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_phone TEXT;
  v_store uuid;
BEGIN
  IF NOT public.has_role(auth.uid(), 'operator') AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'No tienes permiso para reclamar pedidos';
  END IF;
  SELECT phone, store_id INTO v_phone, v_store FROM public.orders WHERE id = p_order_id;
  IF v_phone IS NULL OR v_phone = '' THEN RETURN; END IF;
  -- NUEVO: el pedido tiene que ser de una tienda del usuario.
  IF NOT public.is_store_member(v_store) THEN
    RAISE EXCEPTION 'No autorizado: ese pedido no es de tu tienda' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  UPDATE public.orders
  SET locked_by = auth.uid(), locked_at = NOW()
  WHERE phone = v_phone AND estado = 'PENDIENTE CONFIRMACION'
    AND store_id = v_store  -- NUEVO: nunca tocar el pedido de otra tienda
    AND (locked_by IS NULL OR locked_by = auth.uid() OR locked_at < NOW() - INTERVAL '15 minutes')
    AND NOT EXISTS (
      SELECT 1 FROM public.orders o2
      WHERE o2.phone = v_phone AND o2.estado = 'PENDIENTE CONFIRMACION'
        AND o2.store_id = v_store  -- NUEVO
        AND o2.locked_by IS NOT NULL AND o2.locked_by != auth.uid()
        AND o2.locked_at >= NOW() - INTERVAL '15 minutes'
    )
  RETURNING *;
END;
$function$;

-- ── 3. claim_seg_order: solo pedidos de mis tiendas ─────────────────────────
CREATE OR REPLACE FUNCTION public.claim_seg_order(p_order_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated INT;
BEGIN
  UPDATE public.orders o
  SET assigned_to = auth.uid()
  WHERE o.id = p_order_id
    AND (o.assigned_to IS NULL OR o.assigned_to = auth.uid())
    AND public.is_store_member(o.store_id);  -- NUEVO
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$function$;

-- ── 4. confirm_order_locally ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.confirm_order_locally(p_order_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operator')) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  UPDATE public.orders o
    SET estado = 'PENDIENTE'
    WHERE o.id = p_order_id AND o.estado = 'PENDIENTE CONFIRMACION'
      AND public.is_store_member(o.store_id);  -- NUEVO
  RETURN FOUND;
END;
$function$;

-- ── 5. cancel_order_locally ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_order_locally(p_order_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operator')) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  UPDATE public.orders o SET estado = 'CANCELADO'
    WHERE o.id = p_order_id AND o.estado = 'PENDIENTE CONFIRMACION'
      AND public.is_store_member(o.store_id);  -- NUEVO
  RETURN FOUND;
END;
$function$;
