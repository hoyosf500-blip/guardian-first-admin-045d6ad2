# Validador de Direcciones con Autocomplete — Diseño

**Fecha:** 2026-04-29
**Estado:** Diseño aprobado, pendiente plan de implementación
**Autor:** Brainstorming Claude Opus 4.7 (1M context)
**Proyecto:** Guardian First Admin
**Reemplaza:** `2026-04-28-validador-direcciones-design.md` (consolida + agrega capa de autocomplete + cache + cap diario)

---

## 1. Contexto

Guardian First Admin es un CRM para operación COD en Colombia, integrado con Dropi y transportadoras Interrapidísimo / Envía / Coordinadora / TCC / Domina / Veloces. Las operadoras llaman al cliente para confirmar el pedido antes de despacho. La dirección llega pre-llenada desde Shopify (96.7% del volumen) y la operadora la verifica/edita por teléfono.

**Dolor concreto:**
- Pedidos devueltos por dirección incompleta o no encontrable (costo de flete ida + vuelta)
- Operadora pierde tiempo descifrando direcciones mal escritas
- Sin asistencia para corregir: la operadora teclea a ciegas
- Badge de validación actual dice "rojo" pero NO dice QUÉ falta ni qué pedirle al cliente

**Lo que NO controlamos:** el checkout de Shopify donde el cliente teclea la dirección. La intervención posible está en `/confirmar` y formularios de edición del CRM.

## 2. Datos verificados (1.342 pedidos, 6 mar–28 abr 2026)

| Dato | Valor |
|---|---|
| Volumen | 25 pedidos/día, picos de 95 |
| Origen | 96.7% Shopify |
| Ciudades atendidas | 412 — top 3 = 13.4%, top 10 = 27.6% |
| Efectividad real | 49% (entregado / cerrados) |
| Tasa de devolución | 21.2% |
| Retiro en oficina | 20.9% del volumen |
| Direcciones sin tipo de vía | 35.8% |
| Direcciones sin patrón #X-Y | 50.1% |
| Direcciones rurales / no estándar | ~28% del volumen |
| Pedidos con NOVEDAD registrada | 2.8% (38 / 1.342) |
| Casos rurales documentados | Chocó 63, San Andrés 42, Vaupés/Guainía/Vichada |

**Por transportadora (efectividad / devolución):**
- Interrapidísimo 48.8% / 23.7% (84% volumen)
- Envía 37.9% / 21.4%
- Coordinadora 40.8% / 10.2%
- TCC 20.0% / 10.0% (peor)
- Domina 32.1% / 3.6%

**Impacto realista del validador:** ~30 pedidos recuperados/mes = $900K-1.5M COP/mes en flete de devolución ahorrado. **NO sube efectividad de 49% a 53%** (correlación ≠ causalidad). Bloquea pedidos que iban a fallar y captura datos faltantes antes del despacho.

## 3. Objetivo

Sistema en tres capas que ataca el problema en el orden temporal del flujo:

**A. Autocomplete (PRE):** mientras la operadora edita la dirección al hablar con el cliente, sugiere direcciones reales de Google Places filtradas por país=CO y bias a la ciudad del pedido. Click selecciona → llena dirección + lat/lng + place_id, marca verde automáticamente.

**B. Validación con feedback accionable (POST-edit):** para direcciones rurales, libres o que no se seleccionaron del autocomplete, corre validación híbrida (heurística + Google Address Validation + Claude Haiku condicional). Cuando marca rojo, muestra QUÉ falta y un botón "Copiar mensaje WhatsApp" pre-redactado para pedirle ese dato al cliente.

**C. Gate al confirmar (PRE-despacho):** función pura `canConfirmOrder()` bloquea botón Confirmar si dirección red, teléfono inválido, o Coordinadora sin documento. Admin puede override con checkbox.

## 4. Lo que ya existe (no rehacer)

