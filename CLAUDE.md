# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **This file is the source of truth.** `AGENTS.md` and `README.md` are older and stale on several points — they still describe the pre-multitienda model (`app_settings.dropi_token`, "integration-key not Bearer"), a `mapDbRow()` mapper that no longer exists (it's `dbToOrderData`), a `/rescate` route that was removed, CO-only scope, and a 1-min cron. When they disagree with this file, this file wins.

## ⛔ REGLA #1 — NUNCA reescribir una función SQL copiándola del repo

**Las funciones desplegadas en la base DIFIEREN de las de `supabase/migrations/`.** Lovable
edita funciones directo en la base; el repo va atrás. Copiar un cuerpo del repo a un
`CREATE OR REPLACE` **revierte fixes vivos**.

Qué pasó (2026-07-21): se reescribió `upsert_orders_from_dropi` desde el repo. Esa copia ya
había perdido la columna `store_id`. Durante **2h30 los pedidos nuevos de Ecuador entraron
etiquetados como Colombia** y se mezclaron en la cola de una asesora. Fix: commit `6d1cdf8`.

**Mezclar países está PROHIBIDO en esta operación.**

Antes de proponer cualquier SQL: pedir el `pg_get_functiondef` de la función que está
corriendo y comparar. Si no se puede leer la versión desplegada, **decirlo y no entregar el
SQL**. La migración `20260721120000_scope_admin_fail_closed.sql` aplica esta misma regla:
el fix se puso solo en `_resolve_scope_store()` y NO en las ~5 RPCs que repiten el patrón
NULL, precisamente para no pisar sus versiones desplegadas.

Diagnóstico rápido de países cruzados: el largo del `external_id` delata el país —
**Ecuador 7 dígitos (`6xxxxxx`), Colombia 8 (`7xxxxxxx` / `8xxxxxxx`)**. Tiendas:
CO = `00000000-0000-0000-0000-000000000001` · EC = `512309c3-d5b7-4434-898a-31bed51dcd4d`.

## Commands

```bash
# Development
npm run dev          # Start Vite dev server
npm run build        # Production build
npm run build:dev    # Dev-mode build (useful for debugging)
npm run lint         # ESLint check
npm run test         # Run all tests once (Vitest)
npm run test:watch   # Run tests in watch mode

# Run a single test file
npx vitest run src/lib/orderUtils.test.ts

# Supabase Edge Functions (deploy individually)
supabase functions deploy dropi-sync
supabase functions deploy dropi-update-order
supabase functions deploy dropi-update-order-full
supabase functions deploy dropi-change-carrier
supabase functions deploy dropi-relay
supabase functions deploy dropi-refresh-order
supabase functions deploy dropi-resolve-incidence
supabase functions deploy dropi-fingerprint
supabase functions deploy dropi-cron
supabase functions deploy dropi-health
supabase functions deploy dropi-nightly-reconcile
supabase functions deploy dropi-snapshot
supabase functions deploy ai-order-assistant
supabase functions deploy dropi-validate-address
supabase functions deploy dropi-wallet-sync
supabase functions deploy google-places-proxy
supabase functions deploy shopify-push-dropi
supabase functions deploy shopify-reconcile
supabase functions deploy shopify-auto-push
supabase functions deploy parse-bank-pdf-text
supabase functions deploy dropi-open-incidences
supabase functions deploy dropi-refresh-batch
supabase functions deploy dropi-webhook
supabase functions deploy wa-webhook
supabase functions deploy wa-send
supabase functions deploy wa-ai-responder
supabase functions deploy wa-status-notifier
supabase functions deploy wa-mine-conversations

# Apply DB migrations
supabase db push

# Disparar wallet sync con rango custom (default = últimos 30 días)
curl -X POST "$SUPABASE_URL/functions/v1/dropi-wallet-sync" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $USER_JWT" \
  -d '{"from":"2026-01-01","to":"2026-05-02"}'
```

## Stack & Constraints

- **Frontend:** Vite + React 18 + TypeScript + Tailwind + shadcn/ui. Vite uses `@vitejs/plugin-react-swc` (SWC, not Babel). `lovable-tagger` is dev-only.
- **Dev server runs on port 8080** (not the default 5173/3000). Configured in `vite.config.ts`.
- **TypeScript is NOT strict.** `tsconfig.app.json` has `strict: false`, `noImplicitAny: false`, `noUnusedLocals: false`. Do not enforce strict-mode patterns when reviewing or refactoring — they are intentionally off.
- **Path alias:** `@/` → `./src/`.
- **Env vars read in `src/`:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and `VITE_ENABLE_CFO` (gates the `/cfo` route + nav item; only `'true'` registers it — external clients leave it unset and `/cfo` 404s). Copy `.env.example` → `.env`.
- **Feature flags live in `src/lib/featureFlags.ts`.** `GOOGLE_PLACES_ENABLED = false` (since 2026-05-22) — the Google Places autocomplete + the `dropi-validate-address`/`google-places-proxy` edge functions are NOT invoked from the app. The address semáforo runs 100% on the local heuristic (`src/lib/addressHeuristic.ts`). Flipping it back to `true` needs only a Publish, no edge-function redeploy.
- **Routes are lazy-loaded** in `src/App.tsx` via `React.lazy()`. Each route is wrapped in its own `ErrorBoundary` (`route()` helper), so a crash in `/confirmar` does NOT kill `/seguimiento` or the sidebar. This is intentional — keep the per-route boundary when adding new pages.
- **`DbOrderRow` lives in `src/integrations/supabase/types.ts`** (auto-generated from Supabase schema), not in `orderUtils.ts`. The mapper `dbToOrderData()` in `orderUtils.ts` consumes it.

## Operational Gotchas (Lovable)

- **Lovable does NOT auto-redeploy edge functions on `git push`.** Code in `supabase/functions/` ships to GitHub but the deployed runtime stays on the OLD version until someone explicitly redeploys (Lovable prompt or `supabase functions deploy`). Always design client-side fallback for any edge-function change you ship.
- **Lovable does NOT auto-apply migrations.** Files in `supabase/migrations/` need explicit `supabase db push` or a Lovable prompt. If `ORDER_COLUMNS` (`src/lib/orderColumns.ts`) references a column whose migration hasn't run, the SELECT explodes with `column X does not exist` and breaks every order-loading screen. Mitigation pattern: hotfix by removing the column from `orderColumns.ts` until the migration is applied.
- The DB row mapper is **`dbToOrderData`** (not `mapDbRow`) in `src/lib/orderUtils.ts`.
- **Dropi tokens — la integration-key permanente sirve para TODO (corregido 2026-05-22):**
  - `store_dropi_config.dropi_api_key` (multi-tienda; antes `app_settings.dropi_token`) — clave **INTEGRATIONS, permanente** (`exp` año 2126). Su `payload.sub` ES el dropi user_id (lo usan wallet/fingerprint en el query param). Configurado en `/admin → Credenciales Dropi`.
  - **⚠️ El esquema del header NO es uniforme — son TRES (verificado en código 2026-07-22):**

    | Endpoint | Header | Credencial |
    |---|---|---|
    | `/integrations/*` | `dropi-integration-key: <key>` | api_key |
    | `/api/wallet/exportexcel` | `x-authorization: Bearer <key>` | api_key (`cfg.apiKey \|\| cfg.sessionToken`) |
    | `/api/orders/myorders` (novedades) | session token web | **NO acepta la api_key** |

    Decir "va como Bearer" es incorrecto y era lo que afirmaba este doc: `/integrations/*`
    usa header propio (14 funciones lo hacen así), y el wallet usa `x-authorization`, no
    `Authorization`. Los hosts salen de `_shared/dropiHosts.ts` (`dropiHostFor(countryCode)`
    — CO `api.dropi.co`, EC `api.dropi.ec`), nunca hardcodeados.
  - `store_dropi_config.dropi_session_token` — JWT de sesión de `app.dropi.co` (vence ~1h). **LEGACY/opcional**: solo se usa como *fallback* (`cfg.apiKey || cfg.sessionToken`) si una tienda no tiene api_key. **Ojo:** el doc viejo afirmaba que exportexcel/fingerprint *requerían* este JWT — es FALSO (de hecho fingerprint con session_token da 401 "Invalid token"). Ya no hace falta refrescarlo a mano si la api_key está cargada.
