-- COST-3: Retención automática de logs + índices de performance
-- Reduce ~65 MB de storage y acelera queries calientes.

-- 1. Función de limpieza ejecutable manualmente o por cron
CREATE OR REPLACE FUNCTION public.cleanup_old_logs()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_audit_deleted integer;
  v_sync_deleted integer;
BEGIN
  DELETE FROM public.audit_log WHERE created_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS v_audit_deleted = ROW_COUNT;

  DELETE FROM public.sync_logs WHERE created_at < NOW() - INTERVAL '14 days';
  GET DIAGNOSTICS v_sync_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'audit_deleted', v_audit_deleted,
    'sync_deleted',  v_sync_deleted,
    'ran_at', NOW()
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_old_logs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cleanup_old_logs() TO authenticated;

-- 2. Índices para acelerar queries calientes y limpiezas
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
  ON public.audit_log (created_at);

CREATE INDEX IF NOT EXISTS idx_sync_logs_created_at
  ON public.sync_logs (created_at);

-- Cola de confirmación: ConfirmarTab busca por estado + locked_by
CREATE INDEX IF NOT EXISTS idx_orders_estado_locked
  ON public.orders (estado, locked_by, locked_at);

-- 3. Programar limpieza diaria a las 4am Bogotá (09:00 UTC) si pg_cron disponible
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('cleanup-old-logs-daily')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-old-logs-daily');
    PERFORM cron.schedule(
      'cleanup-old-logs-daily',
      '0 9 * * *',
      $cron$ SELECT public.cleanup_old_logs(); $cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Si pg_cron no está disponible, no fallar la migración
  RAISE NOTICE 'pg_cron no disponible: %', SQLERRM;
END $$;
