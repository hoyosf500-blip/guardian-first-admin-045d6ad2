-- Auto-push Shopify → Dropi: sube SOLO los pedidos limpios automáticamente.
--
-- Problema (reporte del dueño 2026-07-18): la automatización Shopify→Dropi
-- (Dropify) a veces falla y deja ventas colgadas en Shopify que nadie sube a
-- Dropi hasta que la asesora abre el panel anti-fuga y las empuja a mano. Anoche
-- entraron ~29 así y quedaron esperando a la mañana. Si un día nadie abre el
-- panel, esas ventas se pierden.
--
-- Solución: un "robot" (edge function shopify-auto-push, cron cada 15 min) que
-- por cada tienda con auto_push_enabled detecta los pendientes y los sube SOLO si
-- están limpios (llamando a shopify-push-dropi, que ya trae los candados:
-- anti-duplicado por teléfono, anti-sobreprecio, idempotencia). Los que el push
-- bloquea (duplicado, precio raro, producto sin vínculo, zona sin cobertura)
-- quedan para el panel manual — el robot NUNCA adivina en algo dudoso.
--
-- NADA cambia del flujo: el pedido llega a Dropi igual que hoy (misma
-- confirmación). Lo único distinto es que ya no depende de que alguien apriete
-- el botón.

-- ── 1. Interruptor por tienda ───────────────────────────────────────────────
ALTER TABLE public.store_shopify_config
  ADD COLUMN IF NOT EXISTS auto_push_enabled boolean NOT NULL DEFAULT false;

-- ── 2. Prender/apagar el auto-envío (solo dueño) ────────────────────────────
CREATE OR REPLACE FUNCTION public.set_store_shopify_auto_push(
  p_store_id uuid,
  p_enabled  boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_store_owner(p_store_id) THEN
    RAISE EXCEPTION 'Solo el dueño de la tienda puede cambiar el auto-envío' USING ERRCODE = '42501';
  END IF;
  UPDATE public.store_shopify_config
    SET auto_push_enabled = COALESCE(p_enabled, false),
        updated_at        = now()
  WHERE store_id = p_store_id;
END $$;

REVOKE ALL ON FUNCTION public.set_store_shopify_auto_push(uuid, boolean) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.set_store_shopify_auto_push(uuid, boolean) TO authenticated;

-- ── 3. Leer el estado del auto-envío (RPC nuevo, NO tocar get_store_shopify_status) ─
-- get_store_shopify_status desplegado tiene más columnas que el repo (schema
-- drift documentado); reescribirlo borraría auth_mode y rompería el panel. Este
-- RPC aparte es aditivo: devuelve solo el flag, legible por miembros de la tienda.
CREATE OR REPLACE FUNCTION public.get_store_shopify_auto_push(p_store_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_store_member(p_store_id) THEN
    RETURN false; -- no miembro → apagado (no revela nada)
  END IF;
  RETURN COALESCE(
    (SELECT auto_push_enabled FROM public.store_shopify_config WHERE store_id = p_store_id),
    false
  );
END $$;

REVOKE ALL ON FUNCTION public.get_store_shopify_auto_push(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.get_store_shopify_auto_push(uuid) TO authenticated;

-- ── 4. Prender el auto-envío en Ecuador (Rushmira) — donde está la fuga ──────
-- Colombia y las demás quedan APAGADAS (default false); se prenden con el
-- interruptor de /admin → Credenciales, o con set_store_shopify_auto_push().
UPDATE public.store_shopify_config
  SET auto_push_enabled = true, updated_at = now()
  WHERE store_id = '512309c3-d5b7-4434-898a-31bed51dcd4d';

-- ── 5. Programar el robot: cada 15 min, offset :03/:18/:33/:48 ──────────────
-- Offset para no chocar con dropi-cron (:00/:05…) ni con health (:00). Auth =
-- x-cron-secret (app_settings.cron_shared_secret), igual que dropi-health/nightly.
-- Idempotente: mismo patrón unschedule-by-command-ILIKE + cron.schedule.
DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE command ILIKE '%shopify-auto-push%' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'shopify-auto-push-15min',
  '3,18,33,48 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/shopify-auto-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key = 'cron_shared_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