| Pieza | Archivo | Estado |
|---|---|---|
| Heurística regex local | `src/lib/addressHeuristic.ts` | Mantener, extender para rural-aware |
| Hook React Query con fallback | `src/hooks/useAddressValidation.ts` | Mantener, extender para place_id |
| Badge actual (lectura) | `src/components/AddressValidationBadge.tsx` | Mantener para superficies de solo-lectura |
| Edge function validación | `supabase/functions/dropi-validate-address/index.ts` | Extender (pickup-office detection + rural-aware + Haiku) |
| Cache 24h validación | tabla `address_validations` | Mantener |
| Departamentos/ciudades estático | `src/lib/colombiaGeo.ts` | Reemplazar por catálogo DANE 1.123 municipios (Fase 7) |
| Google Maps API key | Configurada en Supabase secrets | Confirmado |
| Places API + Address Validation API | Habilitadas en GCP | Confirmado |

## 5. Arquitectura

### 5.1 Pipeline de captura de dirección

```
Operadora abre /confirmar (CallView) o EditOrderDialog
  ↓
<AddressAutocomplete> input shadcn con icono de mapa
  ↓ (operadora tipea, debounce 300ms)
  ↓
Capa 0a — Cache L3 (recurrent customer): ¿este teléfono tiene pedido previo
         con place_id en orders? → banner "Misma dirección anterior" arriba del input
  ↓ (operadora puede usar el pre-fill o seguir tipeando)
  ↓
Capa 0b — Cache L1 (memoria sesión): ¿query exacta ya cacheada? → mostrar
  ↓
Capa 0c — Cache L2 (DB address_autocomplete_cache): ¿query normalizada? → hit
  ↓
Capa 1 — Google Places Autocomplete API: country:co + bias ciudad
  ↓ (5 sugerencias)
  ↓
Operadora click → Google Places Details API → fill { direccion, barrio, place_id, lat, lng }
  ↓
Frontend supabase.update(orders): validation_decision='green', address_kind='urban',
  google_place_id, lat, lng, address_parsed (JSONB con components y formatted_address)
  ↓
NO se llama edge function (ahorro)
```

### 5.2 Pipeline de validación (free-write / rural / sync inicial)

Se dispara cuando: operadora cierra el campo sin seleccionar del autocomplete; o pedido nuevo importado de Shopify por dropi-sync.

```
Input: { direccion, ciudad, departamento, telefono? }

Capa 1 — Cache address_validations 24h
Capa 2 — Detección retiro en oficina (regex pickup_office)
         → return { decision: 'pickup_office', address_kind: 'pickup_office' }
Capa 3 — Heurística regex rural-aware (manzana/lote/finca/vereda/corregimiento/km/sector)
         → urban / rural / unknown + missing_fields preliminares
Capa 4 — Google Address Validation API (solo si urban + heurística no decisiva)
Capa 5 — Claude Haiku 4.5 (solo si Google + heurística son ambiguos)
         Prompt estructurado retorna JSON:
         { decision, address_kind, missing_fields, suggested_customer_message }

Persistir en orders + address_validations cache
```

### 5.3 Gate al confirmar

```ts
canConfirmOrder({
  validation_decision, hasBarrio, telefonoValido,
  documentoSiCoordinadora, isAdmin, overrideChecked
}): { canConfirm: boolean; reason?: string }
```

**Reglas:**
- `green` o `pickup_office` + teléfono válido → confirmar OK
- `yellow` → requiere checkbox "Confirmé con cliente" en UI
- `red` → bloqueado. Admin puede override con checkbox
- Teléfono inválido (no inicia en 3 o ≠10 dígitos) → bloqueado sin override
- Coordinadora sin `documento_destinatario` → bloqueado sin override

UI: tooltip en botón Confirmar con `reason` cuando bloqueado.

## 6. Componentes UI

### 6.1 `<AddressAutocomplete>` (nuevo)

**Path:** `src/components/address/AddressAutocomplete.tsx`

