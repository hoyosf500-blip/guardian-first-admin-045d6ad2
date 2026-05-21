-- Roles por tienda — agrega "supervisor" + helper is_store_manager.
--
-- Modelo de roles en store_members / store_invites:
--   owner       → todo lo de su tienda + invita/asigna roles. (CFO solo si admin global + CO.)
--   supervisor  → Admin (incl. claves) + Logística de su tienda. NO invita. NO CFO.
--   operator    → solo Dashboard/Confirmar/Seguimiento/Novedades.
--
-- NOTA: store_members y los helpers is_store_owner/is_store_member se crearon
-- fuera del repo (vía Lovable Cloud), por eso el nombre del CHECK no es
-- confiable → lo buscamos dinámicamente y lo reemplazamos.

-- 1. Permitir 'supervisor' en el CHECK de role.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.store_members'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE public.store_members DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE public.store_members
    ADD CONSTRAINT store_members_role_check CHECK (role IN ('owner','supervisor','operator'));
END $$;

DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.store_invites'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE public.store_invites DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE public.store_invites
    ADD CONSTRAINT store_invites_role_check CHECK (role IN ('owner','supervisor','operator'));
END $$;

-- 2. create_store_invite: permitir rol 'supervisor' (sigue siendo solo-dueño).
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
  IF p_role NOT IN ('owner','supervisor','operator') THEN
    RAISE EXCEPTION 'Rol inválido: %', p_role;
  END IF;
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO public.store_invites (store_id, role, token, email, created_by)
  VALUES (p_store_id, p_role, v_token, NULLIF(lower(trim(p_email)), ''), auth.uid());
  RETURN v_token;
END;
$$;

-- 3. Helper: ¿el usuario actual es owner O supervisor de esta tienda?
--    Espeja is_store_owner pero incluye supervisor. Usado por las RPC de
--    Admin/Logística para autorizar managers de la tienda (no admin global).
CREATE OR REPLACE FUNCTION public.is_store_manager(p_store_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.store_members
    WHERE store_id = p_store_id
      AND user_id = auth.uid()
      AND role IN ('owner', 'supervisor')
  );
$$;

REVOKE ALL ON FUNCTION public.is_store_manager(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.is_store_manager(uuid) TO authenticated;
