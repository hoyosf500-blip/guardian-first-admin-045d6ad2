-- A) protect_order_financial_fields: remove ownership check, keep financial protection
CREATE OR REPLACE FUNCTION public.protect_order_financial_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_is_admin BOOLEAN;
BEGIN
  IF current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  v_is_admin := public.has_role(v_uid, 'admin');
  IF v_is_admin THEN
    RETURN NEW;
  END IF;

  IF NEW.valor        IS DISTINCT FROM OLD.valor        THEN RAISE EXCEPTION 'No tienes permiso para modificar el valor del pedido'; END IF;
  IF NEW.flete        IS DISTINCT FROM OLD.flete        THEN RAISE EXCEPTION 'No tienes permiso para modificar el flete'; END IF;
  IF NEW.costo_prod   IS DISTINCT FROM OLD.costo_prod   THEN RAISE EXCEPTION 'No tienes permiso para modificar el costo del producto'; END IF;
  IF NEW.costo_dev    IS DISTINCT FROM OLD.costo_dev    THEN RAISE EXCEPTION 'No tienes permiso para modificar el costo de devolucion'; END IF;
  IF NEW.assigned_to  IS DISTINCT FROM OLD.assigned_to  THEN RAISE EXCEPTION 'No tienes permiso para reasignar pedidos'; END IF;
  IF NEW.external_id  IS DISTINCT FROM OLD.external_id  THEN RAISE EXCEPTION 'No tienes permiso para modificar el ID externo'; END IF;
  IF NEW.created_at   IS DISTINCT FROM OLD.created_at   THEN RAISE EXCEPTION 'No tienes permiso para modificar la fecha de creación'; END IF;

  RETURN NEW;
END;
$$;

-- B) Drop reassign_unattended (no longer relevant with free queue)
DROP FUNCTION IF EXISTS public.reassign_unattended(INT);

-- C) Replace operator_productivity_stats: count by real calls + add tasa_confirmacion
DROP FUNCTION IF EXISTS public.operator_productivity_stats(text);

CREATE OR REPLACE FUNCTION public.operator_productivity_stats(p_range text DEFAULT '24h')
RETURNS TABLE (
  operator_id uuid,
  display_name text,
  confirmados bigint,
  cancelados bigint,
  noresp bigint,
  novedades_resueltas bigint,
  total_atendidos bigint,
  tasa_contacto numeric,
  tasa_confirmacion numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since timestamptz;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores pueden ver estas métricas';
  END IF;

  v_since := CASE p_range
    WHEN '7d'  THEN NOW() - INTERVAL '7 days'
    WHEN '30d' THEN NOW() - INTERVAL '30 days'
    ELSE NOW() - INTERVAL '24 hours'
  END;

  RETURN QUERY
  WITH base AS (
    SELECT
      r.operator_id,
      COUNT(*) FILTER (WHERE r.module = 'confirmar' AND r.result = 'conf')   AS confirmados,
      COUNT(*) FILTER (WHERE r.module = 'confirmar' AND r.result = 'canc')   AS cancelados,
      COUNT(*) FILTER (WHERE r.module = 'confirmar' AND r.result = 'noresp') AS noresp,
      COUNT(*) FILTER (WHERE r.module = 'novedades' AND r.result = 'conf')   AS novedades_resueltas,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.module = 'confirmar')       AS total_atendidos
    FROM public.order_results r
    WHERE r.created_at >= v_since
    GROUP BY r.operator_id
  )
  SELECT
    b.operator_id,
    COALESCE(p.display_name, 'Operador') AS display_name,
    b.confirmados, b.cancelados, b.noresp, b.novedades_resueltas,
    b.total_atendidos,
    CASE WHEN (b.confirmados + b.cancelados + b.noresp) = 0 THEN 0
         ELSE ROUND(((b.confirmados + b.cancelados)::numeric / (b.confirmados + b.cancelados + b.noresp)::numeric) * 100, 1)
    END AS tasa_contacto,
    CASE WHEN (b.confirmados + b.cancelados + b.noresp) = 0 THEN 0
         ELSE ROUND((b.confirmados::numeric / (b.confirmados + b.cancelados + b.noresp)::numeric) * 100, 1)
    END AS tasa_confirmacion
  FROM base b
  LEFT JOIN public.profiles p ON p.user_id = b.operator_id
  ORDER BY b.confirmados DESC, display_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.operator_productivity_stats(text) TO authenticated;