```ts
interface Props {
  value: string;
  onChange: (next: AddressUpdate) => void;
  ciudad?: string;
  departamento?: string;
  customerPhone?: string;     // para Cache L3
  disabled?: boolean;
  placeholder?: string;
}

interface AddressUpdate {
  direccion: string;
  barrio?: string;
  place_id?: string;
  lat?: number;
  lng?: number;
  address_kind: 'urban' | 'rural' | 'pickup_office' | 'unknown';
  source: 'autocomplete' | 'free_write' | 'recurrent_customer';
}
```

**Comportamiento:**
- Input shadcn estándar, debounce 300ms al tipear
- Banner superior si Cache L3 hit: `Misma dirección que pedido anterior: [usar esta] [editar]`
- Dropdown con 5 sugerencias de Google
- Footer del dropdown: `Mi dirección no está aquí — escribir libre`
- Indicador de selección autocomplete (icono check) / editando (icono lápiz) / sin intentar (sin icono)
- Si API key falta o cuota agotada → cae a input plain, toast informativo, NO rompe UI
- Hook subyacente `useGooglePlaces()` carga `@googlemaps/js-api-loader` lazy

### 6.2 `<AddressFeedbackCard>` (nuevo, reemplaza al `<AddressValidationBadge>` solo en superficies de edición)

**Path:** `src/components/address/AddressFeedbackCard.tsx`

Layout: card compacto con borde según severidad. 4 estados:

| Estado | UI |
|---|---|
| green | `Direccion verificada`. Sin acciones. |
| pickup_office | `Retiro en oficina · {Carrier}`. Sin acciones. |
| yellow | Card amarillo + lista checks: "Confirmar: [check] Barrio · [check] Punto de referencia". |
| red | Card rojo + dos secciones: **"Falta:"** (lista de `missing_fields` traducidos) + **"Mensaje WhatsApp sugerido:"** con botón `Copiar`. |

Override admin: footer con checkbox `Confirmé manualmente con el cliente — proceder`.

### 6.3 `<DespachoGateButton>` (nuevo, reemplaza al botón "Confirmar" actual)

**Path:** `src/components/address/DespachoGateButton.tsx`

Wrapper que internamente usa `canConfirmOrder()`. Si bloqueado: botón disabled + tooltip con motivo. Si OK: botón normal.

### 6.4 Componentes que NO se reemplazan

`<AddressValidationBadge>` actual → mantener para superficies de solo-lectura (listados, tarjetas resumen). Solo se reemplaza en superficies de edición (CallView, EditOrderDialog).

### 6.5 Surfaces de integración (Fase 6)

| Surface | Componente | Reemplazo |
|---|---|---|
| `src/components/CallView.tsx` (en `/confirmar`) | `<AddressAutocomplete>` + `<AddressFeedbackCard>` + `<DespachoGateButton>` | Sí |
| `src/components/EditOrderDialog.tsx` | `<AddressAutocomplete>` + `<AddressFeedbackCard>` | Sí |
| `src/components/CrmCallView.tsx` (legacy) | `<AddressFeedbackCard>` solo | Parcial |
| `src/pages/OrderDetailPage.tsx` (read mode) | `<AddressValidationBadge>` actual | NO cambia |

## 7. Schema (migración)

**Tabla `orders`** — agrega (todas nullable, backwards-compat con Excel uploads):

```sql
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS barrio TEXT,
  ADD COLUMN IF NOT EXISTS complemento TEXT,
  ADD COLUMN IF NOT EXISTS documento_destinatario TEXT,
  ADD COLUMN IF NOT EXISTS google_place_id TEXT,
  ADD COLUMN IF NOT EXISTS lat NUMERIC,
  ADD COLUMN IF NOT EXISTS lng NUMERIC,
  ADD COLUMN IF NOT EXISTS validation_decision TEXT,
  ADD COLUMN IF NOT EXISTS address_kind TEXT,
  ADD COLUMN IF NOT EXISTS missing_fields JSONB,
  ADD COLUMN IF NOT EXISTS suggested_customer_message TEXT,
  ADD COLUMN IF NOT EXISTS address_parsed JSONB;

CREATE INDEX IF NOT EXISTS orders_google_place_id_idx ON orders(google_place_id);
CREATE INDEX IF NOT EXISTS orders_validation_decision_idx ON orders(validation_decision);
CREATE INDEX IF NOT EXISTS orders_phone_place_id_idx ON orders(phone) WHERE google_place_id IS NOT NULL;
```

