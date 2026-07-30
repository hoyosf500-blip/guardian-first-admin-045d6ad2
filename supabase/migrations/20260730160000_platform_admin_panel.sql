-- ─────────────────────────────────────────────────────────────────────────────
-- Panel de plataforma (/plataforma) — 2026-07-30.
--
-- Guardian pasa de "el CRM de Fabián" a "una plataforma con inquilinos". Esto
-- le da al admin GLOBAL (único, el dueño de la plataforma) la vista de sus
-- tiendas: quién es el dueño, cuánto la usa, si su sincronía está sana, qué
-- versión de la app tiene cargada y en qué anda su suscripción.
--
-- Principios:
--  * TODO admin-only y fail-closed: cada función verifica has_role(admin) y
--    tira excepción si no. Un owner tercero no ve NADA de esto.
--  * El panel muestra AGREGADOS (cuántos pedidos), NUNCA contenido de pedidos
--    ni datos de clientes de otro tenant. El admin administra la plataforma,
--    no los negocios ajenos.
--  * Cobro MANUAL (decisión del dueño): se marca plan + hasta cuándo pagó.
--    Nada de pasarelas todavía.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Suscripción por tienda ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.store_subscriptions (
  store_id     uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  plan         text NOT NULL DEFAULT 'prueba',   -- prueba | pro | cortesia
  paid_until   date,                             -- NULL = sin fecha (cortesía/indefinido)
  notes        text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES auth.users(id)
);

ALTER TABLE public.store_subscriptions ENABLE ROW LEVEL SECURITY;

-- Lectura: el admin global ve todo; el dueño ve SOLO la suya (para el aviso de
-- vencimiento en su propia pantalla). Nadie ve la de otro.
DROP POLICY IF EXISTS subs_sel ON public.store_subscriptions;
CREATE POLICY subs_sel ON public.store_subscriptions
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR store_id IN (SELECT public.auth_store_ids())
  );

-- Escritura: SOLO por las RPC admin de abajo (SECURITY DEFINER). Sin políticas
-- de INSERT/UPDATE/DELETE → el cliente no puede tocar la tabla ni siendo owner.

-- ── Versión de la app que tiene cargada cada usuario ────────────────────────
-- Guardian es UNA app, pero el navegador de cada uno puede quedarse con un
-- bundle viejo hasta que recargue (pestaña abierta días). Esto lo hace visible.
CREATE TABLE IF NOT EXISTS public.user_app_version (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  version     text NOT NULL,
  store_id    uuid REFERENCES public.stores(id) ON DELETE SET NULL,
  seen_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_app_version ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS uav_sel ON public.user_app_version;
CREATE POLICY uav_sel ON public.user_app_version
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR user_id = auth.uid());

