-- importchat-responder: el disparador que contesta el estado del pedido cuando
-- el cliente pregunta (o manda su número) y nadie le responde, y que cumple la
-- promesa del bot ("lo verifico y le confirmo por aquí") cuando el bot se calla.
--
-- ⛔ REGLA #0: acá NO se toca ninguna tabla caliente (orders / order_results /
-- touchpoints). Se agrega una columna a `store_importchat_config` (6 filas),
-- se crea una tabla nueva y se programa un cron. Sin locks que importen.
--
-- Qué hace cada parte:
--   1. `store_importchat_config.auto_estado` — el interruptor POR TIENDA. Nace
--      en false: una respuesta automática le llega a un cliente real, así que
--      se prende a mano, tienda por tienda (abajo se prende SOLO Rushmira EC,
--      que es donde está el bot de ImporChat y el caso reportado).
--   2. `importchat_auto_respuestas` — la bitácora de CADA decisión del
--      respondedor: enviado u omitido, por qué, con qué texto. Su UNIQUE es la
--      idempotencia: a un mismo mensaje del cliente se le contesta UNA vez.
--   3. El cron cada 3 min. Con el listado liviano de chats la corrida pesa
--      poco (no baja el XLSX de 9 MB del sync); 3 min es el tiempo que tarda
--      Guardian en cumplir la promesa que el bot dejó colgada.

ALTER TABLE public.store_importchat_config
  ADD COLUMN IF NOT EXISTS auto_estado boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.store_importchat_config.auto_estado IS
  'Respondedor automático de estado del pedido (importchat-responder). false = solo dry_run.';

CREATE TABLE IF NOT EXISTS public.importchat_auto_respuestas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  chat_id         text NOT NULL,
  external_id     text,
  phone           text,
  -- 'consulta' (el cliente preguntó por su envío) · 'numero' (mandó su número)
  -- · 'promesa' (el negocio dijo "lo verifico" y se calló).
  disparador      text NOT NULL,
  -- Instante del mensaje que disparó la decisión. Con chat_id es la clave de
  -- idempotencia: el mismo mensaje no se contesta dos veces.
  disparador_at   timestamptz NOT NULL,
  mensaje_cliente text,
  fase            text,
  -- 'enviado' | 'omitido'
  resultado       text NOT NULL,
  motivo          text,
  texto           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, chat_id, disparador_at)
);

CREATE INDEX IF NOT EXISTS importchat_auto_respuestas_store_created_idx
  ON public.importchat_auto_respuestas (store_id, created_at DESC);

ALTER TABLE public.importchat_auto_respuestas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.importchat_auto_respuestas FROM anon;

-- Los miembros de la tienda LEEN su bitácora (auditar qué salió automático).
-- Escribe solo la edge function con service role: nadie inserta desde el navegador.
DROP POLICY IF EXISTS importchat_auto_respuestas_select_miembros ON public.importchat_auto_respuestas;
CREATE POLICY importchat_auto_respuestas_select_miembros
  ON public.importchat_auto_respuestas FOR SELECT TO authenticated
  USING (public.is_store_member(store_id));

-- ── Cron cada 3 min ─────────────────────────────────────────────────────────
-- Mismo patrón idempotente que importchat-sync: se desengancha cualquier job
-- que ya llame a esta función y recién ahí se crea el canónico.
DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE command ILIKE '%importchat-responder%' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'importchat-responder-3min',
  '*/3 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://bokhlpfmttoizjaakntc.supabase.co/functions/v1/importchat-responder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM public.app_settings WHERE key = 'cron_shared_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ── Prender SOLO Rushmira Ecuador ──────────────────────────────────────────
-- Es la tienda del caso reportado y la única con el bot de ImporChat. Colombia
-- atiende por Chatea Pro (no pasa por acá). Para apagar: UPDATE … SET auto_estado=false.
UPDATE public.store_importchat_config
   SET auto_estado = true
 WHERE store_id = '512309c3-d5b7-4434-898a-31bed51dcd4d';
