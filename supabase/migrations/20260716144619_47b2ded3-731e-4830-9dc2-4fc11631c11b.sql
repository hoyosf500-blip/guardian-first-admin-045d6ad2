
-- 1) dropi-cron: 5min → 15min
DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE command ILIKE '%dropi-cron%' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'dropi-cron-15min',
  '*/15 * * * *',
  $cmd$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/dropi-cron',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer '|| (SELECT value FROM public.app_settings WHERE key='anon_key'),
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key='cron_shared_secret')
    ),
    body := '{}'::jsonb
  );
  $cmd$
);

-- 2) dropi-health: 1h → 6h (al minuto 7 para no chocar con dropi-cron)
DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE command ILIKE '%dropi-health%' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'dropi-health-6h',
  '7 */6 * * *',
  $cmd$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/dropi-health',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer '|| (SELECT value FROM public.app_settings WHERE key='anon_key'),
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key='cron_shared_secret')
    ),
    body := '{}'::jsonb
  );
  $cmd$
);

-- 3) Subir cap del heartbeat de 120s a 300s (acompaña el flush cada 5 min del cliente)
CREATE OR REPLACE FUNCTION public.record_operator_heartbeat(
  p_store_id      uuid,
  p_active_seconds int,
  p_idle_seconds   int
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  IF p_store_id IS NULL THEN RETURN; END IF;
  IF COALESCE(p_active_seconds,0) = 0 AND COALESCE(p_idle_seconds,0) = 0 THEN RETURN; END IF;

  INSERT INTO public.operator_activity_buckets (operator_id, store_id, bucket_minute, active_seconds, idle_seconds)
  VALUES (
    auth.uid(),
    p_store_id,
    date_trunc('minute', now()),
    LEAST(GREATEST(COALESCE(p_active_seconds,0), 0), 300),
    LEAST(GREATEST(COALESCE(p_idle_seconds,0), 0), 300)
  )
  ON CONFLICT (operator_id, store_id, bucket_minute) DO UPDATE
    SET active_seconds = LEAST(public.operator_activity_buckets.active_seconds + EXCLUDED.active_seconds, 300),
        idle_seconds   = LEAST(public.operator_activity_buckets.idle_seconds   + EXCLUDED.idle_seconds,   300);
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_operator_heartbeat(uuid, int, int) TO authenticated;
