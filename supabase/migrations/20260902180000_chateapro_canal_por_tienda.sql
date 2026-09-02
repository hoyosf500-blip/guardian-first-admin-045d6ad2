-- Chatea Pro como canal de chat de las tiendas de Colombia.
--
-- Ecuador atiende por ImporChat y las dos de Colombia por Chatea Pro
-- (chateapro.app, whitelabel de UChat). Hasta hoy Guardian solo sabía hablar
-- ImporChat: la asesora de Colombia tenía que salir a otra pestaña para leer,
-- escribir o mandar una plantilla — que es exactamente lo que se eliminó en
-- Ecuador en agosto.
--
-- ⛔ REGLA #0: esto es ADITIVO. Una tabla nueva y UNA columna nullable sin
-- default en `stores` (6 filas, y `ADD COLUMN` sin default es cambio de
-- catálogo, no reescribe la tabla). `lock_timeout` para que falle rápido en vez
-- de encolar lecturas detrás de un lock. Ninguna función SQL se toca (REGLA #1).
SET lock_timeout = '5s';

-- ── 1. Credenciales, mismo molde que store_importchat_config ───────────────
-- La API key es un Bearer de workspace: da acceso a leer conversaciones y a
-- escribirle a los clientes. NO tiene por qué viajar nunca al navegador.
CREATE TABLE IF NOT EXISTS public.store_chateapro_config (
  store_id    uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  api_key     text        NOT NULL,
  api_base    text        NOT NULL DEFAULT 'https://chateapro.app/api',
  habilitado  boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.store_chateapro_config ENABLE ROW LEVEL SECURITY;

-- Sin políticas: nadie llega por PostgREST. Solo la edge function con service
-- role (que salta RLS). Deliberado, igual que ImporChat.
REVOKE ALL ON TABLE public.store_chateapro_config FROM anon, authenticated;

-- ── 2. Qué canal usa cada tienda ───────────────────────────────────────────
-- El cliente NO puede leer ninguna de las dos tablas de credenciales (bien),
-- así que necesita otro lado para saber a qué edge function llamar. Va en
-- `stores`, que todo miembro ya lee.
--
-- Que esta columna diga 'chateapro' NO garantiza que la credencial exista: si
-- falta, la edge function responde `sin_config` y la pantalla ya sabe pintar
-- eso. Se prefiere un estado honesto y auto-corregible a un dato duplicado que
-- puede mentir en silencio.
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS canal_chat text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stores_canal_chat_check'
  ) THEN
    ALTER TABLE public.stores
      ADD CONSTRAINT stores_canal_chat_check
      CHECK (canal_chat IS NULL OR canal_chat IN ('importchat', 'chateapro'));
  END IF;
END $$;

COMMENT ON COLUMN public.stores.canal_chat IS
  'Por dónde se le escribe al cliente: importchat (EC) o chateapro (CO). NULL = sin canal, la pantalla no ofrece escribir.';

-- ── 3. Marcar las tiendas vivas ────────────────────────────────────────────
-- Ecuador ya venía funcionando con ImporChat; se deja explícito para que la
-- resolución del canal no dependa de adivinar por país.
UPDATE public.stores SET canal_chat = 'importchat'
 WHERE id = '512309c3-d5b7-4434-898a-31bed51dcd4d' AND canal_chat IS NULL;

-- Rushmira (Colombia) y Colombia 2. La credencial se carga aparte (ver abajo):
-- sin ella la pantalla dirá "sin configurar", que es la verdad.
UPDATE public.stores SET canal_chat = 'chateapro'
 WHERE id IN (
   '00000000-0000-0000-0000-000000000001',
   '4433a6e4-2c80-4b8c-aa1b-7cf458845f45'
 ) AND canal_chat IS NULL;

-- ── 4. Cómo se carga la llave (a mano, NO va en el repo) ───────────────────
-- El 11-ago-2026 una integration-key de Dropi terminó publicada en `main`. La
-- API key de Chatea Pro NO se escribe en ninguna migración ni en ningún commit:
-- se pega una sola vez en el editor SQL, así:
--
--   INSERT INTO public.store_chateapro_config (store_id, api_key)
--   VALUES ('00000000-0000-0000-0000-000000000001', 'PEGAR_AQUI_LA_KEY')
--   ON CONFLICT (store_id) DO UPDATE SET api_key = EXCLUDED.api_key, updated_at = now();
--
--   INSERT INTO public.store_chateapro_config (store_id, api_key)
--   VALUES ('4433a6e4-2c80-4b8c-aa1b-7cf458845f45', 'PEGAR_AQUI_LA_KEY')
--   ON CONFLICT (store_id) DO UPDATE SET api_key = EXCLUDED.api_key, updated_at = now();
--
-- Si las dos tiendas comparten workspace en Chatea Pro, es la MISMA key en las
-- dos filas. Si son workspaces distintos, una key por fila.
