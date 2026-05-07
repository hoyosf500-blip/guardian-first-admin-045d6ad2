-- Audit forense — fixes críticos:
--
-- 1. wallet_summary y wallet_daily_series son SECURITY DEFINER con GRANT TO
--    authenticated, pero NO chequean has_role('admin'). Cualquier operadora
--    autenticada podía leer todo el historial financiero del dueño vía REST
--    RPC, bypassing la RLS de dropi_wallet_movements.
--
-- 2. Typo en el cron body de dropi-wallet-sync: usaba 'untill' en vez de 'to'.
--    El edge function caía al default de 30 días en lugar de los 48h
--    intencionales — wallet desactualizado vs configurado.
--
-- Sin breaking changes para admins. Las operadoras ya no podían usar estas
-- RPCs en la práctica (no se llaman desde sus pantallas), así que el gate
-- es una formalidad de seguridad.

-- ─────────────────────────────────────────────────────────────────
-- FIX 1 — admin gate en wallet_summary
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.wallet_summary(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  total_entradas numeric,
  total_salidas  numeric,
  count_total    bigint,
  ultimo_saldo   numeric,
  categorias     text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT m.tipo, m.monto, m.categoria, m.saldo_despues, m.fecha
    FROM public.dropi_wallet_movements m
    WHERE m.fecha >= p_from AND m.fecha <= p_to
  ),
  ult AS (
    SELECT b.saldo_despues
    FROM base b
    WHERE b.saldo_despues IS NOT NULL
    ORDER BY b.fecha DESC
    LIMIT 1
  )
  SELECT
    COALESCE(SUM(CASE WHEN b.tipo = 'ENTRADA' THEN b.monto ELSE 0 END), 0)::numeric,
    COALESCE(SUM(CASE WHEN b.tipo = 'SALIDA'  THEN b.monto ELSE 0 END), 0)::numeric,
    COUNT(*)::bigint,
    (SELECT u.saldo_despues FROM ult u),
    COALESCE(ARRAY_AGG(DISTINCT b.categoria) FILTER (WHERE b.categoria IS NOT NULL), '{}')
  FROM base b;
END;
$$;

-- ─────────────────────────────────────────────────────────────────
-- FIX 1 — admin gate en wallet_daily_series
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.wallet_daily_series(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  fecha    date,
  entrada  numeric,
  salida   numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    (m.fecha AT TIME ZONE 'UTC')::date,
    COALESCE(SUM(CASE WHEN m.tipo = 'ENTRADA' THEN m.monto ELSE 0 END), 0)::numeric,
    COALESCE(SUM(CASE WHEN m.tipo = 'SALIDA'  THEN m.monto ELSE 0 END), 0)::numeric
  FROM public.dropi_wallet_movements m
  WHERE m.fecha >= p_from AND m.fecha <= p_to
  GROUP BY 1
  ORDER BY 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.wallet_summary(timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_daily_series(timestamptz, timestamptz) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- FIX 2 — reschedule cron dropi-wallet-sync-6h con 'to' correcto
-- (la migration 20260506140000 mandaba 'untill' que el edge function
-- ignora, cayendo al default de 30 días en vez de la ventana 48h)
-- ─────────────────────────────────────────────────────────────────

DO $$
DECLARE
  j RECORD;
BEGIN
  FOR j IN
    SELECT jobid FROM cron.job
     WHERE jobname IN ('dropi-wallet-sync-6h', 'dropi-wallet-sync')
        OR command ILIKE '%dropi-wallet-sync%'
  LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'dropi-wallet-sync-6h',
  '0 */6 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/dropi-wallet-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || COALESCE(
        (SELECT value FROM public.app_settings WHERE key = 'cron_anon_key'),
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJva2hscGZtdHRvaXpqYWFrbnRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwMzgzNjksImV4cCI6MjA5MTYxNDM2OX0.tILkDzwZf8SSNKRDF9Neofd16MTwCOWqr2JcR-dMasc'
      ),
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key = 'cron_shared_secret')
    ),
    body := jsonb_build_object(
      'from', to_char((now() AT TIME ZONE 'UTC')::date - INTERVAL '2 days', 'YYYY-MM-DD'),
      'to',   to_char((now() AT TIME ZONE 'UTC')::date,                     'YYYY-MM-DD')
    ),
    timeout_milliseconds := 60000
  );
  $cron$
);