-- Cada usuario reporta LO SUYO (upsert vía RPC, no INSERT directo).
CREATE OR REPLACE FUNCTION public.report_app_version(p_version text, p_store_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  INSERT INTO public.user_app_version (user_id, version, store_id, seen_at)
  VALUES (auth.uid(), left(coalesce(p_version, '?'), 40), p_store_id, now())
  ON CONFLICT (user_id) DO UPDATE
    SET version = EXCLUDED.version,
        store_id = COALESCE(EXCLUDED.store_id, public.user_app_version.store_id),
        seen_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.report_app_version(text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.report_app_version(text, uuid) TO authenticated;

-- ── Vista del panel: una fila por tienda ────────────────────────────────────
-- Agregados nada más. Sin PII de clientes de otros tenants.
CREATE OR REPLACE FUNCTION public.platform_stores_overview()
RETURNS TABLE (
  store_id        uuid,
  store_name      text,
  country_code    text,
  status          text,
  created_at      timestamptz,
  owner_name      text,
  owner_email     text,
  members         integer,
  orders_30d      integer,
  last_order_at   timestamptz,
  has_dropi_key   boolean,
  last_sync_at    timestamptz,
  last_sync_ok    boolean,
  wallet_sync_at  timestamptz,
  wallet_sync_ok  boolean,
  app_versions    text,
  plan            text,
  paid_until      date,
  sub_notes       text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo el administrador de la plataforma' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH owner_row AS (
    SELECT DISTINCT ON (sm.store_id) sm.store_id, sm.user_id
    FROM public.store_members sm
    WHERE sm.role = 'owner'
    ORDER BY sm.store_id, sm.created_at
  ),
  ord AS (
    SELECT o.store_id,
           COUNT(*) FILTER (WHERE o.created_at >= now() - interval '30 days')::int AS n30,
           MAX(o.created_at) AS last_at
    FROM public.orders o
    GROUP BY o.store_id
  ),
  sync AS (
    SELECT DISTINCT ON (l.store_id) l.store_id, l.created_at, l.status
    FROM public.sync_logs l
    WHERE l.source IN ('dropi-cron', 'dropi')
    ORDER BY l.store_id, l.created_at DESC
  ),
  wsync AS (
    SELECT DISTINCT ON (l.store_id) l.store_id, l.created_at, l.status
    FROM public.sync_logs l
    WHERE l.source = 'dropi-wallet-sync'
    ORDER BY l.store_id, l.created_at DESC
  ),
  vers AS (
    SELECT v.store_id, string_agg(DISTINCT v.version, ', ' ORDER BY v.version) AS versions
    FROM public.user_app_version v
    WHERE v.seen_at >= now() - interval '7 days'
    GROUP BY v.store_id
  )
  SELECT
    s.id,
    s.name,
    s.country_code,
    s.status,
    s.created_at,
    COALESCE(p.display_name, '—'),
    COALESCE(u.email::text, '—'),
    (SELECT COUNT(*)::int FROM public.store_members m WHERE m.store_id = s.id),
    COALESCE(ord.n30, 0),
    ord.last_at,
    (dc.dropi_api_key IS NOT NULL AND dc.dropi_api_key <> ''),
    sync.created_at,
    (sync.status = 'success'),
    wsync.created_at,
    (wsync.status = 'success'),
    COALESCE(vers.versions, '—'),
    COALESCE(sub.plan, 'prueba'),
    sub.paid_until,
    sub.notes
  FROM public.stores s
  LEFT JOIN owner_row ow ON ow.store_id = s.id
  LEFT JOIN public.profiles p ON p.user_id = ow.user_id
  LEFT JOIN auth.users u ON u.id = ow.user_id
  LEFT JOIN ord ON ord.store_id = s.id
  LEFT JOIN public.store_dropi_config dc ON dc.store_id = s.id
  LEFT JOIN sync ON sync.store_id = s.id
  LEFT JOIN wsync ON wsync.store_id = s.id
  LEFT JOIN vers ON vers.store_id = s.id
  LEFT JOIN public.store_subscriptions sub ON sub.store_id = s.id
  ORDER BY s.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.platform_stores_overview() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.platform_stores_overview() TO authenticated;

-- ── Acciones del panel (admin-only) ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.platform_set_subscription(
  p_store_id uuid,
  p_plan text,
  p_paid_until date DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo el administrador de la plataforma' USING ERRCODE = '42501';
  END IF;
  IF p_plan NOT IN ('prueba', 'pro', 'cortesia') THEN
    RAISE EXCEPTION 'Plan inválido: usá prueba, pro o cortesia';
  END IF;
  INSERT INTO public.store_subscriptions (store_id, plan, paid_until, notes, updated_at, updated_by)
  VALUES (p_store_id, p_plan, p_paid_until, p_notes, now(), auth.uid())
  ON CONFLICT (store_id) DO UPDATE
    SET plan = EXCLUDED.plan,
        paid_until = EXCLUDED.paid_until,
        notes = EXCLUDED.notes,
        updated_at = now(),
        updated_by = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.platform_set_subscription(uuid, text, date, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.platform_set_subscription(uuid, text, date, text) TO authenticated;

-- Suspender / reactivar. NO borra datos: solo cambia stores.status. El dueño
-- suspendido no entra; sus pedidos quedan intactos y vuelve con un clic.
CREATE OR REPLACE FUNCTION public.platform_set_store_status(p_store_id uuid, p_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo el administrador de la plataforma' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'Estado inválido: usá active o suspended';
  END IF;
  UPDATE public.stores SET status = p_status WHERE id = p_store_id;
END;
$$;

REVOKE ALL ON FUNCTION public.platform_set_store_status(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.platform_set_store_status(uuid, text) TO authenticated;
