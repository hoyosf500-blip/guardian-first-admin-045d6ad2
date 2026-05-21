-- Multi-tienda SP3 — Invitaciones por tienda (onboarding self-service seguro).
--
-- Problema: agregar operadoras requería SQL manual (INSERT en store_members).
-- Un selector libre de tienda en el registro sería una fuga (cualquiera se
-- metería a cualquier tienda). Solución: links de invitación atados a UNA
-- tienda + rol, generados por el dueño. La invitada se registra por el link y
-- queda como miembro SOLO de esa tienda (no puede cambiarse: el selector solo
-- lista sus membresías y la RLS bloquea el resto).
--
-- Flujo:
--   1. Dueño llama create_store_invite(store_id, role) → token.
--   2. Front arma el link `${origin}/auth?invite=<token>` y se lo manda.
--   3. La invitada abre el link → get_store_invite(token) muestra "Te unís a X".
--   4. Se registra → ya con sesión, redeem_store_invite(token) la mete en
--      store_members y marca el link como usado (un solo uso, vence en 7 días).

CREATE TABLE IF NOT EXISTS public.store_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'operator' CHECK (role IN ('owner','operator')),
  token       text NOT NULL UNIQUE,
  email       text,                       -- opcional: si se setea, solo ese email puede redimir
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '7 days',
  used_at     timestamptz,
  used_by     uuid
);

CREATE INDEX IF NOT EXISTS idx_store_invites_store ON public.store_invites(store_id);

ALTER TABLE public.store_invites ENABLE ROW LEVEL SECURITY;

-- Solo el dueño de la tienda ve/gestiona sus invitaciones. La redención va por
-- RPC SECURITY DEFINER (la invitada todavía no es miembro → no puede leer la
-- tabla bajo RLS).
DROP POLICY IF EXISTS "owners manage own store invites" ON public.store_invites;
CREATE POLICY "owners manage own store invites" ON public.store_invites
  FOR ALL TO authenticated
  USING (public.is_store_owner(store_id))
  WITH CHECK (public.is_store_owner(store_id));

-- 1. Crear invitación (solo dueño). Devuelve el token.
CREATE OR REPLACE FUNCTION public.create_store_invite(
  p_store_id uuid,
  p_role     text DEFAULT 'operator',
  p_email    text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_token text;
BEGIN
  IF NOT public.is_store_owner(p_store_id) THEN
    RAISE EXCEPTION 'Solo el dueño de la tienda puede invitar' USING ERRCODE = '42501';
  END IF;
  IF p_role NOT IN ('owner','operator') THEN
    RAISE EXCEPTION 'Rol inválido: %', p_role;
  END IF;
  -- Token de 64 hex chars (dos uuids sin guiones). gen_random_uuid es nativo.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO public.store_invites (store_id, role, token, email, created_by)
  VALUES (p_store_id, p_role, v_token, NULLIF(lower(trim(p_email)), ''), auth.uid());
  RETURN v_token;
END;
$$;

-- 2. Preview del invite (callable por anon, antes de loguearse). Solo expone
--    nombre de tienda + validez; el token es el secreto.
CREATE OR REPLACE FUNCTION public.get_store_invite(p_token text)
RETURNS TABLE(store_name text, country_code text, role text, valid boolean, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  SELECT i.role AS irole, i.used_at, i.expires_at, s.name AS sname, s.country_code AS scc
    INTO r
    FROM public.store_invites i
    JOIN public.stores s ON s.id = i.store_id
   WHERE i.token = p_token;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, NULL::text, NULL::text, false, 'no_existe'; RETURN;
  END IF;
  IF r.used_at IS NOT NULL THEN
    RETURN QUERY SELECT r.sname, r.scc, r.irole, false, 'usada'; RETURN;
  END IF;
  IF r.expires_at < now() THEN
    RETURN QUERY SELECT r.sname, r.scc, r.irole, false, 'expirada'; RETURN;
  END IF;
  RETURN QUERY SELECT r.sname, r.scc, r.irole, true, 'ok';
END;
$$;

-- 3. Redimir (usuario YA autenticado). Lo mete en store_members y marca usado.
CREATE OR REPLACE FUNCTION public.redeem_store_invite(p_token text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r       record;
  v_uid   uuid := auth.uid();
  v_email text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM public.store_invites WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invitación inválida'; END IF;
  IF r.used_at IS NOT NULL THEN RAISE EXCEPTION 'Esta invitación ya fue usada'; END IF;
  IF r.expires_at < now() THEN RAISE EXCEPTION 'Esta invitación expiró'; END IF;
  -- Si la invitación está atada a un email, debe coincidir con el del usuario.
  IF r.email IS NOT NULL THEN
    SELECT lower(email) INTO v_email FROM auth.users WHERE id = v_uid;
    IF v_email IS DISTINCT FROM r.email THEN
      RAISE EXCEPTION 'Esta invitación es para otro correo';
    END IF;
  END IF;
  INSERT INTO public.store_members (store_id, user_id, role)
  VALUES (r.store_id, v_uid, r.role)
  ON CONFLICT (store_id, user_id) DO NOTHING;
  UPDATE public.store_invites SET used_at = now(), used_by = v_uid WHERE id = r.id;
  RETURN r.store_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_store_invite(uuid, text, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.create_store_invite(uuid, text, text) TO authenticated;

-- get_store_invite es seguro para anon: el token actúa de credencial.
GRANT  EXECUTE ON FUNCTION public.get_store_invite(text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.redeem_store_invite(text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.redeem_store_invite(text) TO authenticated;
