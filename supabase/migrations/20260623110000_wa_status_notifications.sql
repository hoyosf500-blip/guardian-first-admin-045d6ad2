-- Avisos PROACTIVOS de WhatsApp por cambio de estado en Dropi.
--
-- Cuando un pedido cambia de "bucket" de estado (va en camino / sale a reparto /
-- novedad / entregado), el bot le escribe SOLO al cliente — una vez por
-- transición. Lo dispara el cron wa-status-notifier; la idempotencia vive en
-- wa_order_notifications. La primera vez que ve un pedido solo guarda baseline
-- (NO avisa) para no blastear el histórico.
--
-- Depende de wa_bot_config (migración 20260623100000). NO aplicar sin coordinar.

-- 1. Config de avisos dentro de wa_bot_config (jsonb: enabled, buckets, templates).
ALTER TABLE public.wa_bot_config
  ADD COLUMN IF NOT EXISTS notify jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2. Idempotencia: 1 fila por (tienda, pedido) con el último bucket notificado.
CREATE TABLE IF NOT EXISTS public.wa_order_notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  external_id    text NOT NULL,
  customer_phone text,
  last_bucket    text,          -- en_camino | reparto | novedad | entregado
  last_estado    text,
  notified_at    timestamptz,   -- última vez que se envió un aviso real
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, external_id)
);

ALTER TABLE public.wa_order_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read wa order notifications" ON public.wa_order_notifications;
CREATE POLICY "members read wa order notifications" ON public.wa_order_notifications
  FOR SELECT TO authenticated
  USING (public.is_store_member(store_id));

-- 3. Guardar la config de avisos (manager-only). Upsert sobre wa_bot_config sin
--    pisar el resto de la config (prompt/modelo/etc.).
CREATE OR REPLACE FUNCTION public.upsert_wa_bot_notify(p_store_id uuid, p_notify jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'Solo el dueño o supervisor puede configurar los avisos' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.wa_bot_config (store_id, notify, updated_at)
  VALUES (p_store_id, COALESCE(p_notify, '{}'::jsonb), now())
  ON CONFLICT (store_id) DO UPDATE
    SET notify = COALESCE(p_notify, '{}'::jsonb), updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_wa_bot_notify(uuid, jsonb) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.upsert_wa_bot_notify(uuid, jsonb) TO authenticated;

-- 4. Cron cada 10 min → dispara wa-status-notifier (mismo esquema de auth que
--    dropi-cron: anon Bearer para pasar el gateway + x-cron-secret interno).
DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE command ILIKE '%wa-status-notifier%' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'wa-status-notifier-10min',
  '*/10 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/wa-status-notifier',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJva2hscGZtdHRvaXpqYWFrbnRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwMzgzNjksImV4cCI6MjA5MTYxNDM2OX0.tILkDzwZf8SSNKRDF9Neofd16MTwCOWqr2JcR-dMasc',
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key = 'cron_shared_secret')
    ),
    body := '{}'::jsonb
  );
  $cron$
);
