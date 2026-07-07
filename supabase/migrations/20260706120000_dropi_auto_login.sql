-- Login automático de Dropi (renovación del session token por tienda).
--
-- El `dropi_session_token` (JWT del panel web) vence ~24h y hoy se pega A MANO
-- en Admin → Credenciales Dropi. Todo lo que habla con el panel web (cotizar/
-- cambiar transportadora, crear órdenes de productos privados en shopify-push)
-- muere cuando vence. El flujo Bearer documentado (POST /api/login con
-- email+password+white_brand_id) se abandonó en 2026-04 porque la cuenta CO
-- tiene 2FA (403) — pero es POR CUENTA: la cuenta EC no tiene 2FA (confirmado
-- por el dueño 2026-07-06), así que el auto-login sirve por tienda.
--
-- Guardamos email+clave del panel Dropi en store_dropi_config (mismo nivel de
-- sensibilidad que la api_key y el session_token que ya viven ahí; RLS/RPCs
-- owner-only). La edge function `_shared/dropiSessionLogin.ts` los usa para
-- renovar el token cuando vence y persiste el nuevo + timestamp.

ALTER TABLE public.store_dropi_config
  ADD COLUMN IF NOT EXISTS dropi_login_email text,
  ADD COLUMN IF NOT EXISTS dropi_login_password text,
  ADD COLUMN IF NOT EXISTS dropi_white_brand_id integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS dropi_session_refreshed_at timestamptz;

-- RPC NUEVA y separada (no tocamos upsert_store_dropi_config, que funciona):
-- guarda solo el login. Clave vacía = conservar la guardada (el panel no
-- re-muestra la clave); para DESACTIVAR el auto-login se borra el email.
CREATE OR REPLACE FUNCTION public.upsert_store_dropi_login(
  p_store_id uuid,
  p_login_email text,
  p_login_password text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_store_owner(p_store_id) THEN
    RAISE EXCEPTION 'Solo el dueño de la tienda puede editar el login de Dropi';
  END IF;
  UPDATE public.store_dropi_config SET
    dropi_login_email    = NULLIF(trim(coalesce(p_login_email, '')), ''),
    dropi_login_password = CASE
      WHEN coalesce(p_login_password, '') = '' THEN dropi_login_password
      ELSE p_login_password
    END,
    updated_at = now()
  WHERE store_id = p_store_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La tienda no tiene configuración Dropi todavía (guardá primero la Clave API)';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_store_dropi_login(uuid, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.upsert_store_dropi_login(uuid, text, text) TO authenticated;
