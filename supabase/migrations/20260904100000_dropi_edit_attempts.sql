-- ============================================================================
-- El editor de pedidos reclama ANTES de crear: `dropi_edit_attempts`
-- ============================================================================
--
-- Auditoría del 4-sep-2026, después del duplicado de Colombia 2. El robot y el
-- panel de Shopify ya tenían un claim atómico (`shopify_pushed_orders`) antes
-- de crear una orden en Dropi. El EDITOR no tenía ninguno: `dropi-change-carrier`
-- en sus modos `apply` / `apply_value` / `apply_edit` recrea el pedido (POST con
-- `is_edit_order`, id nuevo) y lo único que miraba antes era el estado de la
-- fila. Dos pestañas del editor, o un diálogo colgado que se reabre y se vuelve
-- a apretar, hacían DOS POST → DOS órdenes nuevas vivas para el mismo cliente.
--
-- Esta tabla es el registro de intentos de edición, con el mismo patrón que
-- `shopify_pushed_orders`: se inserta ANTES del POST (UNIQUE por tienda +
-- pedido serializa el primero), se reclama por compare-and-swap, y se asienta
-- `done` con el id nuevo INMEDIATAMENTE después de crear. La máquina de estados
-- vive comentada en la edge function (`claimEditAttempt`).
--
-- `phone_last9` no es para reclamar (editar dos pedidos DISTINTOS del mismo
-- cliente a la vez es legítimo): es para que el barrido de hermanas y la
-- recuperación de un create incierto NO confundan la orden nueva de la otra
-- edición con la propia.
--
-- ⛔ REGLA #0 — tabla NUEVA. Cero DDL sobre `orders` / `order_results` /
-- `touchpoints`. El `lock_timeout` va igual, por costumbre y por si un día
-- alguien le agrega una FK a una tabla caliente.
-- ⛔ REGLA #1 — no se toca ninguna función desplegada.
-- ============================================================================

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.dropi_edit_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id         uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  -- El pedido que se está EDITANDO (el viejo). Después de un recreate, el
  -- pedido pasa a tener otro id y una edición posterior es otra fila.
  external_id      text NOT NULL,
  mode             text NOT NULL,                    -- apply | apply_value | apply_edit
  status           text NOT NULL DEFAULT 'pending',  -- pending | done | error | unknown
  started_at       timestamptz NOT NULL DEFAULT now(),
  started_by       uuid REFERENCES auth.users(id),
  new_external_id  text,                             -- la orden que Dropi creó
  phone_last9      text,                             -- para excluir, no para reclamar
  error_message    text,
  warning          text,                             -- "done" con la vieja viva, etc.
  UNIQUE (store_id, external_id)
);

CREATE INDEX IF NOT EXISTS dropi_edit_attempts_phone_idx
  ON public.dropi_edit_attempts (store_id, phone_last9, started_at DESC);

ALTER TABLE public.dropi_edit_attempts ENABLE ROW LEVEL SECURITY;

-- Miembros de la tienda pueden VER sus intentos (diagnóstico). La escritura es
-- solo vía la edge function (service role, no sujeta a RLS): si un cliente
-- pudiera insertar, podría "reservar" un pedido ajeno o falsear el id creado.
DROP POLICY IF EXISTS "members read edit attempts" ON public.dropi_edit_attempts;
CREATE POLICY "members read edit attempts" ON public.dropi_edit_attempts
  FOR SELECT TO authenticated
  USING (public.is_store_member(store_id));

COMMENT ON TABLE public.dropi_edit_attempts IS
  'Claim atómico de las EDICIONES que recrean un pedido en Dropi (dropi-change-carrier '
  'apply/apply_value/apply_edit). Se inserta antes del POST; done = ya se creó la '
  'orden nueva (new_external_id); unknown = no se sabe; error = no tocó Dropi. '
  'Ver 20260904100000.';
