-- Estado de las credenciales Dropi SIN bajar los secretos al navegador.
--
-- Hasta hoy /admin → Credenciales Dropi hacía un SELECT directo de
-- `dropi_api_key` (la integration-key PERMANENTE, exp año 2126), del
-- `dropi_session_token` y hasta de `dropi_login_password` — la clave del panel
-- de Dropi, con la que se toca el dinero de la billetera — sólo para calcular
-- booleanos "hay algo guardado" y pintarlos en un input. Cualquier extensión,
-- HAR de soporte, captura o screen-share se llevaba las tres. Así se filtró la
-- clave de Ecuador (quedó en un volcado del DOM commiteado al repo).
--
-- Espejo de `get_store_shopify_status`: la credencial se ESCRIBE por RPC y
-- nunca se vuelve a leer desde el cliente. Funciones NUEVAS — no se toca
-- ninguna existente (REGLA #1: la base tiene versiones distintas del repo).

-- Vencimiento del session token, leído server-side. El panel necesita avisar
-- "token VENCIDO" sin tener el token: se decodifica acá el payload del JWT
-- (sin verificar firma — sólo se lee `exp`, igual que hacía el cliente).
CREATE OR REPLACE FUNCTION public.dropi_jwt_exp(p_token text)
RETURNS bigint
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_b64 text;
  v_pad int;
  v_payload jsonb;
BEGIN
  IF coalesce(p_token, '') = '' THEN RETURN NULL; END IF;
  v_b64 := translate(split_part(p_token, '.', 2), '-_', '+/');
  IF v_b64 = '' THEN RETURN NULL; END IF;
  v_pad := (4 - (length(v_b64) % 4)) % 4;
  v_payload := convert_from(decode(v_b64 || repeat('=', v_pad), 'base64'), 'UTF8')::jsonb;
  RETURN NULLIF(v_payload ->> 'exp', '')::bigint;
EXCEPTION WHEN OTHERS THEN
  -- Un token con basura pegada no puede tumbar la pantalla de credenciales.
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.dropi_jwt_exp(text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.dropi_jwt_exp(text) TO authenticated;

-- Estado para el panel de UNA tienda (owner o supervisor: son los que ven
-- /admin). Devuelve banderas, nunca valores.
CREATE OR REPLACE FUNCTION public.get_store_dropi_status(p_store_id uuid)
RETURNS TABLE(
  configured boolean,
  has_api_key boolean,
  has_session_token boolean,
  has_login_password boolean,
  login_email text,
  store_url text,
  country_code text,
  session_refreshed_at timestamptz,
  session_exp bigint
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v jsonb;
BEGIN
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  -- to_jsonb en vez de %ROWTYPE: si las columnas del login automático
  -- (migración 20260706120000) no están aplicadas, las claves simplemente no
  -- vienen y el panel degrada en vez de reventar.
  SELECT to_jsonb(t) INTO v
    FROM public.store_dropi_config t
   WHERE t.store_id = p_store_id;

  RETURN QUERY SELECT
    (v IS NOT NULL),
    (coalesce(v ->> 'dropi_api_key', '')        <> ''),
    (coalesce(v ->> 'dropi_session_token', '')  <> ''),
    (coalesce(v ->> 'dropi_login_password', '') <> ''),
    (v ->> 'dropi_login_email'),
    (v ->> 'dropi_store_url'),
    (v ->> 'country_code'),
    (v ->> 'dropi_session_refreshed_at')::timestamptz,
    public.dropi_jwt_exp(v ->> 'dropi_session_token');
END;
$$;
REVOKE ALL ON FUNCTION public.get_store_dropi_status(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.get_store_dropi_status(uuid) TO authenticated;

-- Lo que necesita StoreContext: un booleano por tienda propia para decidir si
-- mostrar el SetupWizard. Antes traía la api_key de TODAS las tiendas donde sos
-- owner en cada carga de la app, sólo para un Boolean().
CREATE OR REPLACE FUNCTION public.get_my_stores_dropi_status()
RETURNS TABLE(store_id uuid, has_api_key boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT q.sid, q.hk FROM (
    SELECT m.store_id AS sid,
           (coalesce(c.dropi_api_key, '') <> '') AS hk
      FROM public.store_members m
      LEFT JOIN public.store_dropi_config c ON c.store_id = m.store_id
     WHERE m.user_id = auth.uid() AND m.role = 'owner'
  ) q;
$$;
REVOKE ALL ON FUNCTION public.get_my_stores_dropi_status() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.get_my_stores_dropi_status() TO authenticated;
