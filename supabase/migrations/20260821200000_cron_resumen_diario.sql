-- Cron del resumen diario por correo — Fase 4 del plan "de pantalla a proceso".
--
-- ADITIVA: solo agenda un job. No crea, no toca ni reescribe ninguna función
-- existente (⛔ REGLA #1).
--
-- ── Por qué a las 21:00 de Bogotá ───────────────────────────────────────────
-- El resumen se manda DESPUÉS de que cierra el turno, no durante. La ventana
-- de envíos proactivos de la operación termina a las 21:00 (`SEND_HOUR_END`
-- del viejo notificador), y el cierre de Seguimiento se firma al final del día:
-- mandarlo antes daría un resumen incompleto que después nadie vuelve a leer.
--
-- 21:00 Bogotá (UTC-5) = 02:00 UTC del día siguiente. pg_cron corre en UTC.
--
-- ⚠️ La edge function calcula su día con `diaBogota()` — a las 02:00 UTC eso
-- devuelve el día que acaba de terminar en Bogotá, que es justo el que se
-- quiere resumir. Si alguien mueve este horario, revisar esa cuenta: correrlo
-- a las 06:00 UTC resumiría un día distinto del que la gente acaba de trabajar.
--
-- ── Requisito de configuración ──────────────────────────────────────────────
-- La función necesita el secreto `RESEND_API_KEY` en Supabase. SIN esa clave no
-- manda nada y lo dice (deja fila de error en `sync_logs`); no finge un envío.
-- Opcional: `RESUMEN_FROM` para el remitente. Sin dominio verificado en Resend,
-- el default `onboarding@resend.dev` solo entrega al correo de la cuenta.

DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE command ILIKE '%resumen-diario%' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'resumen-diario-21h-bogota',
  '0 2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/resumen-diario',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key = 'cron_shared_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
