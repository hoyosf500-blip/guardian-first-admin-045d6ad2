ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS importchat_chat_id text;

COMMENT ON COLUMN public.orders.importchat_chat_id IS
  'id del chat del cliente en ImporChat (chat_id_cliente). Lo escribe importchat-sync; lo necesita importchat-send para poder responderle al cliente desde Guardian.';

CREATE INDEX IF NOT EXISTS orders_importchat_chat_id_idx
  ON public.orders (store_id, importchat_chat_id)
  WHERE importchat_chat_id IS NOT NULL;