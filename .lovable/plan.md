

# Plan: Implementar correctamente la integración Dropi según el manual

## Problemas encontrados en el edge function actual

1. **Falta el header `Origin`** — El manual indica que TODA petición a Dropi DEBE incluir un header `Origin` con la URL de la tienda. Sin esto, la API rechaza con 403.
2. **Método HTTP incorrecto** — El endpoint `/integrations/orders/myorders` debe ser **POST** con body JSON, no GET con query params.
3. **Sin paginación** — Solo trae los primeros 200 resultados. Si hay más, se pierden.
4. **Sin chunking de 89 días** — Rangos mayores a 90 días fallan por timeout.
5. **Sin `store_url` configurado** — No se guarda ni se usa la URL de la tienda del usuario.
6. **Sin UPSERT** — Si un pedido cambió de estado en Dropi, no se actualiza en la base de datos local; solo inserta nuevos.

## Cambios a implementar

### 1. Agregar `dropi_store_url` a `app_settings`
- En el panel Admin, permitir configurar la URL de la tienda Dropi (ej: `https://app.dropi.co`)
- Se usará como valor del header `Origin`

### 2. Reescribir `supabase/functions/dropi-sync/index.ts`
- **POST** en vez de GET a `/integrations/orders/myorders`
- Body: `{ "page": N, "page_size": 200, "date_filter": "created_at", "start_date": "...", "end_date": "...", "status": null }`
- Agregar header `Origin` con el `store_url` guardado (fallback: `https://app.dropi.co`)
- **Paginación automática**: loop por páginas hasta que no haya más resultados
- **Chunking de 89 días**: dividir rangos grandes en chunks de 89 días
- **UPSERT** en vez de INSERT: actualizar estado, guía, transportadora, novedad si el pedido ya existe
- **Rate limiting**: 500ms de delay entre requests a Dropi

### 3. Actualizar `SyncPanel.tsx`
- Agregar input para configurar `dropi_store_url` si no existe
- Mostrar progreso de chunks durante sincronizaciones largas

### 4. Migración de base de datos
- Agregar constraint UNIQUE en `orders.external_id` para habilitar UPSERT eficiente (si no existe)

## Archivos a modificar
- `supabase/functions/dropi-sync/index.ts` — Reescritura completa
- `src/components/admin/SyncPanel.tsx` — Campo store_url + progreso
- Migración SQL para unique constraint en `external_id`

## Resultado esperado
La sincronización traerá TODOS los pedidos del rango, actualizará estados existentes, manejará rangos grandes con chunking, y no fallará por falta de Origin header.

