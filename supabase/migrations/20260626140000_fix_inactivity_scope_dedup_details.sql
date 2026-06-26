-- FIX advertencias de inactividad: (1) mezcla CO/EC, (2) filas duplicadas por
-- race, y (3) nuevo RPC de detalle para el popup por aviso.
--
-- SINTOMA: una operadora 74% activa mostraba "2 avisos · 35m" y EXACTAMENTE el
-- mismo "2" aparecía en otra tienda. Dos causas raíz:
--   A) operator_inactivity_stats se volvía GLOBAL cuando _resolve_scope_store()
--      devuelve NULL (admin sin tienda activa fija / race en cold-load): la
--      cláusula (v_store IS NULL OR ...) dejaba pasar TODAS las tiendas.
--   B) record_inactivity_warning hace COUNT(*)+1 SIN constraint UNIQUE → dos
--      acknowledges en race insertan el MISMO warning_number → el reporte cuenta
--      y suma lost_seconds DOBLE (2 filas por aviso → "2 avisos / 35m" cuando lo
--      real era ~1 / ~17m). Idéntico en ambas tiendas porque es el mismo mecanismo.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) DEDUPE filas duplicadas existentes (deja una por operador/tienda/día/número)
--    OBLIGATORIO antes de crear la constraint UNIQUE, si no el ALTER falla.
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM public.operator_inactivity_warnings a
USING public.operator_inactivity_warnings b
WHERE a.operator_id   = b.operator_id
  AND a.store_id      = b.store_id
  AND a.warning_date  = b.warning_date
  AND a.warning_number = b.warning_number
  AND a.ctid > b.ctid;   -- conserva una fila arbitraria, borra el resto

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) UNIQUE constraint: backstop definitivo contra cualquier race del cliente.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.operator_inactivity_warnings
  DROP CONSTRAINT IF EXISTS uq_inactivity_operator_store_date_number;
ALTER TABLE public.operator_inactivity_warnings
  ADD CONSTRAINT uq_inactivity_operator_store_date_number
  UNIQUE (operator_id, store_id, warning_date, warning_number);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) record_inactivity_warning idempotente: ON CONFLICT DO NOTHING. Si dos
--    llamadas en race calculan el mismo warning_number, solo entra una fila.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_inactivity_warning(
  p_store_id uuid,
  p_lost_seconds int
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today  date := ((NOW() AT TIME ZONE 'America/Bogota')::date);
  v_number int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  IF p_lost_seconds < 0 THEN p_lost_seconds := 0; END IF;
  IF p_lost_seconds > 43200 THEN p_lost_seconds := 43200; END IF; -- cap defensivo 12h

  IF NOT EXISTS (
    SELECT 1 FROM public.store_members
    WHERE store_id = p_store_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not a member of store';
  END IF;

  -- Serializa los avisos concurrentes del MISMO (operador, tienda, día) para que
  -- COUNT(*)+1 e INSERT sean atómicos. Sin esto, un doble-tap de "Entendido"
  -- (o doble-mount del guard) deja dos lecturas COUNT=0 → mismo warning_number.
  -- El lock se libera solo al terminar la transacción. El ON CONFLICT de abajo
  -- queda como backstop adicional.
  PERFORM pg_advisory_xact_lock(
    hashtext(auth.uid()::text || ':' || p_store_id::text || ':' || v_today::text)::bigint
  );

  SELECT COALESCE(COUNT(*), 0) + 1 INTO v_number
  FROM public.operator_inactivity_warnings
  WHERE operator_id = auth.uid() AND store_id = p_store_id AND warning_date = v_today;

  INSERT INTO public.operator_inactivity_warnings
    (operator_id, store_id, warning_date, warning_number, lost_seconds)
  VALUES (auth.uid(), p_store_id, v_today, v_number, p_lost_seconds)
  ON CONFLICT (operator_id, store_id, warning_date, warning_number) DO NOTHING;

  RETURN v_number;
END $$;

GRANT EXECUTE ON FUNCTION public.record_inactivity_warning(uuid, int) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) operator_inactivity_stats: HARD-STOP si no hay tienda concreta (nunca
--    mezcla CO+EC) + excluir admins globales (igual que operator_activity_stats).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.operator_inactivity_stats(p_range text DEFAULT 'today')
RETURNS TABLE(
  operator_id uuid,
  display_name text,
  warnings_count bigint,
  total_lost_seconds bigint,
  last_warning_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_since date;
  v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  -- Si el resolver no pudo determinar UNA tienda concreta (admin sin tienda
  -- activa / race), devolver CERO filas en vez de agregar todas las tiendas.
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
    w.operator_id,
    COALESCE(p.display_name, 'Sin nombre') AS display_name,
    COUNT(*)::bigint AS warnings_count,
    COALESCE(SUM(w.lost_seconds), 0)::bigint AS total_lost_seconds,
    MAX(w.created_at) AS last_warning_at
  FROM public.operator_inactivity_warnings w
  LEFT JOIN public.profiles p ON p.user_id = w.operator_id
  WHERE w.warning_date >= v_since
    AND w.store_id = v_store
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = w.operator_id AND ur.role = 'admin'
    )
  GROUP BY w.operator_id, p.display_name
  ORDER BY warnings_count DESC;
END $$;

GRANT EXECUTE ON FUNCTION public.operator_inactivity_stats(text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) admin_inactivity_details: detalle por aviso para el popup que abre la celda
--    "Advert. inact." en Productividad. Store-scoped (dual guard p_store_id +
--    _resolve_scope_store) — CO y EC nunca se mezclan. Match por display_name
--    (mismo patrón que admin_cancelled_details). Acepta el mismo p_range que el
--    agregado para que el popup muestre exactamente esos avisos.
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.admin_inactivity_details(text, text, uuid);

CREATE OR REPLACE FUNCTION public.admin_inactivity_details(
  p_operadora text,
  p_range     text DEFAULT 'today',
  p_store_id  uuid DEFAULT NULL
)
RETURNS TABLE(
  numero       int,
  lost_seconds int,
  warning_date date,
  hora         timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_store uuid;
  v_since date;
BEGIN
  v_store := public._resolve_scope_store();
  -- Sin tienda por NINGUNA vía (ni p_store_id ni resolver) → no devolver nada
  -- (no mezclar tiendas). El cliente siempre manda p_store_id = activeStoreId.
  IF v_store IS NULL AND p_store_id IS NULL THEN
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
    w.warning_number AS numero,
    w.lost_seconds,
    w.warning_date,
    w.created_at AS hora
  FROM public.operator_inactivity_warnings w
  JOIN public.profiles p ON p.user_id = w.operator_id
  WHERE p.display_name = p_operadora
    AND w.warning_date >= v_since
    -- Admin global con tienda activa NULL: solo p_store_id acota (los admins son
    -- globales por diseño, igual que admin_cancelled_details). Owner/supervisor:
    -- v_store = su tienda → un p_store_id ajeno cae por el AND. Operadora pura:
    -- _resolve_scope_store() ya hizo RAISE 42501 y no llega acá.
    AND (p_store_id IS NULL OR w.store_id = p_store_id)
    AND (v_store    IS NULL OR w.store_id = v_store)
    -- Excluir admins globales del detalle (espeja operator_inactivity_stats).
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = w.operator_id AND ur.role = 'admin'
    )
  ORDER BY w.warning_date, w.warning_number;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_inactivity_details(text, text, uuid) TO authenticated;
