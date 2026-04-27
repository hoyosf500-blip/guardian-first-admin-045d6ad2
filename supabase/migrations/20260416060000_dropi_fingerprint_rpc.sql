-- Enable http extension (makes outbound HTTP calls from PL/pgSQL)
CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;

-- RPC function: calls Dropi buyer-fingerprint API server-side (avoids CORS).
-- Replaces the Edge Function dropi-fingerprint which Lovable didn't auto-deploy.
CREATE OR REPLACE FUNCTION public.dropi_fingerprint(p_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_token   text;
  v_b64     text;
  v_padded  text;
  v_payload jsonb;
  v_user_id text;
  v_clean   text;
  v_url     text;
  v_status  integer;
  v_content text;
  v_body    jsonb;
BEGIN
  -- 1. Read Dropi session token from app_settings
  SELECT value INTO v_token
  FROM app_settings
  WHERE key = 'dropi_session_token';

  IF v_token IS NULL OR v_token = '' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'Token de sesión Dropi no configurado. Ve a Admin → Token sesión Dropi.'
    );
  END IF;

  -- 2. Decode JWT payload to extract user_id (sub claim)
  BEGIN
    v_b64 := split_part(v_token, '.', 2);
    -- base64url → base64
    v_b64 := replace(replace(v_b64, '-', '+'), '_', '/');
    -- add padding
    v_padded := v_b64 || repeat('=', (4 - length(v_b64) % 4) % 4);
    v_payload := convert_from(decode(v_padded, 'base64'), 'UTF8')::jsonb;
    v_user_id := v_payload->>'sub';
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'Token de sesión Dropi inválido — no se pudo decodificar.'
    );
  END;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Token sin user_id (sub).');
  END IF;

  -- 3. Clean phone: strip spaces, dashes, plus sign, leading 57
  v_clean := regexp_replace(p_phone, '[\s\-\+]', '', 'g');
  v_clean := regexp_replace(v_clean, '^57', '');

  -- 4. Call Dropi fingerprint API via http extension
  v_url := format(
    'https://api-v2.dropi.co/bff/customers/fingerprint/v2?country_code=CO&user_id=%s&phone=%s&months=0',
    v_user_id, v_clean
  );

  SELECT status, content INTO v_status, v_content
  FROM http((
    'GET',
    v_url,
    ARRAY[http_header('Authorization', format('Bearer %s', v_token))],
    NULL,
    NULL
  )::http_request);

  -- 5. Handle HTTP errors
  IF v_status <> 200 THEN
    IF v_status = 401 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'Token de sesión Dropi expirado. Actualízalo en Admin → Token sesión Dropi.',
        'expired', true
      );
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', format('Error Dropi (%s)', v_status));
  END IF;

  -- 6. Parse Dropi response
  v_body := v_content::jsonb;

  IF NOT coalesce((v_body->>'is_successful')::boolean, false) OR v_body->'data' IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', coalesce(v_body->>'status_reason', 'Dropi no devolvió datos')
    );
  END IF;

  RETURN jsonb_build_object('ok', true, 'fingerprint', v_body->'data');
END;
$$;
