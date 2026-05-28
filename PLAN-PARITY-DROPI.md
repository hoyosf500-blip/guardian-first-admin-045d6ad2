# Plan de prevención: Guardian ↔ Dropi siempre fresco

Generado en sesión 2026-05-28 después de auditar 71 pedidos no-terminales y arreglar 47.

## TL;DR

- **Hallazgo crítico**: `dropi-cron` está corriendo cada 5min con `status: success` pero `synced_count: 0, total_count: 0` desde el 2026-05-21. Sin error_message, sin throttle. **Está silenciosamente devolviendo 0 pedidos.**
- **Causa raíz probable**: Lovable no redeployó la edge function después del commit `71a20cf` (CO-primero + budget). La versión deployada es la vieja, y algo del `filter_date_by=FECHA DE CAMBIO DE ESTATUS` o del rango no devuelve nada en el endpoint `/integrations/orders/myorders`.
- **Fix inmediato**: redeploy de `dropi-cron`.
- **Plan a futuro**: 5 capas de defensa para que esto NUNCA vuelva a pasar silenciosamente.

---

## Capa 1 — Cron robusto + observable (redeploy inmediato)

**Acción**: el usuario le pide a Lovable redeploy:
```
Por favor, redeploya las edge functions: dropi-cron, dropi-refresh-order
(ambas tienen commits en main que no se han desplegado)
```

**Cambios adicionales a hacer ANTES del redeploy:**

### 1.1 — Loguear "0 pedidos devueltos por Dropi" como WARN no como success

Hoy: `status: success, synced_count: 0` → invisible.
Después: si Dropi devuelve `objects.length === 0` para los 2 pases en TODAS las tiendas, log como `status: 'warn'` con `error_message: 'Dropi devolvió 0 pedidos en ventana cambio_estatus+creado — probable api_key inválida o endpoint roto'`.

`supabase/functions/dropi-cron/index.ts` — al final del run, si `grandSynced === 0 && grandTotal === 0` en TODAS las tiendas:
```ts
const sourceWarn = perStore.every(s => (s.synced ?? 0) === 0 && (s.total ?? 0) === 0);
const finalStatus = sourceWarn ? 'warn' : 'success';
// log al sync_logs con status='warn' si fue 0/0
```

### 1.2 — Health check endpoint

Crear `supabase/functions/dropi-health/index.ts` que:
- Llama `/integrations/orders/myorders?result_number=1&date_from=hoy&date_to=hoy` con cada api_key
- Si HTTP != 200 → marca la tienda en `store_dropi_config.last_health_status = 'down'`
- Si HTTP 200 pero `objects.length === 0` en últimos 7d → `'degraded'`
- Si HTTP 200 y `objects.length > 0` → `'ok'`

Corre cada hora (cron pg_cron).

### 1.3 — Probar filter_date_by alternativo

El valor `FECHA DE CAMBIO DE ESTATUS` puede haber cambiado. Documentación oficial de Dropi (revisar en su panel): el endpoint integrations puede esperar `MODIFIED_DATE` o `updated_at` o `Modified Date`. Hoy en el web v2 funciona `Modified Date`. Sospecho que en integrations es algo similar.

**Test concreto**: con la integration-key real (server-side curl), probar:
- `filter_date_by=Modified Date`
- `filter_date_by=MODIFIED_DATE`
- `filter_date_by=updated_at`
- `filter_date_by=FECHA DE CAMBIO DE ESTATUS` (actual)
- Sin `filter_date_by` (default)

Ver cuál devuelve los pedidos que SÍ cambiaron en las últimas 24h pero NO se crearon en ese rango.

---

## Capa 2 — Self-healing per-pedido (refrescar al ver)

Ya construido pero falta redeploy:
- Edge function `dropi-refresh-order` (commit `82bd89e` tiene el endpoint correcto `/integrations/orders/myorders/{id}`).
- Hook `useRefreshOrder` + botón Refrescar en `CrmCallView`/`OrderCard`.

**Mejora adicional**: auto-refresh al abrir un pedido si `last_movement_at` > 1h.

`src/components/order-detail/OrderDetailPage.tsx` — al mount:
```tsx
useEffect(() => {
  if (!order) return;
  const ageHs = (Date.now() - new Date(order.lastMovementAt ?? order.createdAt).getTime()) / 3600000;
  const isNonTerminal = !['ENTREGADO','CANCELADO','DEVOLUCION'].includes(order.estado);
  if (ageHs > 1 && isNonTerminal) {
    refresh(order.externalId); // silencioso, sin toast
  }
}, [order?.externalId]);
```

Esto hace que cualquier pedido que un operador abra, **se refresque automáticamente** si lleva más de 1h sin update. Costo: 1 call Dropi por pedido visto, despreciable.

---

## Capa 3 — Auditoría desde el browser (el método de hoy, automatizable)

Hoy hice esto a mano. **Hay que convertirlo en un botón.**

### 3.1 — Botón "Auditar paridad" en `/admin`

`src/components/AdminTab.tsx`:
```tsx
<Button onClick={runDropiAudit}>
  🔍 Auditar paridad con Dropi (lee ambos lados y reporta divergencias)
</Button>
```

`src/lib/dropiAudit.ts` (nuevo):
1. Lee todos los pedidos no-terminales de Guardian para la tienda activa
2. Lee Dropi via web v2 endpoint (con el `DROPI_token` que vive en localStorage en el navegador del owner) — **fan-out a 1 sola tienda EC a la vez** para respetar rate limits
3. Cross-reference local (sin server)
4. Muestra modal con divergencias y botón "Aplicar fix" que hace los PATCH

