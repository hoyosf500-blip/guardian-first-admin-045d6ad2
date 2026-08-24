-- ¿Le ESCRIBIMOS a este cliente? — verificable, no declarado (24-ago-2026).
--
-- Pedido del dueño: "hay 75 pedidos en oficina, me dicen que ya les
-- escribieron — ¿cómo verifico yo eso?" y "¿a los cancelados ya se les
-- escribió?". Hoy el aviso de agencia es un touchpoint que DECLARA la asesora;
-- estas columnas guardan lo que ImporChat REGISTRÓ de verdad: el último
-- mensaje que salió del negocio hacia ese cliente y el último que el cliente
-- mandó. La pantalla compara contra la llegada a oficina / la cancelación.
--
-- ADITIVA: solo columnas NULLABLE sobre `orders`. No toca ninguna función viva
-- (⛔ REGLA #1). Las escribe únicamente la edge function `importchat-sync`
-- (UPDATE dirigido por store_id + external_id), igual que sus hermanas de
-- 20260822010000_senal_confirmacion_importchat.sql.
--
-- NULL nunca significa "no le escribieron": significa "no medido". El "no le
-- escribieron" verificado es chat_leido_at NOT NULL + chat_saliente_at NULL
-- (se leyó la conversación y no había ni un saliente). Cero ≠ sin dato.

ALTER TABLE public.orders
  -- Último mensaje que el NEGOCIO le mandó a este cliente (cualquier momento
  -- del chat; la comparación "¿después de llegar a la agencia?" se hace en la
  -- pantalla contra last_movement_at). Excluye notificaciones internas
  -- ("Te has asignado este chat") y mensajes borrados.
  ADD COLUMN IF NOT EXISTS chat_saliente_at   timestamptz,
  -- Cómo fue ese último mensaje: 'plantilla' (template automatizable) o
  -- 'directo' (texto/imagen/audio escrito en el chat). OJO: el export de
  -- ImporChat NO dice si lo mandó el bot o una asesora (28.710 de 29.156
  -- salientes traen el mismo emisor genérico de la conexión) — por eso esta
  -- columna dice el TIPO, que sí es un hecho, y no inventa un autor.
  ADD COLUMN IF NOT EXISTS chat_saliente_tipo text,
  -- Último mensaje que mandó el CLIENTE (texto, botón, audio, foto…).
  ADD COLUMN IF NOT EXISTS chat_entrante_at   timestamptz;

-- Vocabulario cerrado: si la edge function inventa un tipo nuevo, el UPDATE
-- falla ruidosamente en vez de guardar basura.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_chat_saliente_tipo_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_chat_saliente_tipo_check
      CHECK (chat_saliente_tipo IS NULL OR chat_saliente_tipo IN ('plantilla','directo'));
  END IF;
END $$;

COMMENT ON COLUMN public.orders.chat_saliente_at IS
  'Último mensaje del NEGOCIO al cliente según ImporChat (UTC). NULL + chat_leido_at NULL = no medido; NULL + chat_leido_at NOT NULL = se leyó el chat y NADIE le había escrito.';
COMMENT ON COLUMN public.orders.chat_saliente_tipo IS
  'plantilla | directo. El export de ImporChat no distingue bot vs asesora — esto registra el TIPO del último saliente, no su autor.';
COMMENT ON COLUMN public.orders.chat_entrante_at IS
  'Último mensaje del CLIENTE según ImporChat (UTC). Incluye botones apretados.';
