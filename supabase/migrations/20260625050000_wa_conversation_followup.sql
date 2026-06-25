-- Follow-up proactivo a clientes que quedaron CALLADOS (lo manda wa-status-notifier).
--
-- Marca cuándo el bot envió el último recordatorio por silencio en una conversación,
-- para no repetirlo dentro del mismo "episodio" de silencio. Se resetea solo: cuando
-- la conversación vuelve a moverse (el cliente responde y el bot/operadora escribe),
-- last_message_at pasa a ser mayor que last_followup_at y queda elegible de nuevo.
--
-- Sin cambios de RLS: la columna la escribe wa-status-notifier con service role.

ALTER TABLE public.wa_conversations
  ADD COLUMN IF NOT EXISTS last_followup_at timestamptz;