**Tabla nueva `address_autocomplete_cache`** (Cache L2):

```sql
CREATE TABLE address_autocomplete_cache (
  id BIGSERIAL PRIMARY KEY,
  query_normalized TEXT NOT NULL,        -- lowercase, sin tildes, espacios colapsados
  ciudad_filter TEXT,
  suggestions JSONB NOT NULL,            -- array de sugerencias de Google
  hit_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,       -- 30 días desde creación
  UNIQUE (query_normalized, ciudad_filter)
);

CREATE INDEX address_autocomplete_cache_expires_idx ON address_autocomplete_cache(expires_at);
```

**Tabla `app_settings`** — keys nuevas:

- `google_api_daily_budget_usd` (default `'2.50'`)
- `google_api_used_today_usd` (resetea 00:00 Bogotá vía cron diario)
- `google_api_used_today_date` (`YYYY-MM-DD`)

**Decisiones cerradas:**
- NO `codigo_postal` (no se usa en COD Colombia)
- NO desagregar tipo_via/numero_placa en columnas separadas — guardar en `address_parsed JSONB`
- Mantener `direccion` como string libre canónico (no rompe Excel uploads)

Actualizar `DbOrderRow`, `OrderData`, `mapDbRow()` en `src/lib/orderUtils.ts`. Regenerar `src/integrations/supabase/types.ts`.

## 8. Cache de 3 capas

| Capa | Implementación | TTL | Hit rate esperado | $/llamada |
|---|---|---|---|---|
| **L1 Memory** | Map en `useGooglePlaces()` hook | sesión browser | ~30% | $0 |
| **L2 DB** | tabla `address_autocomplete_cache` con `query_normalized + ciudad_filter` | 30 días | ~50% | $0 |
| **L3 Recurrent customer** | query `orders WHERE phone=$1 AND google_place_id IS NOT NULL ORDER BY upload_date DESC LIMIT 1` | permanente hasta cambio manual | ~25% | $0 |

**Resultado combinado:** ~65% de las queries no llegan a Google API después de 3 meses de cache caliente.

**Normalización de query (para cache key):**
- lowercase
- eliminar tildes (`á → a`)
- colapsar espacios múltiples
- recortar al final
- Función pura testeable: `src/lib/addressNormalize.ts`

## 9. Manejo de errores

| Caso | Comportamiento |
|---|---|
| Google API key no configurada | `<AddressAutocomplete>` cae a input plain. Toast: "Autocomplete deshabilitado". Validación post-edit funciona vía edge function. |
| Google retorna 0 sugerencias | `Sin coincidencias en el mapa — escribir libre`. Validación post-edit decide. |
| Edge function `dropi-validate-address` cae | Fallback a `addressHeuristic.ts` local. `validation_decision='yellow'` con `localOnly: true`. Toast warning. |
| Token Google expirado / quota excedida | Igual que key inválida. Loguear en `sync_logs`. |
| Cuota mensual cerca del cap | Email + toast al admin a 80%. |
| Operadora selecciona del autocomplete y luego edita manualmente | Borra `place_id`, `lat`, `lng`. Vuelve a estado `unknown`. Re-valida al cerrar campo. |
| Pickup-office detectado por keyword | NO se exige autocomplete. Salta a `green` con `address_kind='pickup_office'`. |

## 10. Casos rurales (28% del volumen — política explícita)

