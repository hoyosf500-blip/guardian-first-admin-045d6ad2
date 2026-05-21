-- Multi-tienda SP1a — Migración 1/3: tablas núcleo + helpers RLS.
-- Puramente aditiva. No toca tablas existentes.

-- ── Tabla stores: la unidad de tenencia ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.stores (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  country_code text NOT NULL DEFAULT 'CO' CHECK (country_code ~ '^[A-Z]{2}$'),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_by   uuid REFERENCES auth.users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Tabla store_members: pertenencia + rol por tienda ───────────────
CREATE TABLE IF NOT EXISTS public.store_members (
  store_id   uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','operator')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_store_members_user ON public.store_members(user_id);

-- ── Tabla store_dropi_config: credenciales + país por tienda ────────
CREATE TABLE IF NOT EXISTS public.store_dropi_config (
  store_id             uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  country_code         text NOT NULL DEFAULT 'CO',
  dropi_api_key        text,
  dropi_session_token  text,
  dropi_store_url      text,
  white_brand_id       text,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ── Helpers RLS (SECURITY DEFINER → saltan RLS de store_members,
--    evitando recursión cuando las políticas los invocan) ───────────
CREATE OR REPLACE FUNCTION public.auth_store_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT store_id FROM public.store_members WHERE user_id = auth.uid() $$;

CREATE OR REPLACE FUNCTION public.is_store_member(p_store_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (
  SELECT 1 FROM public.store_members
  WHERE user_id = auth.uid() AND store_id = p_store_id
) $$;

CREATE OR REPLACE FUNCTION public.store_role(p_store_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT role FROM public.store_members
  WHERE user_id = auth.uid() AND store_id = p_store_id $$;

CREATE OR REPLACE FUNCTION public.is_store_owner(p_store_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (
  SELECT 1 FROM public.store_members
  WHERE user_id = auth.uid() AND store_id = p_store_id AND role = 'owner'
) $$;

-- ── RLS de las tablas nuevas ────────────────────────────────────────
ALTER TABLE public.stores             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_dropi_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stores_member_select" ON public.stores;
CREATE POLICY "stores_member_select" ON public.stores
  FOR SELECT TO authenticated
  USING (id IN (SELECT public.auth_store_ids()));

DROP POLICY IF EXISTS "stores_owner_update" ON public.stores;
CREATE POLICY "stores_owner_update" ON public.stores
  FOR UPDATE TO authenticated
  USING (public.is_store_owner(id))
  WITH CHECK (public.is_store_owner(id));

DROP POLICY IF EXISTS "members_select" ON public.store_members;
CREATE POLICY "members_select" ON public.store_members
  FOR SELECT TO authenticated
  USING (store_id IN (SELECT public.auth_store_ids()));

DROP POLICY IF EXISTS "members_owner_manage" ON public.store_members;
CREATE POLICY "members_owner_manage" ON public.store_members
  FOR ALL TO authenticated
  USING (public.is_store_owner(store_id))
  WITH CHECK (public.is_store_owner(store_id));

DROP POLICY IF EXISTS "dropi_config_owner_manage" ON public.store_dropi_config;
CREATE POLICY "dropi_config_owner_manage" ON public.store_dropi_config
  FOR ALL TO authenticated
  USING (public.is_store_owner(store_id))
  WITH CHECK (public.is_store_owner(store_id));
