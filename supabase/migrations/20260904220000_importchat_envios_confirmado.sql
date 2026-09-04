-- El candado de plantillas deja de significar "se intentó" y pasa a significar
-- "se VIO en el chat del cliente".
--
-- ── Lo que se midió (4-sep-2026, Ecuador) ──────────────────────────────────
-- Del 25-ago al 4-sep, `touchpoints` tenía 14 apuntes de "Mandé la plantilla X"
-- y 9 de esos clientes no habían recibido NINGÚN mensaje: su último saliente
-- real era del 31-ago o del 2-sep. Solo el 4-sep fueron 5 de 6.
--
-- ImporChat contestaba `success: true`, Guardian escribía el touchpoint, pintaba
-- la tarjeta como gestionada y sumaba la gestión a la productividad de la
-- asesora. El cliente no tenía nada. Y encima, al reintentar, el candado decía
-- "ya se le había mandado hoy" sobre un envío que nunca salió.
--
-- El `success:true` de `enviar_template_masivo` confirma que RECIBIERON EL
-- PEDIDO, no que ENTREGARON EL MENSAJE. Control que lo prueba: Colombia usa el
-- mismo diseño de candado y lleva 17 de 17 entregadas desde el 20-ago.
--
-- ── Por qué columnas y no un DELETE mejor hecho ────────────────────────────
-- Hoy la fila se BORRA cuando el envío falla (y el error del DELETE ni se mira).
-- Borrar destruye la prueba: de los 9 envíos perdidos no quedó rastro en ningún
-- lado salvo un touchpoint que miente. Con estas columnas la fila sobrevive
-- diciendo "ImporChat contestó esto y el mensaje nunca apareció" — que es el
-- diagnóstico Y el papel para reclamarle a ImporChat.
--
-- ⛔ REGLA #0: `importchat_envios` NO es una tabla caliente (no la toca ningún
-- cron ni el frontend; solo las edge functions de plantillas, por service_role,
-- unas decenas de filas por día). Igual va con `lock_timeout`: si algo la tiene
-- tomada, esto falla rápido en vez de encolar a alguien detrás.
--
-- ⛔ El UNIQUE (store_id, external_id, plantilla, dia) NO se toca: es lo único
-- que gana la carrera de dos clics simultáneos.

SET lock_timeout = '5s';

ALTER TABLE public.importchat_envios
  -- enviando | confirmado | no_confirmado | fallido
  ADD COLUMN IF NOT EXISTS estado        text        NOT NULL DEFAULT 'enviando',
  -- Cuándo se tomó el claim. Es lo que deja saber si el dueño de un `enviando`
  -- sigue vivo: la plataforma mata una edge function a los ~150 s, así que un
  -- `enviando` de más de 3 minutos tiene dueño muerto y se puede reclamar.
  ADD COLUMN IF NOT EXISTS intento_at    timestamptz NOT NULL DEFAULT now(),
  -- El instante en que el mensaje SE VIO en la conversación. NULL = no se vio.
  ADD COLUMN IF NOT EXISTS confirmado_at timestamptz,
  ADD COLUMN IF NOT EXISTS operador_id   uuid,
  ADD COLUMN IF NOT EXISTS canal         text        NOT NULL DEFAULT 'importchat',
  ADD COLUMN IF NOT EXISTS chat_id       text,
  -- El id del mensaje que se reconoció en el hilo: la prueba, no la afirmación.
  ADD COLUMN IF NOT EXISTS mensaje_id    text,
  -- Con qué se lo reconoció: ancla | nombre | tipo | tardia.
  ADD COLUMN IF NOT EXISTS senal         text,
  -- Lo que contestó ImporChat, con las claves en LISTA BLANCA y recortado.
  -- ⛔ Nunca el payload enviado: ahí van nombre, dirección y teléfono del
  -- cliente. Misma regla que "los console.log con datos de cliente no van".
  ADD COLUMN IF NOT EXISTS respuesta     jsonb;

-- Las filas viejas quedan como `enviando` vencido ⇒ reclamables ⇒ reintentables.
-- Es exactamente lo que queremos para los 9 envíos que nunca salieron.

ALTER TABLE public.importchat_envios
  DROP CONSTRAINT IF EXISTS importchat_envios_estado_ck;
ALTER TABLE public.importchat_envios
  ADD CONSTRAINT importchat_envios_estado_ck
  CHECK (estado IN ('enviando', 'confirmado', 'no_confirmado', 'fallido'));

-- Para la auditoría de todos los días: "¿cuántas se confirmaron y cuántas no?".
CREATE INDEX IF NOT EXISTS ix_importchat_envios_auditoria
  ON public.importchat_envios (store_id, dia, estado);

COMMENT ON COLUMN public.importchat_envios.estado IS
  'confirmado = el mensaje SE VIO en el chat del cliente. Solo ese estado bloquea un reenvío: una fila no confirmada documenta, no traba.';
COMMENT ON COLUMN public.importchat_envios.respuesta IS
  'Lo que contestó ImporChat, sin datos del cliente. Es la prueba para reclamar cuando aceptan el envío y el mensaje no llega.';