1. **Detección rural en heurística:** keywords `manzana|mz|mza|lote|finca|vereda|corregimiento|km|kilometro|sector` ya en `addressHeuristic.ts` → `address_kind: 'rural'`, validation_decision **NO red**.

2. **Autocomplete no bloquea rural:** Google Places suele fallar; operadora click "no está en el mapa", escribe libre. La heurística rural-aware NO penaliza.

3. **Sugerencia de punto de referencia:** rural → `<AddressFeedbackCard>` muestra yellow con tip: "Recomendado: pedir punto de referencia (cerca a colegio X, frente a tienda Y)".

4. **Despacho gate permisivo en rural:** `canConfirmOrder()` solo bloquea `red`. Rural-yellow es confirmable con check "Confirmé con cliente".

## 11. Costo + cap diario + monitoring

### Estimación post-cache caliente (3 meses)

| Item | Volumen mes | Costo unitario | $/mes |
|---|---|---|---|
| Autocomplete sessions | ~525 (post-cache) | $0.017 | $8.93 |
| Place Details | ~525 | $0.005 | $2.63 |
| Address Validation (rural / no-autocomplete) | ~150 | $0.005 | $0.75 |
| Claude Haiku (decisión ambigua) | ~90 | $0.0005 | $0.05 |
| **Total** | | | **~$12.36/mes** |

A volumen 2x: ~$25-30/mes.

### Daily hard cap — solo para llamadas server-side

**Aplica a:** Address Validation API + Claude Haiku (las dos que pasan por `dropi-validate-address` edge function).
**NO aplica a:** Autocomplete + Place Details — son browser-direct (latencia ms importa). Esos quedan gobernados por GCP monthly cap + rate limit en browser (200 sesiones/día por usuario en localStorage).

Flujo del cap server-side dentro de la edge function:

```
1. SELECT used_today, budget FROM app_settings WHERE key IN (...)
2. used_today / budget >= 1.0?  → return { fallback: 'cap_exceeded' } sin llamar Google
3. used_today / budget >= 0.8?  → continúa pero loggea warning
4. Llamar Google Address Validation o Haiku
5. UPDATE used_today = used_today + costo_de_esta_llamada (atomic vía RPC consume_google_quota)
6. Devolver respuesta
```

### Cinco capas de protección (defensa en profundidad)

1. **Daily HARD cap server-side** $2.50/día en `app_settings.google_api_daily_budget_usd` — bloquea Address Validation + Haiku cuando se supera. Caer a heurística local.
2. **Browser rate limit autocomplete** max 200 sesiones/día en localStorage — corta autocomplete cuando se supera, cae a input plain.
3. **GCP hard cap mensual** $50/mes — Google rechaza con 403 cualquier llamada (autocomplete o validation).
4. **Billing alerts GCP** a $25 (50%) y $40 (80%).
5. **Restricción HTTP referrer** key Google solo desde `*.lovable.app` y `localhost`.

**Garantía:** ningún mes excede **$75 USD** combinado entre las 5 capas.

### Widget admin

`/admin` muestra widget con:
- Usado hoy: `$X / $Y`
- Llamadas: `N autocomplete + M details + K validation`
- Estimado fin de mes: `$Z`
- Indicador warning si supera 80% diario, indicador disabled si 100%

## 12. Fases de implementación

### Fase 0 — Documentation Discovery (1 día)
1. Confirmar `GOOGLE_MAPS_API_KEY` en Supabase secrets (pre-confirmado por usuario)
2. Confirmar Places API (New) + Address Validation API + Maps JS API habilitadas
3. Restringir key por HTTP referrer
4. Bajar catálogo DANE oficial (1.123 municipios desde datos.gov.co)
5. Probar `dropi-validate-address` con 50 direcciones reales (10 urbanas Bogotá/Medellín, 10 rurales Chocó/Nariño, 10 retiro-oficina, 10 manzana/lote, 10 raras)
6. Output: estado de APIs + tasa de match medida

