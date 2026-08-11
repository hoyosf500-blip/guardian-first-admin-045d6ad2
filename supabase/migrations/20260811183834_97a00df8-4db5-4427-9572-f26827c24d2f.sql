-- 1) search_path fijo en las 4 funciones que lo tenían mutable
ALTER FUNCTION public._estado_bucket(text) SET search_path = public;
ALTER FUNCTION public._estado_norm(text) SET search_path = public;
ALTER FUNCTION public.protect_resolved_novedades_today() SET search_path = public;
ALTER FUNCTION public.tg_store_ad_spend_daily_updated_at() SET search_path = public;

-- 2) Quitarle a `anon` el EXECUTE sobre las RPC SECURITY DEFINER.
--    Todas ya validan sesión/membresía adentro (fail-closed), esto es defensa
--    en profundidad: con la clave pública ya no se pueden ni tantear.
--    Excepción: get_store_invite, que se consulta ANTES de iniciar sesión para
--    mostrar la vista previa del link de invitación.
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND p.proname <> 'get_store_invite'
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', f.sig);
  END LOOP;
END $$;

-- 3) Retención de logs: la base venía creciendo sin tope.
CREATE OR REPLACE FUNCTION public.purge_old_logs()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n_sync int := 0; n_hist int := 0; n_audit int := 0; n_warn int := 0;
BEGIN
  DELETE FROM public.sync_logs WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS n_sync = ROW_COUNT;

  DELETE FROM public.order_status_history WHERE changed_at < now() - interval '180 days';
  GET DIAGNOSTICS n_hist = ROW_COUNT;

  DELETE FROM public.audit_log WHERE created_at < now() - interval '180 days';
  GET DIAGNOSTICS n_audit = ROW_COUNT;

  DELETE FROM public.operator_inactivity_warnings WHERE created_at < now() - interval '90 days';
  GET DIAGNOSTICS n_warn = ROW_COUNT;

  RETURN jsonb_build_object('sync_logs', n_sync, 'order_status_history', n_hist,
                            'audit_log', n_audit, 'operator_inactivity_warnings', n_warn);
END $$;

REVOKE ALL ON FUNCTION public.purge_old_logs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_old_logs() TO service_role;

SELECT cron.unschedule('purge-old-logs') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-old-logs');
SELECT cron.schedule('purge-old-logs', '40 3 * * *', $$SELECT public.purge_old_logs()$$);

SELECT public.purge_old_logs();