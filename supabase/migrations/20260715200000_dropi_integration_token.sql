-- ============================================================================
-- API OFICIAL DE INTEGRACIONES DE DROPI — almacenamiento del token permanente
-- ----------------------------------------------------------------------------
-- Contexto (2026-07-15): estamos migrando de la API "web" (reverse-engineered,
-- session token que se vence) a la API OFICIAL de Integraciones de Dropi
-- (permanente, con soporte, con webhooks de estado). Dropi ya creó nuestro tipo
-- de integración "Guardian" (shop_type, id 1774).
--
-- Este token es DISTINTO de `dropi_api_key` (que hoy usa el canal web):
--   * base:   https://api.dropi.co/integrations   (oficial)
--   * header: dropi-integration-key
--   * token_type: INTEGRATIONS, permanente (exp año 2126)
--   * shop_type: "Guardian"
--
-- Se llena cuando Dropi habilite PRODUCCIÓN (tras certificar en el sandbox).
-- Por ahora las columnas quedan listas para no bloquear el deploy del webhook.
-- ============================================================================

ALTER TABLE public.store_dropi_config
  ADD COLUMN IF NOT EXISTS dropi_integration_token   text,
  ADD COLUMN IF NOT EXISTS dropi_integration_shop_id bigint;

COMMENT ON COLUMN public.store_dropi_config.dropi_integration_token IS
  'Token permanente de la API OFICIAL de Integraciones de Dropi (shop_type "Guardian"). Base api.dropi.co/integrations, header dropi-integration-key. Distinto de dropi_api_key (canal web). Se genera vía login -> shops/store tras certificación.';

COMMENT ON COLUMN public.store_dropi_config.dropi_integration_shop_id IS
  'shop_id de la tienda de integración en Dropi (POST /shops/store -> objects.id). Lo usa dropi-webhook para resolver a qué tienda pertenece un pedido nuevo notificado.';