- **Wallet sync default = últimos 30 días.** `supabase/functions/dropi-wallet-sync/index.ts:218-219` setea `defaultFrom = today - 30d`. Para histórico completo pasar body `{from, to}`. Critical when migrando o queriendo backfill — sin esto la wallet pierde meses anteriores.
- **Cliente-side calculations son más resilientes que migrations pendientes.** Patrón usado en `FinanzasTab.tsx`: cuando una migration agrega un campo nuevo al RPC pero aún no se aplica, el parser del hook coerce `undefined → 0` y el operador `??` no cae al fallback. Solución: calcular client-side desde campos que SÍ vienen (`flete_devoluciones + costo_devoluciones`), ignorar el campo del server. Funciona con cualquier versión del RPC.
- **⚠️ HAY DOS "dropi-relay" con roles OPUESTOS — no confundir:** (1) `supabase/functions/dropi-relay` = **INBOUND**, le presta la IP de Supabase (que rota) a un tercero externo; ver `RELAY_README.md`. (2) `vps/dropi-relay/` = **OUTBOUND**, un contenedor Deno en un VPS Hostinger (IP fija `2.25.69.238`, detrás de Caddy en `https://srv1784684.hstgr.cloud/dropi/`) para que **nuestras** llamadas a la API oficial de Dropi salgan por una IP whitelisteada; ver `vps/dropi-relay/README.md`. El relay del VPS vive SOLO en el VPS + copia versionada en `vps/dropi-relay/` — Lovable NO lo despliega. Toda la migración a la API oficial de integración (webhook + relay IP-fija) está documentada en la memoria `dropi_integration_api_oficial`.

## Lecciones de producción (sesión 2026-07-21)

- **"Corrió" y "funcionó" son dos preguntas distintas.** `useWalletSyncHealth` solo miraba
  *cuándo* corrió el cron, nunca *si guardó*: el badge marcaba verde mientras la billetera
  llevaba semanas muerta. Ahora existe el estado **`'failing'`** y manda sobre la frescura
  (`deriveStatus`: una corrida fallida hace 5 min es peor que una exitosa hace 6h). **Todo
  indicador de salud debe leer `status` + `error_message`, no solo el timestamp.** La fuente
  es `sync_logs` filtrando por `source` (`'dropi-wallet-sync'` para la billetera; el sync de
  ÓRDENES comparte tabla con `source='dropi'`).
- **Un string vacío en una columna UUID tumba el lote ENTERO.** `dropi-wallet-sync` pasaba
  `userId ?? ""` a `synced_by` (UUID nullable): Postgres respondía `invalid input syntax for
  type uuid: ""` y **rechazaba el batch completo, en todas las corridas y en las dos tiendas**.
  El cron dispara sin usuario autenticado, así que era siempre. Correcto: `syncedBy || null`.
  Al recuperar el histórico, EC pasó de 265 a 5.880 movimientos y CO a 1.725 — **las cifras de
  julio cambiaron**: antes se veía menos de un cuarto de la operación.
- **Un pedido BORRADO en Dropi NO es una cancelación del cliente.** `dropi-nightly-reconcile`
  los marcaba `CANCELADO` e inflaba la tasa de cancelación. Ahora marca **`ARCHIVADO GHOST`
  — CON ESPACIO**: es la escritura que reconoce `_estado_bucket` en SQL; con guion bajo
  (`ARCHIVADO_GHOST`) **NO se excluye** y vuelve a contaminar la métrica. Ojo: el guion bajo sí
  aparece en varios mapas de TS (`estadoBuckets.ts`, `segStatus.ts`) por compatibilidad, pero
  **lo que se ESCRIBE es con espacio**. Tras corregir 126 filas, julio EC quedó: cancelados
  250 → 152 contra 154 de Dropi; entregados 216 = 216; devoluciones 70 = 70.
- **Ficha de producto: UN solo componente.** `ProductoTile.tsx` dibuja talla/color (desde
  `orders.productos_detalle`, jsonb por línea, que llena `dropi-cron`) y lo usan **Confirmar y
  Seguimiento**. Antes eran dos copias y se arregló una sola — el bug reapareció en la otra
  pantalla. No volver a duplicarlo.
- **Guardian no inventa datos** (auditado 2026-07-21 contra un Excel oficial de Dropi): 380
  pedidos comparados uno por uno, CERO desacuerdos. Lo que tenía era de *más* (reemplazados +
  borrados), no de menos. Antes de sospechar de los datos, mirar si el estado es un soft-delete.

## Architecture Overview

**Guardian First Admin** is a React/TypeScript CRM for COD (Cash-on-Delivery) e-commerce operators that integrates with the Dropi carrier platform. It is **multi-tienda** (one app, many stores) and **multi-country** (Colombia + Ecuador) — see the "Multi-Country" section below.

### Data Flow

1. **Excel upload** → `ExcelUploader` parses columns via `COL_MAP` in `src/lib/constants.ts` into `OrderData[]`
2. **StoreContext** (`src/contexts/StoreContext.tsx`) resolves the user's active store (`activeStoreId`); **everything downstream is store-scoped.** `OrderContext` passes `activeStoreId` into `useDataLoader`/`useNovedades`, and the queries filter `.eq('store_id', activeStoreId)`. A null `activeStoreId` (first load) means "don't fetch yet" — guard with `if (!storeId) return;`.
3. **OrderContext** (`src/contexts/OrderContext.tsx`) holds all in-memory order state for the session; it wraps `useDataLoader` (Supabase DB queries for Seguimiento) and `useNovedades` (active incidences)
4. **Supabase Edge Functions** sync/update orders from the Dropi API and are called from the UI via `supabase.functions.invoke()`
5. **Supabase project ID**: `bokhlpfmttoizjaakntc`

### Page / Tab Map

