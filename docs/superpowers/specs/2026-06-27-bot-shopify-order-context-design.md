# Spec: Contexto de orden Shopify para el bot (Sara)

**Fecha:** 2026-06-27
**Estado:** Aprobado (diseño) — pendiente review del dueño antes del plan de implementación

## Objetivo

Cuando un cliente escribe al bot de WhatsApp (Sara) con el **mensaje precargado del formulario** —que incluye el id de la orden de Shopify— el bot consulta esa orden en Shopify **en vivo** y le da a Sara el **ítem + variante/talla + cantidad exactos** que el cliente compró, combinándolo con el estado/guía de Dropi. Sara responde con datos auténticos, **sin inventar**, y **sin exponer datos de otro cliente**.

## Contexto / estado actual (verificado en el código)

- **Bot:** `wa-ai-responder` (Deno edge). Resuelve la orden por **teléfono** en `orders` (Dropi) e inyecta `<order_data>` (producto, estado, guía, transportadora, link). Está **grounded**: solo responde con lo que tiene en los bloques de contexto; si no, deriva a un asesor.
- **Shopify:** `store_shopify_config` (por tienda) + `loadShopifyConfig`/`getShopifyAccessToken` (`_shared/shopifyStoreConfig.ts`). Ya se **leen órdenes** de Shopify en `shopify-push-dropi` (`GET orders/{id}.json`), o sea el permiso de lectura ya existe.
- **Cambio del dueño:** se cambió la tienda Shopify. Es solo **actualizar credenciales** en `store_shopify_config`; la feature es agnóstica (lee de ahí), así que apunta sola a la tienda nueva.

## No-objetivos (YAGNI)

- NO traer otras variantes/tallas *disponibles* del catálogo (para "¿lo tienen en 42?"). Eso es trabajo de las fichas de producto (`product_knowledge`), no de esta feature.
- NO cachear: fetch en vivo, best-effort.
- NO escribir nada en Shopify (solo lectura de órdenes; least privilege).
- NO tocar `wa-webhook` ni el flujo de audio/LID.

## Diseño (Enfoque A: id del mensaje + guard por teléfono → fetch en vivo)

### Componente nuevo
`supabase/functions/_shared/shopifyOrderLookup.ts` — módulo enfocado y testeable. Exporta:
- `extractShopifyOrderId(text: string): string | null` — **puro**. Regex sobre un marcador fijo.
- `phoneMatches(a: string, b: string): boolean` — **puro**. Compara los últimos 10 dígitos (mismo criterio que el lookup de Dropi del bot).
- `fetchShopifyOrderContext({ sbAdmin, storeId, orderId, senderPhone }): Promise<ShopifyOrderCtx | null>` — hace el fetch + guard.

`ShopifyOrderCtx = { name: string; items: Array<{ title: string; variant: string; quantity: number }> }`

### Disparo (en `wa-ai-responder`)
1. Tras obtener el texto del mensaje entrante, `extractShopifyOrderId(body)`.
2. **Marcador fijo** en el mensaje precargado para parseo seguro: una línea `Ref Shopify: {order_id}`. Regex: `/ref\s*shopify:\s*(\d{3,})/i` (no confunde con precio/teléfono porque exige la etiqueta).
3. Si no hay id → **no-op** (flujo actual intacto: phone→Dropi).

### Fetch
- `loadShopifyConfig(sbAdmin, storeId)` → si no hay config activa, no-op.
- `getShopifyAccessToken(cfg)` → `GET https://{shop_domain}/admin/api/2024-10/orders/{id}.json?fields=id,name,phone,line_items,shipping_address,customer`.
- **Robustez del id:** asumimos que `{order_id}` es el **id interno** numérico (lo que usa `orders/{id}.json`). Si resultara ser el **número** de orden (ej. 1001), el fetch cae a `GET orders.json?status=any&name=...` y toma la primera coincidencia. Así funciona con cualquiera de los dos que provea el formulario.
- Timeout ~3s (`AbortController`), best-effort. Cualquier fallo → `null`.

### Guard de privacidad (OBLIGATORIO — anti-IDOR)
- Teléfono de la orden Shopify: `shipping_address.phone || customer.phone || phone`.
- `phoneMatches(ordenShopify.phone, senderPhone)` por últimos 10 dígitos. Si **no coincide → descartar** (`return null`) + `console.warn`. Evita que un cliente meta el id de otra orden y vea datos ajenos.

### Inyección en el prompt
Bloque `<shopify_order>` (solo si el fetch + guard pasaron):
```
<shopify_order>
pedido_shopify: {name}
items:
- {title} | variante: {variant_title} | cant: {quantity}
- ...
</shopify_order>
```
Línea de instrucción para Sara: *"Usá `<shopify_order>` para el ítem/variante/talla EXACTOS que el cliente compró. Combinalo con `<order_data>` (estado/guía de Dropi). No inventes; si no aparece, no asumas."*

### Aditivo / robustez (cero regresión)
Sin id en el mensaje, Shopify caído/lento, timeout, o guard que no pasa → **no se inyecta nada** y sigue el flujo actual (phone→Dropi). La feature solo SUMA contexto cuando todo da bien.

### Multi-tienda
Todo por `store_id` vía `loadShopifyConfig`. Agnóstico a qué tienda Shopify: al actualizar las credenciales en `store_shopify_config`, apunta sola a la nueva.

## Errores
Todo best-effort → `null` en cualquier fallo (patrón del proyecto: el caller nunca rompe la respuesta del bot).

## Seguridad
- **Solo lectura de órdenes** (reusa la app/credenciales existentes; NO ampliar scopes a "todo").
- Guard de teléfono anti-IDOR (arriba).
- El token nunca se loguea.

## Testing
- **Unit (Vitest, funciones puras, sin red)** en `src/test/shopifyOrderLookup.test.ts`:
  - `extractShopifyOrderId`: con marcador → id; sin marcador → null; con precio/teléfono cerca → no confunde; mayúsc/minúsc del marcador.
  - `phoneMatches`: match por últimos 10 dígitos; formatos distintos (+57, 0 inicial); no-match.
- **Manual/live:** cliente con el mensaje precargado → Sara menciona la talla/variante exacta; cliente con id ajeno → NO expone datos (guard).

## Deploy / prerrequisitos
- **Redeploy de `wa-ai-responder`.** Sin migración, sin secret nuevo.
- **Config (dueño):** actualizar `store_shopify_config` con las credenciales de la **nueva** tienda Shopify (solo lectura de órdenes).
- **Formulario (dueño):** agregar al "Mensaje de WhatsApp precargado" la línea `Ref Shopify: {order_id}`.

## Archivos
- **Nuevo:** `supabase/functions/_shared/shopifyOrderLookup.ts`
- **Nuevo:** `src/test/shopifyOrderLookup.test.ts`
- **Editar:** `supabase/functions/wa-ai-responder/index.ts` (llamar al lookup + inyectar `<shopify_order>`)
- **Doc:** nota breve en `CLAUDE.md` (sección edge functions / bot)
