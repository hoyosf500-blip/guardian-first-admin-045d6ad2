-- Tanda 6 — H3: documentación de rotación del anon JWT
--
-- Las migrations 20260417020000_cron_shared_secret.sql y 20260417085923
-- tienen el anon JWT hardcoded en pg_cron schedules. El JWT es público
-- por diseño en Supabase (anon key), pero si algún día lo rotás desde
-- el dashboard, los crons rompen porque siguen apuntando al viejo.
--
-- Esta migration es ADITIVA — no toca los crons existentes — y prepara
-- el terreno para una rotación futura sin tocar SQL:
--
--   1. Crea el slot `cron_anon_key` en app_settings (vacío al inicio).
--   2. Documenta el procedimiento de rotación en la columna description.
--   3. Cuando rotes la key en el dashboard de Supabase:
--        UPDATE public.app_settings SET value = '<NUEVO_JWT>'
--          WHERE key = 'cron_anon_key';
--      Y luego corré una migration nueva (estilo
--      20260417020000_cron_shared_secret.sql) que re-schedulee los crons
--      leyendo `cron_anon_key` de app_settings en vez de hardcoded.
--
-- Mientras `cron_anon_key` esté vacío, los crons siguen usando el JWT
-- hardcoded. Cero impacto operativo.

INSERT INTO public.app_settings (key, value, description)
SELECT 'cron_anon_key',
       '',
       'Anon JWT para que pg_cron llame edge functions. Mantener en blanco hasta que se rote la anon key en Supabase dashboard. Ver migration 20260427120500 para procedimiento.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.app_settings WHERE key = 'cron_anon_key'
);
