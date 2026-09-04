SET lock_timeout = '5s';

ALTER TABLE public.importchat_envios
  ADD COLUMN IF NOT EXISTS estado        text        NOT NULL DEFAULT 'enviando',
  ADD COLUMN IF NOT EXISTS intento_at    timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS confirmado_at timestamptz,
  ADD COLUMN IF NOT EXISTS operador_id   uuid,
  ADD COLUMN IF NOT EXISTS canal         text        NOT NULL DEFAULT 'importchat',
  ADD COLUMN IF NOT EXISTS chat_id       text,
  ADD COLUMN IF NOT EXISTS mensaje_id    text,
  ADD COLUMN IF NOT EXISTS senal         text,
  ADD COLUMN IF NOT EXISTS respuesta     jsonb;

ALTER TABLE public.importchat_envios
  DROP CONSTRAINT IF EXISTS importchat_envios_estado_ck;
ALTER TABLE public.importchat_envios
  ADD CONSTRAINT importchat_envios_estado_ck
  CHECK (estado IN ('enviando', 'confirmado', 'no_confirmado', 'fallido'));

CREATE INDEX IF NOT EXISTS ix_importchat_envios_auditoria
  ON public.importchat_envios (store_id, dia, estado);

COMMENT ON COLUMN public.importchat_envios.estado IS
  'confirmado = el mensaje SE VIO en el chat del cliente. Solo ese estado bloquea un reenvío: una fila no confirmada documenta, no traba.';
COMMENT ON COLUMN public.importchat_envios.respuesta IS
  'Lo que contesto ImporChat, sin datos del cliente. Es la prueba para reclamar cuando aceptan el envio y el mensaje no llega.';