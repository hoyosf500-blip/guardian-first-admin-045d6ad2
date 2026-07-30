-- ─────────────────────────────────────────────────────────────────────────────
-- Alta autoservicio de tiendas (2026-07-30).
--
-- Guardian se abre a terceros: cada amigo/estudiante se registra, CREA SU
-- PROPIA tienda y queda de owner — independiente, con sus datos privados por
-- RLS. Hasta hoy las tiendas se creaban a mano y un usuario nuevo moría en
-- "Sin tiendas asignadas".
--
-- Reglas:
--  * Función NUEVA (no reemplaza ninguna desplegada — sin riesgo de drift).
--  * SECURITY DEFINER: inserta en stores/store_members sin abrir RLS de
--    escritura de esas tablas al cliente.
--  * UNA tienda propia por usuario (guard anti-spam). El admin global
--    (user_roles.role='admin' — el dueño de la plataforma) no tiene límite.
--  * NO toca user_roles: crear tienda NUNCA otorga admin global.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_my_store(
  p_name text,
  p_country_code text DEFAULT 'CO'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_cc text := upper(btrim(coalesce(p_country_code, 'CO')));
  v_store uuid;
  v_is_admin boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF length(v_name) < 2 OR length(v_name) > 60 THEN
    RAISE EXCEPTION 'El nombre de la tienda debe tener entre 2 y 60 caracteres';
  END IF;
  IF v_cc NOT IN ('CO', 'EC') THEN
    RAISE EXCEPTION 'País inválido: usá CO (Colombia) o EC (Ecuador)';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = v_uid AND role = 'admin'
  ) INTO v_is_admin;

  -- Una tienda propia por usuario. Puede ser operadora/supervisora de otras
  -- tiendas (eso no bloquea) — lo que no puede es acumular tiendas PROPIAS.
  IF NOT v_is_admin AND EXISTS (
    SELECT 1 FROM public.store_members WHERE user_id = v_uid AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Ya sos dueño de una tienda. Si necesitás otra, hablá con el administrador.';
  END IF;

  INSERT INTO public.stores (name, country_code, status, created_by)
  VALUES (v_name, v_cc, 'active', v_uid)
  RETURNING id INTO v_store;

  INSERT INTO public.store_members (store_id, user_id, role)
  VALUES (v_store, v_uid, 'owner');

  RETURN v_store;
END;
$$;

REVOKE ALL ON FUNCTION public.create_my_store(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_my_store(text, text) TO authenticated;