### Fase 1 — Schema (2-3h)
- Crear migración `supabase/migrations/YYYYMMDDHHMMSS_validador_direcciones.sql` con ALTER TABLE de §7 + tabla `address_autocomplete_cache` + keys de `app_settings`
- Regenerar types.ts
- Actualizar `DbOrderRow`, `OrderData`, `mapDbRow()` en `src/lib/orderUtils.ts`
- Verificación: `npm run build` limpio, `npm run test` pasa

### Fase 2 — Funciones puras (3-4h)
- `src/lib/canConfirmOrder.ts` + tests con matriz
- `src/lib/addressNormalize.ts` + tests
- `src/lib/buildWhatsAppMessage.ts` + tests
- `src/lib/parseGooglePlace.ts` + tests
- `src/lib/mapAddressKind.ts` (urban/rural/pickup/unknown) + tests

### Fase 3 — Validador híbrido (extender edge function existente)
1. Capa pickup-office detection (regex)
2. Heurística rural-aware (extender `addressHeuristic.ts` y mirror en edge function — port intencional)
3. Mantener Google Address Validation
4. Agregar capa Haiku 4.5 condicional con prompt estructurado JSON
5. Persistir respuesta en `address_validations` + columnas en `orders`

**Anti-patrón:** Haiku para CADA pedido. SOLO cuando Google+heurística son ambiguos.

### Fase 4 — Daily cap + cache L2 (2-3h)
- RPC `consume_google_quota(amount NUMERIC) RETURNS BOOLEAN` (true=permitido, false=cap excedido). Update atomic.
- RPC `cleanup_expired_autocomplete_cache()` (cron diario)
- Cron Supabase: reset diario de `google_api_used_today_usd` a las 00:00 Bogotá
- **NO proxy de autocomplete.** El autocomplete corre browser-direct (rápido, sin latencia extra). El daily cap se enforce SOLO para llamadas server-side (Address Validation + Haiku) que pasan por `dropi-validate-address`. Autocomplete queda capeado por GCP monthly hard cap + rate limit local en browser (max 200 sesiones/día por sesión de usuario, en localStorage)

### Fase 5 — Componentes UI nuevos (1-2 días)
1. `<AddressAutocomplete>` con `useGooglePlaces` hook + cache L1/L2/L3
2. `<AddressFeedbackCard>` con 4 estados + botón Copiar WhatsApp + override admin
3. `<DespachoGateButton>` wrapper
4. Tests con jsdom

### Fase 6 — Integración en surfaces (1 día)
1. Reemplazar inputs de dirección en `CallView` por `<AddressAutocomplete>`
2. Insertar `<AddressFeedbackCard>` arriba/abajo del input según diseño
3. Reemplazar botón Confirmar por `<DespachoGateButton>`
4. Mismo en `EditOrderDialog`
5. `CrmCallView` solo recibe `<AddressFeedbackCard>` (sin autocomplete por ser legacy)

### Fase 7 — Catálogo DANE (medio día)
- Reemplazar `src/lib/colombiaGeo.ts` con datos DANE 1.123 municipios
- Mantener API pública `getCiudadesDe(departamento)` para no romper consumers
- Ciudad/departamento selects en formularios usan este catálogo

### Fase 8 — Widget admin de cuota (medio día)
- Hook `useGoogleQuota()` lee `app_settings`
- Componente `<GoogleQuotaWidget>` en `AdminTab`
- Actualización cada 60s

### Fases diferidas (NO ejecutar este sprint)
- Panel diagnóstico ya existe parcialmente como pestaña "Decisiones" en `/logistica` (commit `5329b0a`). Cualquier mejora narrativa adicional va en spec separado.
- Cobertura por transportadora — requiere datos externos.

## 13. Anti-patrones a evitar

