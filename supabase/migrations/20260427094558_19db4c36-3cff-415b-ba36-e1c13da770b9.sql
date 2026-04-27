-- Tanda 7 — consolidated audit fixes (CRIT-1/2/3, HIGH-3, HIGH-4)
-- Idempotent. Replaces broken state from tandas 4/5/6 that didn't fully apply.

-- ─── CRIT-1: cron_anon_key slot (sin columna `description` que no existe)
INSERT INTO public.app_settings (key, value)
SELECT 'cron_anon_key', ''
WHERE NOT EXISTS (
  SELECT 1 FROM public.app_settings WHERE key = 'cron_anon_key'
);

-- ─── CRIT-2: cancel_orphan_pending_orders con whitelist explícita
-- de estados que indican que Dropi REEMPLAZÓ el pendiente con sync,
-- NO compras repetidas legítimas ni estados terminales.
CREATE OR REPLACE FUNCTION public.cancel_orphan_pending_orders()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  UPDATE public.orders viejo
  SET estado = 'CANCELADO'
  WHERE viejo.estado = 'PENDIENTE CONFIRMACION'
    AND viejo.created_at > NOW() - INTERVAL '7 days'
    AND EXISTS (
      SELECT 1 FROM public.orders nuevo
      WHERE nuevo.phone = viejo.phone
        AND nuevo.producto = viejo.producto
        AND nuevo.id != viejo.id
        AND nuevo.estado IN (
          'PENDIENTE', 'GUIA GENERADA', 'GUIA_GENERADA',
          'EN PROCESAMIENTO', 'EN BODEGA DROPI'
        )
        AND nuevo.created_at > viejo.created_at
        AND nuevo.created_at < viejo.created_at + INTERVAL '48 hours'
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.cancel_orphan_pending_orders() TO authenticated, service_role;

-- ─── CRIT-3: idx_orders_assigned_to partial idempotente
DROP INDEX IF EXISTS public.idx_orders_assigned_to;
CREATE INDEX IF NOT EXISTS idx_orders_assigned_to
  ON public.orders (assigned_to)
  WHERE assigned_to IS NOT NULL;

-- ─── HIGH-3: protect_fecha_conf_freeze con SECURITY DEFINER + search_path
CREATE OR REPLACE FUNCTION public.protect_fecha_conf_freeze()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.fecha_conf IS NOT NULL
     AND OLD.fecha_conf <> ''
     AND NOT public.has_role(auth.uid(), 'admin') THEN
    NEW.fecha_conf := OLD.fecha_conf;
    IF OLD.fecha_conf ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      NEW.dias_conf := GREATEST(0, (CURRENT_DATE - OLD.fecha_conf::date));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ─── REG-3: confirm_order_locally (en caso de que tanda5 no se aplicara)
CREATE OR REPLACE FUNCTION public.confirm_order_locally(p_order_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operator')) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  UPDATE public.orders
    SET estado = 'PENDIENTE'
    WHERE id = p_order_id AND estado = 'PENDIENTE CONFIRMACION';
  RETURN FOUND;
END;
$$;
GRANT EXECUTE ON FUNCTION public.confirm_order_locally(UUID) TO authenticated;

-- ─── HIGH-4: backfill rol 'operator' a usuarios sin rol
INSERT INTO public.user_roles (user_id, role)
SELECT u.id, 'operator'::public.app_role
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_roles ur WHERE ur.user_id = u.id
)
ON CONFLICT DO NOTHING;