| Route | Page | Tab Component | Purpose |
|---|---|---|---|
| `/confirmar` | ConfirmarPage | ConfirmarTab | Call queue — confirm/cancel orders |
| `/seguimiento` | SeguimientoPage | SeguimientoTab | Track dispatched orders + dropdown "Listas SLA" estilo Boostec (8 listas pre-clasificadas por estado + días hábiles). Config en `src/lib/segLists.ts`. Lista activa persiste en URL (`?lista=...`) + sessionStorage. |
| `/novedades` | NovedadesPage | NovedadesTab | Resolve carrier incidences |
| `/admin` | AdminPage | AdminTab | Config por tienda. Gated `managerOnly` (owner/supervisor de la tienda activa). |
| `/dashboard` | DashboardPage | DashboardTab | KPI metrics |
| `/logistica` | LogisticsPage | LogisticaTab | Análisis: 8 sub-tabs (Resumen / Transportadoras / Ciudades / Productos / Decisiones / Trazabilidad / Billetera / Finanzas). Gated `managerOnly`. Tab activa persiste en `useSessionState('logistica:tab')`. Filtros globales (fecha, ciudad) se aplican a todas. |
| `/cfo` | CfoPage | CfoTab | Vista "Cómo voy" del dueño. **Triple gate:** ruta solo se registra si `VITE_ENABLE_CFO==='true'`, nav item es `adminOnly` (global `isAdmin`, no rol de tienda), y se oculta si `activeStore.country_code !== 'CO'`. RLS admin-only en la DB es el backstop. Reusa `financial_summary` + `logistics_summary` + `wallet_summary` + `product_profitability` y combina con inputs manuales mensuales (costos fijos, deuda TC, gasto pauta) vía hooks `useCfoMonthlyInputs` + `useTcDebtSnapshots` + `useMonthlyAdSpend` para calcular UTILIDAD NETA REAL. |
| `/pedido/:externalId` | OrderDetailPage | order-detail/* | Single-order drill-down (param es `:externalId`, no `:id`) |

All authenticated routes share `ProtectedLayout`, which nests `StoreProvider → ProtectedLayoutInner → OrderProvider`. `ProtectedLayoutInner`:
- Blocks render while `auth.loading || store.loading` (first load only — see "single-app-mount" note below).
- Branches: no session → `/auth`; member of zero stores → "Sin tiendas asignadas" screen; `store.needsSetup` (owner + active store has no `dropi_api_key`) → `<SetupWizard>`.
- Renders the sidebar with `<StoreSelector>` and the store brand name/logo, filters `NAV_ITEMS` by gate (see below), and wraps the outlet in **`<WelcomeGate>`**. Shows `CounterBar` only on `/confirmar`.
- **⚠️ `OpeningReportGate` está MUERTO** (2026-07-19). El archivo sigue en el árbol pero `ProtectedLayout` ya no lo usa — solo queda un comentario donde estaba. Era un formulario de 4 pasos que BLOQUEABA (`fixed inset-0` sin Esc; una auditoría lo marcó como trampa de teclado). `WelcomeGate` lo reemplazó: no bloquea, una vez por día Bogotá vía localStorage (F5 no lo repite) y se muestra a todos, admin incluido. **Costo aceptado explícitamente:** las columnas `pedidos nuevos` / `guías de ayer` / `pendientes de ayer` de `/admin → Reportes diarios` y del CSV quedan vacías desde esa fecha. Desde `20260720120000` la **apertura la sella el heartbeat**, no un formulario (`COALESCE` preserva la PRIMERA marca del día, así reabrir el CRM no la pisa). El cierre diario sigue siendo manual y no se tocó.
- La lógica pura de apertura vive en `src/lib/aperturaTurno.ts` (`decidirApertura({esAdmin, marcaEntrada, ahora})`). Se extrajo porque **el dueño es admin y los admins no marcan entrada — el camino de la operadora no se puede ejercitar en su navegador**, así que se testea en vez de probarse a mano. Reglas: a un admin se lo saluda pero nunca se le muestra chip de turno (sería mentira); marca del server ausente/corrupta → saludar sin hora (NUNCA derivar la hora del reloj local); y si `first_action_at` es más viejo que `VENTANA_APERTURA_MS` (90s) es **re-entrada, no apertura** → ni saludo ni chip.
- Redeems pending store invites: a `?invite=TOKEN` from `/auth` is stashed in `localStorage('guardian.pendingInvite')` and consumed once via the `redeem_store_invite` RPC.

### Auth & Roles — TWO independent layers

This is the most common source of confusion. There are **two role systems**; do not conflate them:

1. **Global platform admin** — `AuthContext` (`src/contexts/AuthContext.tsx`) reads `profiles` + `user_roles`. `isAdmin = user_roles.some(r => r.role === 'admin')`. This is essentially Fabian (the platform operator). It gates **only `adminOnly` items (CFO)**. The ref guard `profileFetchedFor` prevents double-fetch on fast connections.
2. **Per-store membership** — `StoreContext` (`src/contexts/StoreContext.tsx`) reads `store_members` + `stores`. Per-store role ∈ `owner` · `supervisor` · `operator` (strongest wins on duplicate rows, `ROLE_RANK`). Derived: `isOwnerOfActive`, `isManagerOfActive` (owner OR supervisor), `needsSetup`. This gates **`managerOnly` items (Admin, Logística)** and store-scoped data via RLS.

So: Admin/Logística → `managerOnly` (store role). CFO → `adminOnly` (global role) + `VITE_ENABLE_CFO` + `country_code==='CO'`. Confirmar/Seguimiento/Novedades/Dashboard → all members.

**Single-app-mount invariant:** `AuthContext` keeps the SAME `user` object reference across `TOKEN_REFRESHED` events (only `session` updates). If `user`'s reference changed on every token refresh, `StoreContext.refresh` (`useCallback([user])`) would re-run, set `store.loading=true`, and `ProtectedLayout` would unmount the whole app — operators "lose their place / the CRM restarts". `StoreContext` likewise only sets `loading=true` on the FIRST load (`hasLoadedRef`). Preserve both guards when touching auth/store.

`activeStoreId` persists in `localStorage('guardian.activeStoreId')`. RLS on `orders` and most tables is now **store-scoped** (`store_id` + membership), layered on top of the older `auth.uid()` operator policies — see migration `20260521010000_multitienda_sp2_upsert_store_id.sql` and `20260522010000_store_supervisor_role_selfcontained.sql`.

### Multi-Country (CO + EC)

Each store has a `stores.country_code` ∈ `'CO'` (default) · `'EC'`. The active store's country drives **carrier tracking URLs, phone normalization, and the address heuristic** — all in `src/lib/`. Pure utils stay pure: they take an optional `countryCode?` param and default to `'CO'`, so existing CO call-sites and the 55 CO tests are untouched.

- **Tracking URLs** (`getTrackingUrl(carrier, guia, countryCode?)` in `orderUtils.ts`): `CARRIER_TRACK` (CO) is the default map; `CARRIER_TRACK_EC` (GINTRACOM, LAARCOURIER, Servientrega EC) is **merged over** it for EC. `SERVIENTREGA` exists in BOTH countries with different URLs — that collision is the whole reason tracking is country-scoped. Carriers whose URL ends in `=` get the guía appended.
- **Module-level country state:** `getTrackingUrl` reads a module-level `_activeTrackingCountry` (default `'CO'`) when no explicit param is passed. `StoreContext` keeps it in sync via `setTrackingCountry(activeStore?.country_code)` in a `useEffect` (StoreContext.tsx:128). This is the **same module-level-state pattern** as the address-validator `Set<string>` overrides — set once from context, read by pure functions without threading the value through every call-site.
- **Phones** (`normalizePhoneForCountry` / `isValidPhoneForCountry` / `getWhatsAppPhone`): CO prefixes `57`, EC prefixes `593` (`normalizeEcuadorianPhone` strips a leading `0`). `getWhatsAppPhone` is what builds `wa.me/` links.
- **Address validation:** `heuristicValidate(direccion, countryCode?)` and `buildAddressSuggestion(..., countryCode?)` have EC branches. Pass the active store's `country_code` when calling from order screens.
- **Geografía del editor de pedidos es country-aware** (`CustomerForm.tsx`, el editor unificado): CO usa el catálogo DANE `src/lib/colombiaGeo.ts` (dropdown Departamento + Ciudad); EC usa `src/lib/ecuadorGeo.ts` (`PROVINCIAS_ECUADOR`, las 24 provincias con `<datalist>` de sugerencias) + **ciudad/cantón como texto libre** (Dropi valida su lado; evita mismatch de nombres/casing). `CustomerForm` lee el país vía `useStore()`. **NO hardcodear geografía de un solo país en formularios de dirección** — este fue exactamente el bug de "Ecuador mostraba departamentos de Colombia" (commit 4289aa5). El `PushToDropiModal` NO usa este catálogo (trae ciudades del catálogo de Dropi en vivo).
- **CFO is CO-only** (`activeStore.country_code === 'CO'`) — see its triple gate above.

### Key Domain Types

- `OrderData` — canonical in-memory order shape (`src/lib/orderUtils.ts`)
- `DbOrderRow` — raw Supabase DB row (nullable fields); mapped to `OrderData` via `dbToOrderData()` in `src/lib/orderUtils.ts` (there is no `mapDbRow`)
- `COL_MAP` — multi-alias Excel column mapping (`src/lib/constants.ts`)
- `CARRIER_TRACK` (CO) / `CARRIER_TRACK_EC` (EC) / `CARRIER_TRACK_BY_COUNTRY` — per-carrier tracking URLs, resolved by country via `getTrackingUrl` (see Multi-Country). `CARRIER_DEADLINES` — per-carrier SLA days

### Supabase Edge Functions

All functions are Deno (TypeScript). They live in `supabase/functions/`:
- `dropi-sync` — bulk-fetches orders from Dropi API, chunked in ≤89-day ranges, upserts to DB. Maps `o.shipping_amount` → `costo_logistico_dropi` (lo que paga el dropshipper, NO lo cobrado al cliente). Uses Bearer API key.
- `dropi-update-order` — updates a single order's Dropi status (bearer token from DB settings)
- `dropi-update-order-full` — variant that also pushes back enriched address/notes payload to Dropi
- `dropi-refresh-order` — refresca UN pedido en vivo desde la API Dropi (`GET /integrations/orders/{external_id}`) y lo upsertea en `orders` por `external_id`. Disparado por el botón "Refrescar desde Dropi" en `CrmCallView`/`OrderCard` de Seguimiento (hook `useRefreshOrder`) para dar parity inmediata sin esperar al cron de 5 min (que en EC puede ir throttleado). Auth = JWT del miembro (valida `isStoreMember`). El UPDATE viaja a todos los clientes vía el realtime existente sobre `orders`. Devuelve `{ok, estado, guia, transportadora, rateLimited?}`. Comparte el mapper `mapDropiOrderToRow` (`_shared/dropiOrderMapper.ts`) con `dropi-sync` y `dropi-nightly-reconcile`.
- `dropi-change-carrier` — cambia la transportadora de un pedido pendiente desde Confirmar. `mode:"quote"` lee los productos del pedido (GET integrations por id) y cotiza en vivo vía `quoteCarriers` (`_shared/dropiWebQuote.ts`, session token web) → lista transportadoras + precio; `mode:"apply"` reasigna en Dropi vía `PUT /integrations/orders/myorders/{id}` con `{distribution_company_id}` (integration-key) + actualiza `orders.transportadora` + audita en `order_results` (`result:'cambio_transportadora'`). Solo sin guía generada. **OJO FASE 0:** el campo `distribution_company_id` del PUT es el candidato a confirmar — si Dropi lo rechaza, ver `dropiHttpStatus`/`dropiBody` y capturar el request real del panel. La cotización depende del `dropi_session_token` (legacy, vence ~1h).
- `dropi-relay` — generic proxy/relay to Dropi endpoints from the client (avoids CORS + hides session token)
- `dropi-refresh-batch` — el botón "Sincronizar Dropi" de Seguimiento. **Usa el endpoint de LISTA (~1 request por 200 pedidos), NO uno por pedido** — la versión per-order disparaba 429 y sincronizaba cero (fix 2026-06-23). UPSERTea (a diferencia de `dropi-snapshot`, que es read-only), así que el realtime existente mueve el tablero solo. Ventana default 10 días por "FECHA DE CAMBIO DE ESTATUS", backoff exponencial y presupuesto de 60s.
- `dropi-open-incidences` — devuelve los `external_id` con novedad **abierta AHORA** en Dropi. Existe porque un pedido puede quedar en estado `NOVEDAD` sin incidencia abierta (la transportadora la cerró/venció) y Dropi rechaza resolverla; Novedades usa esta lista para partir "Por gestionar" vs "Esperando transportadora". **Usa el session token web** — `/api/*` rechaza la integration-key. Siempre HTTP 200: si falla, el cliente degrada a una sola lista sin romperse.
- `dropi-resolve-incidence` — resolves a novedad on Dropi and marks it in DB
- `dropi-fingerprint` — generates a customer fingerprint for repeat-buyer detection
- `dropi-cron` — scheduled sync trigger (cada 5 min, ver migration `20260427140000_dropi_cron_revert_to_5min.sql`). **Resiliente a "zombie state":** intenta una cadena `STATUS_FILTER_VARIANTS` y persiste el ganador en `app_settings.dropi_winning_status_filter`. Si todos los filtros vuelven 0 sin error/throttle, marca `status='warn'` (no `success`) para que el banner de freshness pueda detectar "corre pero no trae nada". Ver `PLAN-PARITY-DROPI.md`.
- `dropi-health` — ping read-only por tienda contra `/integrations/orders/myorders` (page=1). Escribe `last_health_status` en `store_dropi_config` cada hora. Alimenta el banner `SyncFreshness` (verde=OK 24h, amarillo=zombie, rojo=error). Usa el `dropi_winning_status_filter` calculado por `dropi-cron`.
- `dropi-nightly-reconcile` — reconciliación diaria 3am UTC. Cancela huérfanos `PENDIENTE CONFIRMACION` con `external_id < 5M` que no se mueven hace +N días y barre divergencias estado-Guardian vs Dropi. Defensa contra zombies que sobreviven al cron.
- `dropi-webhook` — **INBOUND**: recibe los POST de cambio de estado de la **API OFICIAL de Integraciones** de Dropi (real-time, reemplaza polling para pedidos creados vía nuestra integración shop_type "Guardian"). Público (`verify_jwt=false`) pero **fail-closed** con `DROPI_WEBHOOK_SECRET` (header `x-dropi-secret`). UPDATE dirigido por `external_id` (estado/guía/transportadora, sella `fecha_conf`) sin pisar `valor/flete/costo_prod` (payload parcial); INSERT insert-only por si el pedido no existe. Siempre 200 salvo secreto inválido. La API oficial saliente (prod, IP whitelisteada) se enruta por el relay de IP fija del VPS — ver `vps/dropi-relay/README.md` y la memoria `dropi_integration_api_oficial`.

  **ESTADO (2026-07-22): la función existe y responde, pero el webhook NO está activo.** Falta
  (a) configurar `DROPI_WEBHOOK_SECRET` — sin él la función devuelve **401 a todo**, es
  fail-closed a propósito; (b) que Dropi registre la URL; (c) confirmar que la IP fija
  `2.25.69.238` esté whitelisteada.

  **⛔ BLOQUEANTE CON RIESGO DESTRUCTIVO — resolver ANTES de tocar la clave:** no está
  verificado si el token de la integración tipo `GUARDIAN` (el `shop_type` está confirmado en
  el panel de Dropi) lee **TODAS** las órdenes de la cuenta o **solo las suyas**. Si es solo
  las suyas y se reemplaza la clave actual, **se vacía el CRM**. Prueba segura antes de
  cambiar nada: consultar `/integrations/orders/myorders` con la clave nueva **sin guardarla**
  en `store_dropi_config` y comparar el total contra el de la clave actual. Si coinciden, lee
  todo; si la nueva devuelve mucho menos, NO cambiarla.

  **NO apagar el cron de 5 min** hasta ver el webhook andando varios días en paralelo.
- `dropi-snapshot` — proxy server-side de auditoría: recibe `{store_id, from, to}`, pagina `/integrations/orders/myorders` (PAGE_SIZE 200, MAX_PAGES 30, backoff 2s/4s/8s en 429), filtra por `dropi_winning_status_filter` con fallback a "FECHA DE CAMBIO DE ESTATUS", devuelve `{orders, partial, message}`. Llamado por `DropiAuditModal` para comparar Dropi vs Guardian guía-por-guía. Existe por CORS — `api.dropi.co/ec` no permite fetch desde el browser.
- `dropi-validate-address` — multi-layer address validator (Google Places + Haiku optional). Quota gating via `consume_google_quota`. **NOTE: currently NOT called from the app** (`GOOGLE_PLACES_ENABLED = false`); the function still exists but is dormant.
- `dropi-wallet-sync` — descarga XLSX desde `/api/wallet/exportexcel`, parsea con SheetJS y upserta movimientos. Usa `mapCategoria()` para clasificar cada movimiento por código (regex + `normalizeCodigo` strip-accents). Default range = últimos 30 días — pasar body `{from, to}` para histórico. Usa `cfg.apiKey || cfg.sessionToken` (la api_key permanente funciona; el session_token es fallback legacy). Decodifica `payload.sub` del token para el query `user_id`.
- `google-places-proxy` — proxy server-side a Google Places autocomplete + details. Quota gating + cache en `address_autocomplete_cache`. Dormant mientras `GOOGLE_PLACES_ENABLED = false`.
- `ai-order-assistant` — Claude-powered order assistant
- `shopify-push-dropi` — sube un pedido de Shopify a Dropi (anti-fuga). Resuelve el producto Dropi leyendo el metafield `dropi/_dropi_product` que Dropify deja en cada producto Shopify. `mode: "preview"` arma cliente+productos+total sin crear nada; `"confirm"` crea la orden (`POST /integrations/orders/myorders`) y registra en `shopify_pushed_orders` (idempotente). Auth = JWT de miembro de la tienda. La secuencia de cotización web (A–D: product/show → locations → getOriginCity → cotizaEnvioTransportadoraV2) vive en `_shared/dropiWebQuote.ts` (`quoteCarriers`) y la comparte con `dropi-change-carrier`; al crear sigue eligiendo la más barata ≠ VELOCES.
- `shopify-reconcile` — detecta pedidos de Shopify que NUNCA llegaron a Dropi cruzando por TELÉFONO (últimos 9 dígitos) contra `orders`. Body `{store_id, days?=3}`. Alimenta la cola anti-fuga.
- `shopify-auto-push` — robot de cron (**cada 15 min**, migration `20260718140000`) que sube a Dropi solo los pedidos Shopify LIMPIOS de tiendas con `auto_push_enabled`. La selección vive en `_shared/autoPushSelect.ts`: con teléfono, pasada una gracia de 30 min (deja que Dropify lo suba primero), menos de 3 días, no existente en Dropi, sin intento previo. **Sube llamando a `shopify-push-dropi` en `mode:"confirm"`**, así siguen aplicando todos los locks (anti-duplicado por teléfono, anti-sobreprecio, idempotencia) — el robot nunca fuerza nada; lo bloqueado cae al panel manual. Auth `x-cron-secret`. Body `{store_id?, dry_run?}`.
- `wa-webhook` · `wa-send` · `wa-ai-responder` · `wa-status-notifier` · `wa-mine-conversations` — el bot de WhatsApp; ver la sección "Bot de WhatsApp & gateway" más abajo. Dos datos operativos que no están ahí: **`wa-status-notifier`** (pg_cron ~10 min) escribe en la PRIMERA aparición de un pedido una fila baseline en `wa_order_notifications` **sin enviar nada** — así no bombardea el histórico; solo notifica transiciones posteriores. Tope `MAX_SENDS_PER_RUN = 40` y ventana `SEND_HOUR_END = 21` (08:00–21:00 Bogotá) que **aplica SOLO a envíos proactivos** — las respuestas reactivas del bot van 24/7. **`wa-send`** (botón manual de la asesora) escribe además un touchpoint `WHATSAPP: ...` con `operator_id`; el camino de la IA NO escribe touchpoints.
- `parse-bank-pdf-text` — recibe el TEXTO plano de un extracto Bancolombia (Mastercard/Amex) — el cliente extrae el texto con `pdfjs-dist` en `CfoPersonalCardUploader.tsx`, porque pdfjs server-side no corre bien en edge — y devuelve movimientos categorizados; opcionalmente upserta. Alimenta el módulo de tarjeta personal del CFO.

Las credenciales Dropi son **por tienda** en `store_dropi_config` (`dropi_api_key` = INTEGRATIONS permanente; `dropi_session_token` = JWT de sesión legacy/fallback). Se leen en runtime vía `loadStoreConfig` (`_shared/dropiStoreConfig.ts`), NUNCA hardcoded. (El viejo `app_settings.dropi_token`/`dropi_session_token` era el modelo single-tenant previo.) Las credenciales **Shopify** viven en `store_shopify_config` y se leen vía `loadShopifyConfig` + `getShopifyAccessToken` (`_shared/shopifyStoreConfig.ts`) — usa client-credentials grant (token 24h auto-refresh; pegar un `shpss_` da 401). Todas las edge functions multi-tienda validan membresía con `isStoreMember` antes de tocar datos.

### Wallet Categorías (`mapCategoria` en `dropi-wallet-sync/index.ts`)

`dropi_wallet_movements.categoria` se llena vía regex sobre `codigo` (uppercase + NFD-stripped). Categorías válidas:

| Categoría | Patrón en código Dropi | Tipo típico | Significado |
|---|---|---|---|
| `flete_inicial` | `FLETE INICIAL` | SALIDA | Cargo al generar la guía |
| `cobro_entrega` | `CAMBIO DE ESTATUS` | ENTRADA | (raro) Cobro neto al entregar |
| `ganancia_dropshipper` | `GANANCIA` + `DROPSHIPPER` | ENTRADA | Markup que Dropi te paga por orden entregada |
| `ganancia_proveedor` | `GANANCIA` + `PROVEEDOR` | ENTRADA | Markup como proveedor |
| `reembolso_flete` | `DEVOLUCION` + `ORDEN ENTREGADA` | ENTRADA | Dropi devuelve flete inicial cuando entregó |
| `costo_devolucion` | `DEVOLUCION` + `NO EFECTIV` | SALIDA | Cargo extra cuando NO entregó (~$22k típico) |
| `comision_referidos` | `COMISION DE REFERIDOS` | SALIDA | Comisión a referidor |
| `mantenimiento_tarjeta` | `MANTENIMIENTO` + `TARJETA` | SALIDA | $12.5k/mes por tarjeta virtual |
| `indemnizacion` | `INDEMNIZACION` | ENTRADA | Compensación cuando proveedor no despacha |
| `retiro` | `TRANSFERENCIA` + `AL USUARIO` | SALIDA | Retiro a cuenta bancaria propia |
| `deposito` | `TRANSFERENCIA` + `DESDE EL USUARIO` | ENTRADA | Recarga manual |
| `orden_sin_recaudo` | `NUEVA ORDEN` | SALIDA | Cargo por nueva orden sin recaudo aún |
| `otro` | catch-all | — | Sin clasificar (revisar y agregar regex si es recurrente) |

**Si Dropi cambia el texto de un código,** el regex falla y el movimiento cae en `otro`. Diagnóstico: `SELECT codigo, COUNT(*) FROM dropi_wallet_movements WHERE categoria='otro' GROUP BY codigo;`. Después agregar pattern a `mapCategoria` Y crear migration `UPDATE` para re-categorizar movimientos viejos (patrón `20260502000005_recategorize_wallet_movements.sql`).

### Bot de WhatsApp & gateway (multi-proveedor: Whapi / Evolution)

El bot "renta el caño, no el cerebro": el inbox + la IA viven en Guardian; el transporte (conexión a WhatsApp) lo provee un gateway QR detrás de **una sola interfaz agnóstica** `supabase/functions/_shared/waTransport.ts` (`WaTransport`: `sendText` + `parseInbound`). Implementados: **`WhapiTransport`** (Whapi.cloud, base `gate.whapi.cloud`, Bearer) y **`EvolutionTransport`** (Evolution API self-host: base = server propio, header `apikey`, opera por **instancia**; `POST /message/sendText/{instance}`, webhook `messages.upsert`). `cloud_api` queda como escape hatch. Swap de proveedor = registrar el canal con otro `provider` — **NO se toca** `wa-webhook`/`wa-send`/`wa-ai-responder`/inbox/realtime (todo agnóstico, store-scoped).

- **Canal por tienda** en `wa_channels` (`provider`/`instance_name`/`provider_token`/`provider_base`/`status`). Se registra desde **`/admin → Canales WhatsApp`** (`WaChannelsPanel.tsx` → RPC `upsert_wa_channel`, owner-only). El token es secreto (lo lee la edge function con service role). `loadWaChannel` (`_shared/waChannel.ts`) arma el transporte y pasa `instanceName` (Evolution lo necesita). **Un canal = una tienda** (toma el más reciente por `updated_at`); si una tienda necesitara 2 números habría que pasar `?channel_id=` en el webhook.
- **Contrato del webhook ENTRANTE** (`wa-webhook`, público, idempotente): el gateway debe POSTear a
  `=<SUPABASE_URL>/functions/v1/wa-webhook?secret=<WA_WEBHOOK_SECRET>&store_id=<UUID tienda>`.
  Secreto **global** (`WA_WEBHOOK_SECRET`, query `?secret=` o header `x-wa-secret`); el `store_id` resuelve la tienda → su provider → el `parseInbound` correcto. **Evolution:** configurar evento `messages.upsert` y **`webhookByEvents = false`** (si mete el nombre del evento en el path, rompe el query `?store_id=`). Grupos/difusión se ignoran.
- **Audio (notas de voz) + media sin texto — el bot NO se queda mudo (2026-06-26):** el filtro viejo `m.body` descartaba todo mensaje sin texto → una nota de voz no llegaba ni al inbox ni al bot. Ahora el filtro deja pasar `(m.body || m.media)`. `wa-webhook` graba YA el mensaje (con marcador si es media → idempotencia + la asesora lo ve) y responde rápido; en **background** (`EdgeRuntime.waitUntil`): si es AUDIO (`isAudioKind`), descarga el binario con `transport.fetchMediaBase64(id)` (Evolution: `POST /chat/getBase64FromMediaMessage/{instance}`) y lo TRANSCRIBE vía **kie.ai** (`_shared/waTranscribe.ts`, modelo `elevenlabs/speech-to-text` por su **job API** `createTask`→`recordInfo`), **reutilizando la MISMA key del bot `WA_AI_API_KEY`** (Claude NO procesa audio; por eso STT aparte). kie.ai pide el audio como URL → se sube a Supabase Storage (bucket `wa-audio`, **auto-creado** por la función) y se pasa una signed URL; se borra tras transcribir. El texto reemplaza el body (`🎧 …`) y RECIÉN AHÍ se dispara la IA (razona sobre lo que dijo el cliente). Otros media (foto/archivo/ubicación) → marcador legible (`_shared/waMedia.ts` `mediaMarker`). Falla de STT → marcador, el bot igual responde. Config opcional: `WA_STT_MODEL`, `WA_STT_INPUT_FIELD` (default `audio_url`), `WA_KIE_BASE`. **Cero keys/migraciones nuevas** — solo redeploy de `wa-webhook`. Visión de imágenes (Claude LEA la foto del comprobante) queda como fast-follow.
- **Guard `@lid` (`isLidJid` en `waTransport.ts`):** si el JID entrante llega como `@lid` (privacidad, sin resolver), `onlyDigits` daría dígitos basura → conversación fantasma + el bot respondiendo a un número inexistente = pérdida SILENCIOSA del cliente (auditoría 2026-06-26). `parseInbound` marca `isLid` y `wa-webhook` los OMITE con `console.warn` (visible, no silencioso). Resolver LID→teléfono es trabajo aparte.
- **Minería agnóstica** (`wa-mine-conversations`): para `provider='whapi'` lee el historial de la API de Whapi (`/chats` + `/messages/list`); para los demás lee de **`wa_messages`** (lo que el webhook/inbox ya guardó). Cron diario re-agendado en `20260626130000` (filtra `provider IN ('whapi','evolution')`).
- **Multi-número (CO + EC + personal):** cada número = su propia instancia Evolution en el server. CO/EC son **tiendas distintas** con su canal (bot activo). El número **personal** corre como instancia en el mismo server pero **fuera de Guardian** (no se registra como canal, sin bot).

### Key RPCs (Supabase DB Functions)

- `get_daily_operator_stats(p_date)` — returns per-operator KPI counts for the dashboard (admin-only)
- `dropi_fingerprint(phone)` — repeat-buyer detection
- `confirm_order_locally(p_order_id)` — atomic local confirmation that bypasses lock-expiry RLS issues
- `cancel_orphan_pending_orders()` — cancels stale `PENDIENTE CONFIRMACION` rows superseded by a new Dropi-synced order within 48h
- `claim_seg_order(p_order_id)` / `release_seg_order(p_order_id)` — claim/release helpers used by the Seguimiento queue
- `logistics_summary(from_date, to_date)` — KPIs globales (total/entregados/devueltos/valor)
- `logistics_by_carrier(from_date, to_date, min_orders)` — métricas por transportadora
- `logistics_by_city(from_date, to_date, min_orders, limit)` — top ciudades por tasa de devolución
- `logistics_by_product(from_date, to_date, min_orders, limit)` — top productos con peor tasa de entrega
- Todas SECURITY DEFINER + admin-only. Ver migration 20260427130000.
- `consume_google_quota()` — atomic daily-cap check for Google Places calls (FOR UPDATE row lock to avoid races). Used by `dropi-validate-address` and `google-places-proxy`. Cap configured in `app_settings.google_quota_daily_cap`. See migration `20260501000000_validador_direcciones.sql`.
- `cleanup_expired_autocomplete_cache()` — purges `address_autocomplete_cache` rows past TTL. Scheduled via pg_cron (migration `20260501010000_validador_direcciones_cron.sql`).
- `financial_summary(p_from_date, p_to_date)` — KPIs financieros del período (utilidad bruta contable). Versión actual = v6 (migration `20260502000008_financial_summary_v6_devoluciones.sql`). Fórmula: `ingresos − cogs − flete_entregadas − pérdida_devoluciones − comisión_referidos − mantenimiento_tarjeta + indemnizaciones`. Usado por hook `useFinancialSummary`. NO incluye gasto pauta (Fase B pendiente).
- `wallet_summary(from, to)` y `wallet_daily_series(from, to)` — KPIs y serie temporal del wallet de Dropi. Admin-only, security definer.
- `upsert_wallet_movements(...)` — bulk INSERT idempotente sobre `dropi_wallet_movements` con `dropi_transaction_id` UNIQUE. RLS bloquea INSERT/UPDATE directo — todo va via este RPC.
- `operator_productivity_stats(p_range)` — KPIs por operador para `/admin → Productividad`. `p_range` ∈ `today | 7d | 30d` (ventanas alineadas a medianoche Bogotá desde la v3 `20260526140000`, NO rodantes). Tasas calculadas sobre INFLOW (entrantes en el período). Versión actual = **v4** (`20260528220000`) agrega 3 columnas de ESFUERZO sin tocar las existentes:
  - `intentos_noresp` — `COUNT(DISTINCT order_id)` con `result='noresp'` sin importar si después se cerró conf/canc. La columna original `noresp` mantiene el filtro `NOT EXISTS conf/canc posterior` (estado actual del pedido). Son métricas distintas.
  - `intentos_total` — `COUNT(*)` acciones de confirmar (no distinct).
  - `pendientes_sin_tocar` — `GREATEST(entrantes_global − atendidos_del_op, 0)`.
- `operator_activity_stats(p_range)` y `record_operator_heartbeat(p_store_id, p_active_seconds, p_idle_seconds)` — tracking de jornada (migration `20260528190848` + `20260528210000` para excluir admins). El cliente sube buckets cada 60s vía hook `useOperatorHeartbeat`; la RPC de lectura agrega por operador y excluye admins server-side. Ver sección "Productividad operadora: jornada + cobertura del día".
- `today_call_stats()` y `submit_closing_report(p_notes)` — cierre diario por operador. `submit_closing_report` deduplica si ya hay un cierre hoy (migration `20260505200000_fix_closing_dedup.sql`).
- `admin_daily_reports_range(p_from, p_to)` y `admin_operator_shifts_range(p_from, p_to)` — reportes admin por rango. Devuelven una fila por (operador, día), no agregado por operador. Usar para tabla histórica de cierres.
- **CFO inputs (manual)** — admin-only, security definer:
  - `upsert_monthly_business_inputs(p_year_month, ...)` — costos fijos, opex, salarios mensuales (tabla `monthly_business_inputs`).
  - `upsert_tc_debt_snapshot(...)` / read via `tc_debt_snapshots` — snapshots de deuda tarjeta de crédito (USD + COP).
  - `upsert_monthly_ad_spend(p_year_month, ...)` y `delete_monthly_ad_spend(p_id)` — gasto en pauta por canal/mes (tabla `monthly_ad_spend`).
  - `product_profitability(p_from_date, p_to_date)` — rentabilidad por producto combinando ingresos, COGS, flete y devoluciones.

### Módulo Finanzas — dos hooks distintos, NO confundir

`/logistica → Finanzas` muestra DOS perspectivas distintas de la misma operación:

**1. Utilidad Bruta Contable** (hook `useFinancialSummary`):
- Fórmula: `ingresos − COGS − flete − pérdida_devoluciones − comisión_referidos − mantenimiento_tarjeta + indemnizaciones`
- Incluye **COGS** aunque el cliente NO lo paga directo (Dropi le paga al proveedor). Es la utilidad "como si pagara todo".
- Sirve para análisis contable estándar.

**2. Ganancia Neta Dropi REAL** (hook `useGananciaNetaDropi`, card hero principal):
- Fórmula: `SUM(ENTRADAS operativas) − SUM(SALIDAS operativas)` desde wallet
- ENTRADAS: `ganancia_dropshipper`, `ganancia_proveedor`, `reembolso_flete`, `indemnizacion`
- SALIDAS: `flete_inicial`, `costo_devolucion`, `comision_referidos`, `mantenimiento_tarjeta`, `orden_sin_recaudo`
- EXCLUYE `retiro`, `deposito`, `otro`, `transferencia_externa` (movimientos de tesorería, no afectan ganancia operativa)
- Es el cash flow REAL — lo que entró/salió del wallet de Dropi.
- Sirve para decisión "estoy ganando plata o no".

**No mezclar las dos.** Si querés ver "lo que Dropi me pagó" → Ganancia Neta. Si querés perspectiva contable/comparable con Boostec → Utilidad Bruta.

### Listas SLA en `/seguimiento` (`src/lib/segLists.ts`)

Selector de 8 listas pre-clasificadas estilo Boostec. Cada lista tiene un predicado puro `(o: OrderData) => boolean` que combina `estado` + `días hábiles desde creación` (vía `calcBusinessDays`). Listas son **disjuntas** — una orden NO puede aparecer en 2 a la vez (ej. `pendientes_guia_2d` requiere `dias >= 2 AND < 4`, `indem_pendientes_guia_4d` requiere `dias >= 4`).

Slugs: `pendientes_confirmacion_2d` (link a `/confirmar`), `pendientes_guia_2d`, `indem_pendientes_guia_4d`, `guia_generada_2d`, `indem_guia_generada_5d`, `reclamar_oficina_4d`, `en_proceso_7d`, `otros_estados`.

Si `OrderData.fecha` está malformada, `diasDesdeCreacion()` cae a `o.dias` como fallback (try/catch).

### Productividad operadora: jornada + cobertura del día

Dos sistemas independientes, ambos client-side-light + server-state-authoritative:

**1. Jornada (heartbeat de actividad).** Hook `src/hooks/useOperatorHeartbeat.ts` montado una sola vez en `ProtectedLayoutInner` (después de los providers). Listeners de `mousemove` (throttled 1s), `keydown`, `touchstart`, `click`, `wheel`. Tick interno cada 1s acumula en buckets `activeSecondsRef` / `idleSecondsRef` según si la última actividad cae dentro de `IDLE_THRESHOLD_MS = 5 * 60 * 1000`. Cada 60s flushea vía `record_operator_heartbeat` (cap defensivo de 120s por bucket en el server). **Gates obligatorios:** `!authLoading && !isAdmin && activeStoreId`. **No usa `visibilitychange`** — confiamos en que mousemove no se dispara con la tab en background, así el idle sube natural. La sección "Jornada" del dashboard sale de `operator_activity_stats` y excluye admins server-side (migration `20260528210000`).

**2. Cobertura del día por operadora.** `OrderContext` mantiene dos `Set<string>`:
- `myConfirmTouchedToday: Set<order_id>` — pedidos donde YO inserté `order_results` con `module='confirmar'` hoy (Bogotá).
- `mySegTouchedToday: Set<phone>` — pedidos donde YO inserté `touchpoints` con `action ILIKE 'SEG:%'` hoy. `touchpoints` no tiene `order_id`, el match con `segData` es por phone (mismo patrón que `classifySegOwnershipFromTps` en `segOwnership.ts`).

Carga inicial: query barato (solo `order_id` / `phone`) filtrado por `operator_id=me` + `created_at >= startOfTodayBogota`. **Realtime:** un único canal `my-coverage-${user.id}` suscrito a INSERT en ambas tablas con `filter: operator_id=eq.${user.id}` (Postgres Realtime NO soporta ILIKE — el match de `module='confirmar'` / `action LIKE 'SEG:%'` se hace client-side en el handler). El payload de Realtime trae la fila completa → cero queries extra.

Estos sets alimentan los chips "Tu cola hoy" en `ConfirmarTab.tsx` y `SeguimientoTab.tsx` (toggle "Solo sin tocar" filtra `workQueue` / `feedBase` antes de pasar al `<WorkList>` / `<CrmTable>`). El chip de Confirmar usa `myConfirmTouchedToday.size` como "Has llamado a X"; el de Seguimiento cruza por phone contra la lista SLA activa.

**Por qué dos métricas N/R en el dashboard ("Intentos N/R" vs "N/R abiertos"):** el filtro `NOT EXISTS conf/canc posterior` de la v3 (líneas 73-81 de `20260526140000`) descuenta de `noresp` cualquier pedido que después se cerró. Esto está bien para el estado actual del pedido, pero esconde el ESFUERZO de la operadora ("llamé a 5 que no contestaron y volví a llamarlos hasta que confirmaron"). `intentos_noresp` (v4, `20260528220000`) sí cuenta esos. NO mezclar: "N/R abiertos = pedidos sin cerrar"; "Intentos N/R = llamadas que no contestaron al primer intento".

### Address Validator (validador de direcciones)

When a pending order is rendered in `CallView` / `CrmCallView`, the system runs a multi-layered validation pipeline. Touching this is fragile — read this section before changing anything.

> **CURRENT STATE (2026-05-22): Google is OFF.** With `GOOGLE_PLACES_ENABLED = false`, step 1 below short-circuits (`edgeReturned = true`, no edge call) and the semáforo runs entirely on the local heuristic (steps 2–4). The Google/Haiku/edge-cache machinery below is preserved for when the flag flips back, but right now NO external suggestion is fetched. Re-read `src/lib/featureFlags.ts` before assuming Google runs.

**Decision states** (`validation_decision` column): `green` · `yellow` · `red` · `pickup_office` · `null`. Drives the colored badge and the `DespachoGateButton` enable/disable state via `src/lib/canConfirmOrder.ts` (gate spec lives in its `.test.ts`).

**Pipeline order** (auto-validate effect in `CallView.tsx` and `CrmCallView.tsx`):
1. Edge function `dropi-validate-address` (Google Places + Haiku optional). Times out at 3s → fires heuristic fallback in parallel without cancelling.
2. Heuristic-only fallback (`src/lib/addressHeuristic.ts` + `src/lib/mapAddressKind.ts`). Pure regex, no network. Always writable.
3. Hard stop at 10s — if `dbWritten === false`, force-runs the heuristic again as last-resort. Card NEVER terminates in "Sin validar" except when address < 5 chars.
4. Two module-level `Set<string>` overrides re-evaluate stale rows on each render: pickup detection (`pickupOverrideAppliedIds`) and stale-green correction (`staleGreenOverrideIds`). They write DB but never call the edge function (no Google quota burn).

**Visual override** (`visualDecision` IIFE in CallView): displays the client-side decision immediately so the operator doesn't see a flash of stale DB green/yellow before realtime catches up. The `DespachoGateButton` reads `visualDecision`, NOT `o.validationDecision`.

**Anti-hallucination guard** — `src/lib/locationGuard.ts` `locationMatches(text, ciudad?, departamento?)`. Required before showing ANY external suggestion (Google, Haiku, edge-function cache). If the order has a `ciudad` ≥3 chars, the suggestion text MUST contain it; matching by departamento alone is REJECTED (Neiva and Pitalito are both in Huila but 200 km apart). Used in `useGoogleAddressLookup`, `googleSuggestions` cache, `suggestedAddress` prop. NEVER show external text without passing it through this guard.

**Heuristic gotchas** (`addressHeuristic.ts`):
- Score capped at 65 (yellow) when `CANONICAL_PLACA_REGEX` doesn't match — i.e. without an explicit `# X-Y` hyphen, can't reach green.
- `COMPLEMENT_NO_NUMBER` regex catches "Apartamento." with no number after, also caps at 65.
- Input is NFD-normalized to strip accents BEFORE regex, so "Callé" matches "Calle".
- `mapAddressKind` returns `'pickup_office'` for "of interrapidismo", "Reclamo en oficina", "pasaje comercial", "centro comercial", "lo recojo yo", etc.

**Client-side suggestion builder** (`src/lib/buildAddressSuggestion.ts`): pure heuristic, NEVER invents data — only re-formats what the customer already wrote (direccion + ciudad + departamento + barrio). Output `{ suggested, missingNote, hasEnoughInfo }`. Uses preposition "en" instead of `___` placeholders when info is partial. Goes through `locationMatches` sanity check before render.

**Pending migration:** `supabase/migrations/20260502000000_add_suggested_address.sql` adds `orders.suggested_address` column. Until applied, `src/lib/orderColumns.ts` and the UPDATEs in `CallView.tsx`/`CrmCallView.tsx` reference it via commented `HOTFIX 2026-04-30` lines. Re-enable when migration runs.

### Verificación de datos en Supabase desde el navegador

Cuando necesites diagnosticar un problema de datos sin esperar a Lovable o sin SQL Editor, podés correr queries directas a la API REST de Supabase desde DevTools del browser (con sesión admin activa):

```js
const ANON = '<anon_key_del_bundle>';
const TOKEN = JSON.parse(localStorage.getItem('sb-bokhlpfmttoizjaakntc-auth-token')).access_token;
const r = await fetch(
  'https://bokhlpfmttoizjaakntc.supabase.co/rest/v1/dropi_wallet_movements?categoria=eq.costo_devolucion&select=monto,codigo,fecha&order=fecha.desc',
  { headers: { apikey: ANON, Authorization: `Bearer ${TOKEN}` } }
);
console.log(await r.json());
```

El `anon_key` se extrae del bundle JS (`fetch('/assets/index-*.js').then(r=>r.text()).then(t=>t.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g))`). RLS aplica igual — vas a ver SOLO los datos que tu user puede ver. Patrón usado para diagnosticar bugs de wallet en sesión 2026-05-02.

### Test Files

Tests use Vitest + Testing Library. Test files live next to the source files they test:
- `src/lib/*.test.ts` — pure utility unit tests (no DOM needed)
- `src/components/**/*.test.tsx` — component tests with jsdom
- Setup file: `src/test/setup.ts` polyfills `matchMedia` and `ResizeObserver` for jsdom. Required for any component that uses Radix primitives (most shadcn/ui components do).
- **Do not mock the Supabase client** — tests run against the real Supabase project. The few existing component tests stub network calls inline; do not introduce a global Supabase mock.

### Design System

Tailwind + shadcn/ui components (`src/components/ui/`). Custom CSS variables for theming are in `src/index.css`. The design token names follow shadcn conventions: `bg-surface`, `bg-card`, `text-accent`, `border-border`, etc. Dark/light mode toggled via `useTheme` hook and stored in `localStorage`.

### Capa `ui3d` — primitivas de presentación (rediseño "3D command center")

`src/components/ui3d/` (`TiltCard`, `CountUp`, `GaugeRing`, `Sparkline`, `StatTile`, `RankRow`,
`StackedDayBars`, `AuroraBackdrop`, `IconRail`, `HudTopbar` + hooks `useTilt`/`useCountUp`, con
barrel `index.ts`). `ProtectedLayout` ya monta `IconRail`, `HudTopbar` y `AuroraBackdrop`.

Contrato duro — respetarlo al agregar pantallas:
- **Solo reciben `number` / `string` / `ReactNode`.** Nunca hooks de datos, queries ni el cliente
  de Supabase. Ninguna pantalla reimplementa tilt/count-up/gauge por su cuenta.
- **Nada nuevo usa `backdrop-filter`** — es deliberado: `bg-card/40` sobre la aurora da
  profundidad sin matar el scroll de un `CrmTable` de 100 filas. Los `.glass-panel` de
  `ConfirmarTab`/`AuthPage` son preexistentes y están grandfathered.
- La decisión de desactivar el tilt (táctil, mobile, `prefers-reduced-motion`) vive **solo** en
  `useTilt`. Los alfas de `AuroraBackdrop` están calibrados de contraste **a través** de las
  tarjetas translúcidas — subirlos obliga a re-chequear contraste sobre la tarjeta, no sobre el
  fondo desnudo.

Estado del rediseño: el spec (`docs/superpowers/specs/2026-07-18-rediseno-3d-command-center-design.md`)
planea 10 tandas (0–9), un commit cada una, en `redesign/3d-command-center`. El plan
`plans/2026-07-18-rediseno-3d-tandas-0-2.md` cubre solo las tandas 0–2 y tiene **82 casillas sin
marcar y 0 marcadas, pero el código ya está puesto** — las casillas están desactualizadas, no
pendientes. Las tandas 3–9 no tienen archivo de plan. El propio spec advierte: **"No usar el git
log como fuente de estado"** (commits anteriores prometieron más cobertura de la que entregaron) y
marca la **tanda 4 (`CallView`/`CrmCallView`) como la peligrosa** — toca los overrides
module-level de validación de direcciones, `visualDecision` y `DespachoGateButton`; si aparece un
`visualDecision` o un efecto de auto-validación en el diff, revertir.

### Convención `docs/superpowers/`

`specs/*-design.md` (documentos de diseño fechados: contexto, tabla de decisiones, arquitectura,
zonas de riesgo, fuera-de-alcance) alimentan `plans/*.md` (planes de implementación fechados, tarea
por tarea, con casillas `- [ ]`, tabla de archivos a crear/modificar y verificación por tarea).

**Trampa:** los encabezados de los planes exigen una sub-skill `superpowers:*` que **no está
instalada en este entorno** (no hay `.claude/skills/` ni plugin). Son artefactos de un setup
anterior: hay que seguir la convención a mano. Y como muestra el plan del rediseño 3D, **el estado
de las casillas puede mentir** — verificar contra el código, nunca contra el checkbox.

### ⚠️ Artefactos obsoletos que ensucian búsquedas y engañan

- **`everything-claude-code/`** — repo de terceros vendorizado (cientos de `SKILL.md`, su propio
  `CLAUDE.md` y `AGENTS.md`). **No es código de este proyecto** y no está conectado a `.claude/`.
  Contamina cualquier grep amplio.
- **`.claude/worktrees/practical-banach-d13722/`** — copia COMPLETA del proyecto. Todo grep a nivel
  repo devuelve resultados duplicados si no se la excluye.
- **`design-system/guardian-crm/MASTER.md`** — dice de sí mismo que hay que "seguir estrictamente"
  sus reglas, pero **no es autoritativo**: es un artefacto de abril (paleta clara `#F8FAFC`, Fira),
  su directorio de overrides `design-system/pages/` no existe, nada en `src/` lo referencia, y
  contradice de frente la dirección actual (aurora oscura / command center 3D). La verdad de UI son
  los tokens de `src/index.css` + el spec del rediseño 3D.
- **`.claude/settings.local.json`** — sus ~166 reglas de permisos apuntan a
  `c:\Users\hoyos\Desktop\...`, **otro home distinto al checkout actual** (`C:\Users\FABIAN\...`),
  así que muchas reglas de git no matchean y vuelven a pedir permiso.
