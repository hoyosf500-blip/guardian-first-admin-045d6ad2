-- HARDENING multi-tenant — hard-stop contra la mezcla CO/EC en las RPCs CRÍTICAS
-- (las que el dueño está mirando ahora: Productividad/Jornada + popup de cancelados).
--
-- Clase de bug (ver auditoría 2026-06-26): las RPCs store-scoped usan
-- `v_store := _resolve_scope_store(); ... WHERE (v_store IS NULL OR store_id=v_store)`.
-- Para un ADMIN GLOBAL con profiles.active_store_id NULL, el resolver devuelve NULL
-- → el filtro se apaga → AGREGA TODAS LAS TIENDAS (mezcla CO+EC). Fix = hard-stop:
-- si no hay tienda concreta, devolver 0 filas (nunca mezclar). Managers no-admin NO
-- tienen el bug (su tienda sale fija de store_members).
--
-- Acá van las 2 CRÍTICAS reproducidas con el guard. El resto de las RPCs afectadas
-- (logistics_*, financial_summary, wallet_*, operator_productivity_stats, etc.) se
-- blindan por separado contra el esquema vivo (prompt a Lovable) para no pisar
-- posibles hotfixes no versionados.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) operator_activity_stats — Jornada por operadora (Productividad). Reproduce
--    20260528210000 + hard-stop. Lista de operadoras: mezclar CO+EC es bug.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.operator_activity_stats(p_range text DEFAULT 'today')
RETURNS TABLE(
  operator_id uuid,
  display_name text,
  first_action_at timestamptz,
  last_active_at timestamptz,
  active_seconds bigint,
  idle_seconds bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_since date;
  v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  -- Hard-stop: sin tienda concreta (admin sin tienda activa / race) → 0 filas,
  -- nunca mezclar operadoras de CO con EC en la misma lista.
  IF v_store IS NULL THEN
    RETURN;
  END IF;

  v_since := CASE p_range
    WHEN 'today' THEN ((NOW() AT TIME ZONE 'America/Bogota')::date)
    WHEN '7d'    THEN (((NOW() AT TIME ZONE 'America/Bogota')::date) - 6)
    WHEN '30d'   THEN (((NOW() AT TIME ZONE 'America/Bogota')::date) - 29)
    ELSE ((NOW() AT TIME ZONE 'America/Bogota')::date)
  END;

  RETURN QUERY
  SELECT
    d.operator_id,
    COALESCE(p.display_name, 'Sin nombre') AS display_name,
    MIN(d.first_action_at) AS first_action_at,
    MAX(d.last_active_at)  AS last_active_at,
    SUM(d.active_seconds)::bigint AS active_seconds,
    SUM(d.idle_seconds)::bigint   AS idle_seconds
  FROM public.operator_activity_daily d
  LEFT JOIN public.profiles p ON p.user_id = d.operator_id
  WHERE d.activity_date >= v_since
    AND d.store_id = v_store
    -- Excluir admins globales: el dashboard "Por operadora" es de operadoras.
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = d.operator_id AND ur.role = 'admin'
    )
  GROUP BY d.operator_id, p.display_name
  ORDER BY MIN(d.first_action_at) ASC;
END $$;

GRANT EXECUTE ON FUNCTION public.operator_activity_stats(text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) admin_cancelled_details — popup de cancelados (Reportes diarios). El cliente
--    manda p_store_id=activeStoreId, pero blindamos server-side por si llega NULL
--    en un race: sin tienda por NINGUNA vía → 0 filas (igual que admin_inactivity_details).
--    Reproduce 20260626130000 + hard-stop. Signatura SIN cambios (no necesita DROP).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_cancelled_details(
  p_operadora text,
  p_fecha date,
  p_store_id uuid DEFAULT NULL
)
RETURNS TABLE(
  external_id text,
  nombre text,
  phone text,
  reason text,
  hora timestamptz,
  module text,
  order_fecha date,
  dias int
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  -- Unificá resolver + param en UNA variable enforced: el admin sin tienda activa
  -- cae al p_store_id que manda el cliente (activeStoreId); owner/supervisor ya
  -- tienen v_store fijo (el p_store_id queda ignorado). Sin tienda por ninguna vía
  -- → 0 filas. Así el WHERE filtra por una sola columna, server-authoritative.
  IF v_store IS NULL THEN v_store := p_store_id; END IF;
  IF v_store IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT
    o.external_id::text,
    o.nombre::text,
    r.phone::text,
    COALESCE(NULLIF(TRIM(r.reason), ''), '(sin motivo)') AS reason,
    r.created_at AS hora,
    COALESCE(r.module, 'confirmar') AS module,
    CASE
      WHEN o.fecha ~ '^\d{4}-\d{2}-\d{2}$' THEN o.fecha::date
      ELSE NULL
    END AS order_fecha,
    -- Antigüedad robusta ante fecha malformada: fecha → orders.dias → created_at → NULL.
    CASE
      WHEN o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
        THEN GREATEST((p_fecha - o.fecha::date), 0)
      WHEN o.dias IS NOT NULL
        THEN GREATEST(o.dias, 0)
      WHEN o.created_at IS NOT NULL
        THEN GREATEST((p_fecha - o.created_at::date), 0)
      ELSE NULL
    END AS dias
  FROM public.order_results r
  JOIN public.profiles p ON p.user_id = r.operator_id
  LEFT JOIN public.orders o ON o.id = r.order_id
  WHERE r.result = 'canc'
    AND r.result_date = p_fecha
    AND p.display_name = p_operadora
    AND r.store_id = v_store
  ORDER BY r.created_at;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_cancelled_details(text, date, uuid) TO authenticated;