**Ventajas**:
- No requiere redeploy de edge function
- No depende del cron
- El owner puede correrlo cuando vea que algo está stale
- Usa la sesión de Dropi del owner (el mismo que carga los pedidos a mano)

**Caveat**: requiere que el owner tenga la pestaña de Dropi abierta y la app pueda accederla. Solución limpia: copiar el JWT de Dropi a `store_dropi_config.dropi_web_token` y refrescarlo cuando expire (cada 1h). El componente lee de DB no de localStorage.

### 3.2 — Página `/admin → Paridad Dropi` con histórico

Tabla de:
- Última corrida de auditoría
- Pedidos en Guardian no-terminales
- Pedidos en Dropi en rango
- Divergencias encontradas
- Botón "Re-ejecutar"

---

## Capa 4 — Monitor de salud en el UI

### 4.1 — Banner siempre visible si sync stale

`src/components/SyncFreshness.tsx` — ya existe pero solo muestra "hace X minutos". Agregar:
- **Verde**: última sync `success` Y `synced_count > 0` en últimas 24h
- **Amarillo**: última sync `success` pero `synced_count === 0` por > 6h → "Sync corriendo pero sin novedades. Click para auditar."
- **Rojo**: error o > 1h sin attempt → "Sync caído. Click para reintentar."

El amarillo es la pieza CRÍTICA — hoy estábamos en estado amarillo desde el 21/05 y el banner decía verde "hace 5 min".

### 4.2 — Alerta on-load si hay > 5 pedidos no-terminales sin movimiento > 7 días

`src/lib/staleDetector.ts`:
```ts
export function detectStaleOrders(orders: OrderData[]): OrderData[] {
  const now = Date.now();
  return orders.filter(o => {
    const age = (now - new Date(o.lastMovementAt ?? o.createdAt).getTime()) / 86400000;
    return age > 7 && !['ENTREGADO','CANCELADO','DEVOLUCION'].includes(o.estado);
  });
}
```

En `/seguimiento`, banner: "12 pedidos llevan más de 7 días sin movimiento — [Auditar contra Dropi]"

---

## Capa 5 — Reconciliación nocturna

`supabase/functions/dropi-nightly-reconcile/index.ts` — corre 1 vez al día (3am):

1. Por cada tienda con `dropi_api_key`:
   - Pull todos los no-terminales de DB
   - Pull rango 30 días de Dropi via `/integrations/orders/myorders`
   - Cross-reference
   - UPSERT divergencias automáticamente
   - INSERT log `nightly_reconcile_results { store_id, divergent_count, applied, missing_in_dropi }`

2. Si `divergent_count > 5`: insert un row en `system_alerts` que muestra banner persistente en `/admin`.

Esto cierra el ciclo: aunque el cron de 5min falle SILENCIOSAMENTE, máximo 24h después se reconcilía solo.

---

## Mapa de archivos a tocar (resumido)

| Archivo | Cambio | Capa |
|---|---|---|
| `supabase/functions/dropi-cron/index.ts` | Log warn cuando 0/0 + test filter_date_by alternativo | 1 |
| `supabase/functions/dropi-health/index.ts` | NUEVO — ping a cada api_key | 1 |
| `supabase/functions/dropi-refresh-order/index.ts` | Ya hecho, falta redeploy | 2 |
| `src/components/order-detail/OrderDetailPage.tsx` | Auto-refresh al abrir si > 1h | 2 |
| `src/lib/dropiAudit.ts` | NUEVO — cliente del cross-ref | 3 |
| `src/components/tabs/AdminTab.tsx` | Botón "Auditar paridad" + modal | 3 |
| `src/components/SyncFreshness.tsx` | 3 estados (verde/amarillo/rojo) | 4 |
| `src/lib/staleDetector.ts` | NUEVO — detector > 7d sin movimiento | 4 |
| `supabase/functions/dropi-nightly-reconcile/index.ts` | NUEVO — reconciliación 3am | 5 |
| `supabase/migrations/...` | NUEVO — tablas `nightly_reconcile_results`, `system_alerts` | 5 |

---

## Orden de ejecución sugerido

1. **HOY**: redeploy de `dropi-cron` + `dropi-refresh-order` (single Lovable prompt)
2. **Día 1**: implementar Capa 4 (banner 3 estados). 1 archivo, no requiere edge function.
3. **Día 2**: implementar Capa 3 (botón Auditar en /admin). 2 archivos nuevos en front.
4. **Día 3**: implementar Capa 2 mejorada (auto-refresh al abrir). 1 archivo.
5. **Semana 2**: implementar Capa 5 (reconciliación nocturna). 1 edge function + 2 migrations.
6. **Semana 2**: Capa 1 (health check + warn). 1 edge function + cambios en cron.

Cada capa es **independiente** — si una falla, las otras compensan. Es lo opuesto al estado actual donde si el cron falla, NO HAY NADA.

---

## Por qué pasó hoy

1. El cron empezó a devolver 0 el 21/05 (probablemente Dropi cambió algo en su endpoint integrations o el filter_date_by).
2. Como devolvía 0 con `status: success`, el banner del UI seguía en verde.
3. Los pedidos nuevos que el operador subía sí entraban (porque el carga es client-side directo), pero las actualizaciones de estado nunca llegaban.
4. La dedup de pedidos reemplazados existía pero requería que el nuevo estuviera en la DB para detectar el viejo.
5. Resultado: 47 pedidos quedaron en estados obsoletos durante 7 días sin que nadie se diera cuenta.

**Lección**: nunca confíes en `status: success` solo — hay que verificar `synced_count > 0` también, o tarde o temprano el sistema entra en un estado zombie silencioso.
