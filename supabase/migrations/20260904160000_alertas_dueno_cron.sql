-- ============================================================================
-- Alertas al dueño sin estar conectado: tabla de dedupe + cron cada 10 min
-- ============================================================================
--
-- Pedido del dueño (3-sep-2026): "control más grande sobre las operadoras y
-- supervisores". Hasta hoy todo lo que Guardian sabía de inactividad vivía en
-- el navegador de la asesora o en un panel que hay que abrir. La edge
-- `alertas-inactividad` mira cada 10 min, en horario laboral de cada tienda,
-- quién lleva ≥30 min sin ninguna gestión (sin pausa declarada) y quién no
-- entró 45 min después del inicio del turno, y le manda UN correo al dueño de
-- ESA tienda (Resend, misma clave que resumen-diario).
--
-- `alertas_dueno` es el registro de lo avisado: sirve para no repetir (una
-- inactividad se repite cada 90 min; "no entró" una vez por día) y para que
-- Productividad pueda mostrarlo después. Los miembros de la tienda la leen;
-- escribe solo el service role (la edge).
--
-- Tabla nueva: cero DDL sobre tablas calientes.
-- ============================================================================

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.alertas_dueno (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tipo        text NOT NULL CHECK (tipo IN ('inactiva', 'no_entro')),
  minutos     int  NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alertas_dueno_store_dia_idx
  ON public.alertas_dueno (store_id, created_at DESC);

ALTER TABLE public.alertas_dueno ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "members read alertas dueno" ON public.alertas_dueno;
CREATE POLICY "members read alertas dueno" ON public.alertas_dueno
  FOR SELECT TO authenticated USING (public.is_store_member(store_id));
GRANT SELECT ON public.alertas_dueno TO authenticated;
GRANT ALL    ON public.alertas_dueno TO service_role;

COMMENT ON TABLE public.alertas_dueno IS
  'Avisos mandados al dueño por alertas-inactividad (inactiva ≥30 min / no_entro). Dedupe + historial. Ver 20260904160000.';

-- ── Cron: cada 10 min. Fuera del turno la edge corta antes de leer nada. ────
DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE command ILIKE '%alertas-inactividad%' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'alertas-inactividad-10min',
  '4,14,24,34,44,54 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/alertas-inactividad',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key = 'cron_shared_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
