-- Roles por tienda (owner/supervisor/operator) + sistema de invitaciones.
--
-- IMPORTANTE: la tabla store_invites y sus funciones NUNCA se aplicaron al DB
-- real (la migración 20260521120000 quedó solo en el repo). Por eso esta
-- migración es AUTOCONTENIDA e idempotente: crea todo desde cero si falta.
-- Helpers existentes que reusa: is_store_owner, is_store_member (ya en el DB).
--
-- Roles:
--   owner       → todo lo de su tienda + invita/asigna roles.
--   supervisor  → Admin (incl. claves) + Logística de su tienda. NO invita. NO CFO.
--   operator    → solo Dashboard/Confirmar/Seguimiento/Novedades.

-- ─────────────────────── 1. Tabla de invitaciones ───────────────────────
CREATE TABLE IF NOT EXISTS public.store_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'operator',
  token       text NOT NULL UNIQUE,
  email       text,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '7 days',
  used_at     timestamptz,
  used_by     uuid
);
CREATE INDEX IF NOT EXISTS idx_store_invites_store ON public.store_invites(store_id);
ALTER TABLE public.store_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owners manage own store invites" ON public.store_invites;
CREATE POLICY "owners manage own store invites" ON public.store_invites
  FOR ALL TO authenticated
  USING (public.is_store_owner(store_id))
  WITH CHECK (public.is_store_owner(store_id));

-- ─────────────────── 2. CHECK de role: permitir supervisor ───────────────────
-- store_members ya existe (con filas owner/operator). store_invites recién creada.
-- El nombre del constraint no es confiable → lo buscamos y reemplazamos.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid='public.store_members'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP EXECUTE format('ALTER TABLE public.store_members DROP CONSTRAINT %I', c); END LOOP;
  ALTER TABLE public.store_members
    ADD CONSTRAINT store_members_role_check CHECK (role IN ('owner','supervisor','operator'));
END $$;

DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid='public.store_invites'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP EXECUTE format('ALTER TABLE public.store_invites DROP CONSTRAINT %I', c); END LOOP;
  ALTER TABLE public.store_invites
    ADD CONSTRAINT store_invites_role_check CHECK (role IN ('owner','supervisor','operator'));
END $$;

-- ─────────────────── 3. Helper is_store_manager (owner o supervisor) ───────────────────
CREATE OR REPLACE FUNCTION public.is_store_manager(p_store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.store_members
    WHERE store_id = p_store_id AND user_id = auth.uid() AND role IN ('owner','supervisor')
  );
$$;
REVOKE ALL ON FUNCTION public.is_store_manager(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.is_store_manager(uuid) TO authenticated;

-- ─────────────────── 4. Invitaciones (crear / preview / redimir) ───────────────────
CREATE OR REPLACE FUNCTION public.create_store_invite(
  p_store_id uuid, p_role text DEFAULT 'operator', p_email text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_token text;
BEGIN
  IF NOT public.is_store_owner(p_store_id) THEN
    RAISE EXCEPTION 'Solo el dueño de la tienda puede invitar' USING ERRCODE='42501';
  END IF;
  IF p_role NOT IN ('owner','supervisor','operator') THEN
    RAISE EXCEPTION 'Rol inválido: %', p_role;
  END IF;
  v_token := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
  INSERT INTO public.store_invites (store_id, role, token, email, created_by)
  VALUES (p_store_id, p_role, v_token, NULLIF(lower(trim(p_email)),''), auth.uid());
  RETURN v_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_store_invite(p_token text)
RETURNS TABLE(store_name text, country_code text, role text, valid boolean, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  SELECT i.role AS irole, i.used_at, i.expires_at, s.name AS sname, s.country_code AS scc
    INTO r FROM public.store_invites i JOIN public.stores s ON s.id = i.store_id
   WHERE i.token = p_token;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::text, NULL::text, NULL::text, false, 'no_existe'; RETURN; END IF;
  IF r.used_at IS NOT NULL THEN RETURN QUERY SELECT r.sname, r.scc, r.irole, false, 'usada'; RETURN; END IF;
  IF r.expires_at < now() THEN RETURN QUERY SELECT r.sname, r.scc, r.irole, false, 'expirada'; RETURN; END IF;
  RETURN QUERY SELECT r.sname, r.scc, r.irole, true, 'ok';
END;
$$;

-- redeem: SIN ON CONFLICT (store_members tiene filas duplicadas, no hay UNIQUE).
CREATE OR REPLACE FUNCTION public.redeem_store_invite(p_token text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_uid uuid := auth.uid(); v_email text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.store_invites WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invitación inválida'; END IF;
  IF r.used_at IS NOT NULL THEN RAISE EXCEPTION 'Esta invitación ya fue usada'; END IF;
  IF r.expires_at < now() THEN RAISE EXCEPTION 'Esta invitación expiró'; END IF;
  IF r.email IS NOT NULL THEN
    SELECT lower(email) INTO v_email FROM auth.users WHERE id = v_uid;
    IF v_email IS DISTINCT FROM r.email THEN RAISE EXCEPTION 'Esta invitación es para otro correo'; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.store_members WHERE store_id = r.store_id AND user_id = v_uid) THEN
    INSERT INTO public.store_members (store_id, user_id, role) VALUES (r.store_id, v_uid, r.role);
  END IF;
  UPDATE public.store_invites SET used_at = now(), used_by = v_uid WHERE id = r.id;
  RETURN r.store_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_store_invite(uuid, text, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.create_store_invite(uuid, text, text) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_store_invite(text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_store_invite(text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.redeem_store_invite(text) TO authenticated;
