-- 1. Index on assigned_to
CREATE INDEX IF NOT EXISTS idx_orders_assigned_to ON public.orders(assigned_to) WHERE assigned_to IS NOT NULL;

-- 2. operator_pool table
CREATE TABLE IF NOT EXISTS public.operator_pool (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  active BOOLEAN NOT NULL DEFAULT true,
  slot INT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.operator_pool ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage operator_pool"
  ON public.operator_pool
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Authenticated can view operator_pool"
  ON public.operator_pool
  FOR SELECT
  TO authenticated
  USING (true);

-- 3. Auto-populate from user_roles where role='operator'
INSERT INTO public.operator_pool (user_id, slot, active)
SELECT
  ur.user_id,
  (ROW_NUMBER() OVER (ORDER BY p.created_at NULLS LAST, ur.user_id) - 1)::int AS slot,
  true
FROM public.user_roles ur
LEFT JOIN public.profiles p ON p.user_id = ur.user_id
WHERE ur.role = 'operator'
ON CONFLICT (user_id) DO NOTHING;

-- 4. Trigger for deterministic assignment on INSERT
CREATE OR REPLACE FUNCTION public.assign_order_to_operator()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
  v_slot INT;
  v_user UUID;
BEGIN
  -- Only auto-assign if not already assigned
  IF NEW.assigned_to IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO v_count FROM public.operator_pool WHERE active;
  IF v_count = 0 THEN
    RETURN NEW; -- no operators available, leave unassigned
  END IF;

  -- Use external_id for determinism; fall back to id if external_id is null
  v_slot := abs(hashtext(COALESCE(NEW.external_id, NEW.id::text))) % v_count;

  SELECT user_id INTO v_user
  FROM (
    SELECT user_id, ROW_NUMBER() OVER (ORDER BY slot) - 1 AS pos
    FROM public.operator_pool
    WHERE active
  ) ranked
  WHERE pos = v_slot;

  NEW.assigned_to := v_user;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_order_to_operator ON public.orders;
CREATE TRIGGER trg_assign_order_to_operator
  BEFORE INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_order_to_operator();

-- 5. Backfill existing orders (exclude terminal states)
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.operator_pool WHERE active;
  IF v_count > 0 THEN
    UPDATE public.orders o
    SET assigned_to = (
      SELECT user_id FROM (
        SELECT user_id, ROW_NUMBER() OVER (ORDER BY slot) - 1 AS pos
        FROM public.operator_pool WHERE active
      ) r
      WHERE pos = abs(hashtext(COALESCE(o.external_id, o.id::text))) % v_count
    )
    WHERE o.assigned_to IS NULL
      AND COALESCE(UPPER(o.estado), '') NOT IN ('CONFIRMADO', 'CANCELADO', 'ENTREGADO', 'DEVUELTO');
  END IF;
END $$;

-- 6. RPC reassign_unattended (admin only)
CREATE OR REPLACE FUNCTION public.reassign_unattended(p_after_minutes INT DEFAULT 120)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT := 0;
  v_pool_count INT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores pueden reasignar pedidos';
  END IF;

  SELECT COUNT(*) INTO v_pool_count FROM public.operator_pool WHERE active;
  IF v_pool_count < 2 THEN
    RETURN 0; -- need at least 2 operators to swap
  END IF;

  WITH unattended AS (
    SELECT o.id, o.assigned_to
    FROM public.orders o
    WHERE o.assigned_to IS NOT NULL
      AND UPPER(COALESCE(o.estado, '')) = 'PENDIENTE CONFIRMACION'
      AND o.created_at < NOW() - (p_after_minutes || ' minutes')::interval
      AND NOT EXISTS (
        SELECT 1 FROM public.order_results r
        WHERE r.order_id = o.id
          AND r.created_at > NOW() - (p_after_minutes || ' minutes')::interval
      )
  ),
  swapped AS (
    UPDATE public.orders o
    SET assigned_to = (
      SELECT user_id FROM public.operator_pool
      WHERE active AND user_id <> o.assigned_to
      ORDER BY slot
      LIMIT 1
    ),
    locked_by = NULL,
    locked_at = NULL
    FROM unattended u
    WHERE o.id = u.id
    RETURNING o.id
  )
  SELECT COUNT(*) INTO v_count FROM swapped;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reassign_unattended(INT) TO authenticated;