- Regex monolítica que rechace direcciones rurales válidas (28% del volumen)
- Forzar barrio/complemento obligatorios en pedidos importados antes del release
- Inventar APIs (Lupap, codigos.zip) sin verificar existencia
- Bloquear `pickup_office` por falta de tipo de vía
- Llamar Haiku para CADA pedido (SOLO cuando Google+heurística no deciden)
- Mostrar el panel de insights en `/dashboard` (es admin, va en `/logistica`)
- Romper Excel uploads existentes
- Hardcodear API keys o no restringirlas por HTTP referrer en GCP
- Sin daily cap → riesgo de bill explosion
- Forzar autocomplete cuando Google falla en rural → operadora se traba

## 14. Testing

### Unit (Vitest, puros)
- `canConfirmOrder.test.ts` — matriz green/yellow/red × isAdmin × override × phone × Coordinadora ≥15 casos
- `addressNormalize.test.ts` — lowercase, tildes, espacios
- `buildWhatsAppMessage.test.ts` — combinaciones de missing_fields
- `parseGooglePlace.test.ts` — `address_components` → `{ direccion, barrio, address_kind }`
- `mapAddressKind.test.ts` — keywords rurales, urbanas, pickup-office

### Component (jsdom + Testing Library)
- `AddressAutocomplete.test.tsx` — debounce, sugerencias, click, "no está en el mapa", fallback sin key, banner Cache L3
- `AddressFeedbackCard.test.tsx` — 4 estados, botón Copiar WhatsApp, override admin
- `DespachoGateButton.test.tsx` — disabled con tooltip, habilitado cuando OK

### Integration / Smoke (manual al fin de implementación)
- [ ] CallView: tipear "Calle 8" → ver sugerencias urbanas
- [ ] Click en sugerencia → form se llena, badge verde
- [ ] Tipear "Vereda La Esmeralda" → "no hay coincidencias", click "escribir libre"
- [ ] Termina de tipear, blur → badge yellow con feedback rural
- [ ] Pedido `pickup_office`: tipear "Oficina Interrapidísimo Cali" → detección automática, badge "pickup_office"
- [ ] Pedido red: badge muestra missing_fields + botón copiar mensaje funciona
- [ ] Admin override: checkbox desbloquea botón confirmar
- [ ] Operadora normal sin override: botón disabled con tooltip
- [ ] Cargar pedido cuyo cliente ya tiene `place_id` → banner "misma dirección anterior" → click "usar esta" → pedido nuevo hereda place_id sin llamar Google
- [ ] Excedo cap diario → autocomplete deshabilitado, input plain funciona, toast informativo
- [ ] Excel upload con direcciones viejas → no rompe

## 15. Verificación final

1. `npm run build` limpio
2. `npm run test` 100% pasa
3. Grep checks:
   - Sin Input directos de dirección en CallView/EditOrderDialog (todos pasan por `AddressAutocomplete`)
   - `claude-haiku-4-5-20251001` solo en edge function, no en cliente
4. Manual smoke (lista §14)
5. Costo: alert GCP a $25 y $40, hard cap a $50

## 16. Decisiones cerradas en brainstorming (2026-04-29)

- Validador prioritario sobre WhatsApp pre-despacho
- Camino híbrido: heurística + Google + Haiku condicional
- Backwards-compat absoluto con Excel uploads y pedidos viejos
- Panel diagnóstico ya cubierto por pestaña "Decisiones" en `/logistica`
- Cobertura por transportadora se difiere
- Autocomplete en CallView + EditOrderDialog (B), no en TODAS las surfaces
- Política rural permisiva (mostrar siempre + botón "no está en el mapa")
- Cache de 3 capas (memoria + DB + customer recurrente) → 65% hit rate post-3-meses
- Daily hard cap $2.50 + 4 capas de protección → garantía $75/mes max
- Spec consolidada que reemplaza `2026-04-28-validador-direcciones-design.md`

## 17. Próximo paso

Pasar a `writing-plans` skill para generar plan de implementación phase-por-phase con tareas atómicas, criterios de aceptación, y tests por fase. El plan debe permitir ejecución por subagentes (uno por fase) sin re-leer este spec.
