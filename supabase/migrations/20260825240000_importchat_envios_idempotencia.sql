-- IDEMPOTENCIA de envíos de plantillas de WhatsApp por ImporChat (2026-08-25)
--
-- Problema: `importchat-plantillas` (y el envío masivo planeado) POSTea la
-- plantilla y recién DESPUÉS marca el pedido. Un reintento de red, dos pestañas,
-- o dos asesoras a la vez => el cliente recibe DOS WhatsApp "✅ Confirma tu
-- pedido". El `enviando` del cliente solo frena el doble-click de una pestaña.
--
-- Solución: la edge function hace un CLAIM (INSERT) en esta tabla ANTES de
-- POSTear. El UNIQUE de abajo lo vuelve atómico: si ya hay un envío (o intento en
-- curso) de esa plantilla a ese pedido HOY, el INSERT falla con 23505 y la
-- función NO reenvía. Si el envío falla, la función BORRA el claim para que un
-- reintento legítimo pueda volver.
--
-- Tabla nueva y fría: NO toca orders/order_results/touchpoints, así que no aplica
-- el riesgo de lock de la REGLA #0.

CREATE TABLE IF NOT EXISTS public.importchat_envios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL,
  external_id text NOT NULL,
  plantilla   text NOT NULL,
  dia         date NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Granularidad diaria a propósito: no se manda la misma plantilla de
  -- confirmación dos veces el mismo día al mismo pedido. Un reenvío al día
  -- siguiente (raro) sí queda permitido.
  CONSTRAINT importchat_envios_uk UNIQUE (store_id, external_id, plantilla, dia)
);

-- Solo las edge functions (service_role, que salta RLS) escriben/leen esta tabla.
-- RLS prendida SIN policies = deny-all para authenticated/anon, que es lo que
-- queremos: nadie desde el browser toca el candado de idempotencia.
ALTER TABLE public.importchat_envios ENABLE ROW LEVEL SECURITY;
