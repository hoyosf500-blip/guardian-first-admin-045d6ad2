// COST-3 (2026-04-29): lista explícita de columnas para queries de la tabla `orders`.
// Evita usar `select('*')` que trae columnas pesadas o con jsonb que no se usan.
// Mantener sincronizado con DbOrderRow / dbToOrderData.
export const ORDER_COLUMNS =
  'id, external_id, nombre, phone, ciudad, departamento, producto, estado, ' +
  'fecha, fecha_conf, dias, dias_conf, valor, flete, costo_prod, costo_dev, ' +
  'cantidad, direccion, novedad, guia, transportadora, tags, tienda, ' +
  'novedad_sol, assigned_to, locked_by, locked_at, created_at, uploaded_by, ' +
  'validation_decision, address_kind, missing_fields, suggested_customer_message, ' +
  'barrio, complemento, documento_destinatario, lat, lng, google_place_id, address_parsed';
// HOTFIX 2026-04-30: 'suggested_address' temporalmente fuera del SELECT.
// La migration 20260502000000_add_suggested_address.sql aún no fue aplicada
// en la DB de producción y el SELECT explotaba con
// "column orders.suggested_address does not exist" rompiendo el load de
// pedidos en /confirmar. Re-introducir esta columna apenas Lovable o el
// usuario corra `supabase db push`.
