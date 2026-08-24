-- El identificador de la CONVERSACIÓN de ImporChat, por pedido.
--
-- Hace falta para poder ESCRIBIRLE al cliente desde Guardian sin salir de la
-- pantalla: el canal de envío de ImporChat no acepta un teléfono suelto, pide
-- el id del chat. `importchat-sync` ya lo tiene en la mano (viene en
-- `orders/cache/list` como `chat_id_cliente`) y hasta ahora lo tiraba.
--
-- ADITIVA: una columna nullable. No toca ninguna función viva (⛔ REGLA #1).
-- NULL = todavía no se leyó ese pedido, NO "no tiene chat": la diferencia se
-- ve contra `chat_leido_at`, igual que el resto de las columnas de chat.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS importchat_chat_id text;

COMMENT ON COLUMN public.orders.importchat_chat_id IS
  'id del chat del cliente en ImporChat (chat_id_cliente). Lo escribe importchat-sync; lo necesita importchat-send para poder responderle al cliente desde Guardian.';

-- Índice parcial: la única consulta es "dame el chat de ESTE pedido".
CREATE INDEX IF NOT EXISTS orders_importchat_chat_id_idx
  ON public.orders (store_id, importchat_chat_id)
  WHERE importchat_chat_id IS NOT NULL;
