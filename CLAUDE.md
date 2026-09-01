# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **This file is the source of truth.** `AGENTS.md` and `README.md` are older and stale on several points — they still describe the pre-multitienda model (`app_settings.dropi_token`, "integration-key not Bearer"), a `mapDbRow()` mapper that no longer exists (it's `dbToOrderData`), a `/rescate` route that was removed, CO-only scope, and a 1-min cron. When they disagree with this file, this file wins.

> **El detalle por módulo vive en `docs/ARQUITECTURA.md`** (Page/Tab Map, edge functions,
> RPCs, wallet, listas SLA, validador de direcciones, ui3d…). Se movió el 31-ago-2026 sin
> cambiar una palabra: este archivo viaja ENTERO en cada petición — hasta en un "hola" — y
> el 76% era referencia que solo hace falta al tocar el módulo puntual. Pasó de ~23.200 a
> ~7.000 tokens. **El índice de más abajo dice cuándo abrir cada sección: abrila ANTES de
> tocar su módulo.** Este archivo sigue mandando sobre las reglas y las trampas de Lovable.

## ⛔ REGLA #0 — DDL sobre tablas calientes puede TUMBAR toda la base

**Qué pasó (2026-08-25):** una migración de Lovable hizo `ALTER TABLE orders ADD COLUMN` +
`CREATE INDEX` (no-concurrent) sobre `orders`. Quedó ESPERANDO el lock detrás de una
transacción larga y **todas las lecturas se encolaron atrás** → la base entera se congeló
~20 min, hasta el login (`auth/token`) daba 504. El equipo de Ecuador quedó sin CRM. Se
destrabó **reiniciando el backend** (el SQL editor de Lovable NO tiene permiso para
`pg_terminate_backend` — da "Server Error"; el reinicio lo hace el agente de Lovable o
Supabase, NO hay botón "Restart" en el panel de Lovable). Diagnóstico en vivo desde afuera:
`auth/v1/health` respondía en 42 ms pero `SELECT id FROM orders LIMIT 1` se colgaba 20 s =
**lock sobre `orders`**, no infra caída.

**Reglas duras para CUALQUIER migración que toque `orders` / `order_results` / `touchpoints`
(tablas calientes que los crons y el frontend usan sin parar):**
- Empezar el archivo con `SET lock_timeout = '5s';` — así el DDL **falla rápido** en vez de
  encolar a todo el mundo detrás de un lock que no consigue.
- Índices con **`CREATE INDEX CONCURRENTLY`** (no bloquea lecturas/escrituras). OJO: no corre
  dentro de una transacción.
- Aplicarla en un **momento tranquilo**, no en hora pico con los crons corriendo.
- `ADD COLUMN` sin default es instantáneo; un `ADD COLUMN ... DEFAULT` o un `UPDATE` masivo
  reescribe la tabla y la bloquea — evitarlos o hacerlos por lotes.

La migración `20260825230000_blindaje_timeouts_db.sql` puso dos redes de seguridad a nivel de
rol para que un lock/consulta trabada no vuelva a congelar TODO: `idle_in_transaction_session_timeout`
(mata la transacción ociosa que retiene el lock — la causa raíz exacta) y `statement_timeout`
(cancela la consulta eterna antes de que tape el pool). NO tocan `service_role` (edge/crons).

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

Diagnóstico rápido de países cruzados: **⚠️ la vieja regla del largo del `external_id`
YA NO SIRVE.** Este doc decía "Ecuador 7 dígitos, Colombia 8" — medido el 20-ago-2026 sobre
las 6 tiendas vivas, **cuatro comparten el espacio de 7 dígitos**: GT (7-7), las dos de
Ecuador (7-7), Colombia (7-**8**, o sea también tiene de 7) y Quickly Box (6-7). Son ~16.000
pedidos en el mismo rango numérico. Diagnosticar el país por el largo hoy da falsos
negativos. Usar `store_id`, que es el único dato que no miente.

Tiendas: CO = `00000000-0000-0000-0000-000000000001` · EC = `512309c3-d5b7-4434-898a-31bed51dcd4d`.

**`orders.external_id` es único POR TIENDA desde la migración
`20260820140000_external_id_unico_por_tienda.sql`.** Antes era UNIQUE GLOBAL
(`orders_external_id_key`, confirmado en la base el 20-ago-2026): como
`upsert_orders_from_dropi` hace `ON CONFLICT ... DO UPDATE` **con autocura de `store_id`**,
un pedido con un id ya usado por otra tienda no fallaba — **se apoderaba de la fila** ajena
(cliente, dirección, valor y `store_id`) y el cron del otro país la devolvía → una fila
rebotando entre dos empresas, y el pedido original DESAPARECIDO del CRM de su dueño. Los
rangos ya se solapaban: GT `1.145.315–1.219.530` está dentro de Quickly Box
`899.315–1.239.618`; Rushmira CO `3.388.406–86.514.681` engloba a las dos tiendas de EC.
Se verificó que el daño NO había ocurrido todavía (cero gestiones huérfanas desde jun-2026).

La migración hace tres pasos EN ESE ORDEN, en una sola transacción: crear
`orders_store_external_uk (store_id, external_id)` → apuntar la función al conflicto nuevo →
recién ahí soltar el unique viejo. Invertirlo deja la tabla sin protección o tumba el upsert
entero. Trae un guard fail-closed que aborta si hay algún `store_id NULL` (un NULL no lo
restringe un índice compuesto). El cuerpo de la función salió de `pg_get_functiondef`, NO del
repo, y solo cambió la línea del `ON CONFLICT` — REGLA #1.

**Consecuencia para el código: el número de pedido YA NO identifica una tienda.** Toda
búsqueda por `external_id` necesita `store_id` al lado. `storeIdFromExternalId`
(`_shared/dropiStoreConfig.ts`) quedó ambigua por diseño y está marcada para morir. El
guardián `src/test/externalIdPorTienda.test.ts` falla si alguien vuelve a upsertear con
`onConflict: "external_id"` a secas.

## ⛔ REGLA #2 — PROHIBIDO SUPONER: se verifica EN LA PANTALLA

Dicho por el dueño el 23-ago-2026: **"te queda prohibido suponer, siempre tenés que
revisar"**. No es una preferencia de estilo — salió de tres fallos seguidos en una sola
sesión, todos con typecheck, 2.300 pruebas y build en verde:

1. Se dio por bueno un cambio de Seguimiento con las pruebas verdes. `/seguimiento` estaba
   **caída entera** en producción (canal de realtime con nombre repetido → ErrorBoundary).
2. Se puso un chip nuevo en la vista **Lista** y se reportó como hecho. La vista por defecto
   es **Tablero**: la asesora no lo veía nunca.
3. Se verificó el troceo de `cancelaciones_analisis` solo con el rango por DEFECTO (23 días).
   Nunca se abrió "el mes pasado" ni los presets largos — y ahí estaban los dos fallos que
   encontró el dueño: 18 s afirmando *"No hubo cancelaciones"* sobre julio (que tuvo 345), y
   `365d`/`Histórico` disparando 73 consultas (~2 min) contra la base mientras el equipo
   trabaja.

El patrón es siempre el mismo: **se verificó la pieza, no la pantalla.** Verde en consola no
es verde para quien la usa.

Qué exige esta regla, en concreto:

- Un cambio no está hecho hasta **abrir la pantalla en producción** y ver el dato correcto.
- Con **la tienda y el rango que usa el dueño de verdad**, no solo el default, y en la
  **vista por defecto** (no la que abrió quien programó).
- Los estados intermedios se miden **en el tiempo** — muestrear a 2 s, 6 s, 12 s, 20 s — no
  con un solo vistazo. Los peores errores viven en esa ventana: un estado vacío que no mira
  `loading` **afirma un cero** sobre datos que todavía no llegaron, y eso se lee como "está
  caído" o, peor, como una buena noticia.
- Si algo no se pudo comprobar, **se dice cuál y por qué**. Nunca se rellena con una
  suposición razonable.
- Cuando el dueño reporta un síntoma, **se reproduce primero**, aunque uno crea que ya sabe
  la causa. La causa que uno creía saber ya fue la equivocada.

## Commands

```bash
# Development
npm run dev          # Start Vite dev server (puerto 8080)
npm run build        # tsc --noEmit -p tsconfig.app.json && vite build  (el typecheck CORRE en build)
npm run typecheck    # Solo el tsc --noEmit (rápido, sin bundle)
npm run build:dev    # Dev-mode build (useful for debugging) — NO typechequea
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
supabase functions deploy shopify-push-dropi
supabase functions deploy shopify-reconcile
supabase functions deploy shopify-auto-push
supabase functions deploy parse-bank-pdf-text
supabase functions deploy dropi-open-incidences
supabase functions deploy dropi-refresh-batch
supabase functions deploy dropi-webhook
supabase functions deploy dropi-verify-credentials
supabase functions deploy dropi-sync-city-catalog

# Apply DB migrations
supabase db push

# Disparar wallet sync con rango custom (default = últimos 30 días)
curl -X POST "$SUPABASE_URL/functions/v1/dropi-wallet-sync" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $USER_JWT" \
  -d '{"from":"2026-01-01","to":"2026-05-02"}'
```

**CI** (`.github/workflows/ci.yml`, en push/PR a `main`): `tsc --noEmit` → `eslint src/lib src/hooks src/contexts --max-warnings 0` (**`continue-on-error: true`** — el lint NO tumba el build, y solo mira esas tres carpetas) → `npm test` → `npm run build`. Es decir: **typecheck y tests SÍ son bloqueantes; el lint no.**

**⚠️ `npm test` NO corre las pruebas de las edge functions.** `vitest.config.ts` tiene
`include: ["src/**/*.{test,spec}.{ts,tsx}"]`, así que
`supabase/functions/shopify-push-dropi/discount.test.ts` **nunca se ejecuta** ni acá ni en CI.
El patrón que SÍ funciona: dejar la lógica pura en `supabase/functions/_shared/` (la importa la
edge function Deno) y poner **el archivo de test en `src/lib/`** importando cruzando el límite —
así lo hacen `src/lib/autoPushSelect.test.ts` → `../../supabase/functions/_shared/autoPushSelect`
y `src/lib/walletCategoria.test.ts` → `_shared/walletCategoria`.

## Stack & Constraints

- **Frontend:** Vite + React 18 + TypeScript + Tailwind + shadcn/ui. Vite uses `@vitejs/plugin-react-swc` (SWC, not Babel). `lovable-tagger` is dev-only.
- **Dev server runs on port 8080** (not the default 5173/3000). Configured in `vite.config.ts`.
- **TypeScript is NOT strict.** `tsconfig.app.json` has `strict: false`, `noImplicitAny: false`, `noUnusedLocals: false`. Do not enforce strict-mode patterns when reviewing or refactoring — they are intentionally off.
- **Path alias:** `@/` → `./src/`.
- **Env vars read in `src/`:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_ENABLE_CFO` (gates the `/cfo` route + nav item; only `'true'` registers it — external clients leave it unset and `/cfo` 404s), y **`VITE_PUBLIC_APP_URL`** (dominio canónico con el que se arman los links de invitación y de `/registro`; sin él se usa el origen del navegador, y en un preview/localhost sale un link que el destinatario no puede abrir). Copy `.env.example` → `.env`.
- **Feature flags live in `src/lib/featureFlags.ts`.** `GOOGLE_PLACES_ENABLED = false`.

  **⛔ GOOGLE ELIMINADO DEL CÓDIGO (2026-08-06).** No es un flag apagado: el camino
  **no existe**. Se borró la edge function `google-places-proxy` (era un proxy PURO a
  Google), las llamadas a Google Address Validation y a Haiku dentro de
  `dropi-validate-address`, y el cuerpo de `useGooglePlaces` (queda un stub inerte con la
  misma firma, para no tener que tocar `CallView`/`CrmCallView`). Poner el flag en `true`
  NO reactiva nada.

  **Por qué se borró en vez de dejarlo apagado:** se apagó el 22-may-2026 con ese flag y
  **se siguió pagando más de dos meses** — el flag cortaba `CallView` y `CrmCallView` pero
  no `useAddressValidation`, el hook del badge que va DENTRO de esas mismas pantallas.
  Después se sumó un candado server-side (`GOOGLE_ENABLED`) y una prueba, y aun así
  quedaba un camino a la tarjeta. Un interruptor es un PEDIDO; la única defensa que no
  depende de que la configuración esté bien es que el código no exista.

  **Lo que NO cambió:** el semáforo verde/amarillo/rojo corre sobre la heurística local
  (`src/lib/addressHeuristic.ts`) + Nominatim/OSM (gratis, sin clave) — es lo que viene
  decidiendo desde mayo. Se perdieron el autocompletado (ya inactivo) y el mensaje al
  cliente redactado por Haiku.

  `src/test/googleApagado.test.ts` ahora vigila la **ausencia** del código. Ojo con su
  helper `sinComentarios`: lleva `(?<!:)` para no confundir el `//` de `https://` con un
  comentario — sin eso las comprobaciones negativas pasaban en verde CON el código
  presente.

  **Sigue pendiente y NO depende del código:** borrar `GOOGLE_MAPS_API_KEY` de los
  secretos de Supabase y revocar la clave en Google Cloud.
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
    | `/api/wallet/exportexcel` | `x-authorization: Bearer <token>` | **session token web** (desde 2026-07-29 Dropi rechaza la api_key ahí: 401 "Token not issued to this api" — pegó a CO y EC a la misma hora; cadena session → re-login forzado → api_key de fallback por si revierten) |
    | `/api/orders/myorders` (novedades) | session token web | **NO acepta la api_key** |

    Decir "va como Bearer" es incorrecto y era lo que afirmaba este doc: `/integrations/*`
    usa header propio (14 funciones lo hacen así), y el wallet usa `x-authorization`, no
    `Authorization`. Los hosts salen de `_shared/dropiHosts.ts` (`dropiHostFor(countryCode)`
    — CO `api.dropi.co`, EC `api.dropi.ec`), nunca hardcodeados.
  - `store_dropi_config.dropi_session_token` — JWT de sesión de `app.dropi.co` (vence ~1h). Ya NO es solo legacy: desde 2026-07-29 el **wallet lo necesita** (ver tabla). Se auto-renueva vía `ensureFreshSessionToken` (`_shared/dropiSessionLogin.ts`) en tiendas con login configurado (EC sí; CO no — 2FA). Para fingerprint sigue siendo la api_key (con session_token da 401 "Invalid token").
- **Wallet sync default = últimos 30 días.** `supabase/functions/dropi-wallet-sync/index.ts:218-219` setea `defaultFrom = today - 30d`. Para histórico completo pasar body `{from, to}`. Critical when migrando o queriendo backfill — sin esto la wallet pierde meses anteriores.
- **Cliente-side calculations son más resilientes que migrations pendientes.** Patrón usado en `FinanzasTab.tsx`: cuando una migration agrega un campo nuevo al RPC pero aún no se aplica, el parser del hook coerce `undefined → 0` y el operador `??` no cae al fallback. Solución: calcular client-side desde campos que SÍ vienen (`flete_devoluciones + costo_devoluciones`), ignorar el campo del server. Funciona con cualquier versión del RPC.
- **⚠️ HAY DOS "dropi-relay" con roles OPUESTOS — no confundir:** (1) `supabase/functions/dropi-relay` = **INBOUND**, le presta la IP de Supabase (que rota) a un tercero externo; ver `RELAY_README.md`. (2) `vps/dropi-relay/` = **OUTBOUND**, un contenedor Deno en un VPS Hostinger (IP fija `2.25.69.238`, detrás de Caddy en `https://srv1784684.hstgr.cloud/dropi/`) para que **nuestras** llamadas a la API oficial de Dropi salgan por una IP whitelisteada; ver `vps/dropi-relay/README.md`. El relay del VPS vive SOLO en el VPS + copia versionada en `vps/dropi-relay/` — Lovable NO lo despliega. Toda la migración a la API oficial de integración (webhook + relay IP-fija) está documentada en la memoria `dropi_integration_api_oficial`.

## Architecture Overview

**Guardian First Admin** is a React/TypeScript CRM for COD (Cash-on-Delivery) e-commerce operators that integrates with the Dropi carrier platform. It is **multi-tienda** (one app, many stores) and **multi-country** (Colombia + Ecuador) — see the "Multi-Country" section below.

### Data Flow

1. **Excel upload** → `ExcelUploader` parses columns via `COL_MAP` in `src/lib/constants.ts` into `OrderData[]`
2. **StoreContext** (`src/contexts/StoreContext.tsx`) resolves the user's active store (`activeStoreId`); **everything downstream is store-scoped.** `OrderContext` passes `activeStoreId` into `useDataLoader`/`useNovedades`, and the queries filter `.eq('store_id', activeStoreId)`. A null `activeStoreId` (first load) means "don't fetch yet" — guard with `if (!storeId) return;`.
3. **OrderContext** (`src/contexts/OrderContext.tsx`) holds all in-memory order state for the session; it wraps `useDataLoader` (Supabase DB queries for Seguimiento) and `useNovedades` (active incidences)
4. **Supabase Edge Functions** sync/update orders from the Dropi API and are called from the UI via `supabase.functions.invoke()`
5. **Supabase project ID**: `bokhlpfmttoizjaakntc`

### Auth & Roles — TWO independent layers

This is the most common source of confusion. There are **two role systems**; do not conflate them:

1. **Global platform admin** — `AuthContext` (`src/contexts/AuthContext.tsx`) reads `profiles` + `user_roles`. `isAdmin = user_roles.some(r => r.role === 'admin')`. This is essentially Fabian (the platform operator). It gates **only `adminOnly` items (CFO)**. The ref guard `profileFetchedFor` prevents double-fetch on fast connections.
2. **Per-store membership** — `StoreContext` (`src/contexts/StoreContext.tsx`) reads `store_members` + `stores`. Per-store role ∈ `owner` · `supervisor` · `operator` (strongest wins on duplicate rows, `ROLE_RANK`). Derived: `isOwnerOfActive`, `isManagerOfActive` (owner OR supervisor), `needsSetup`. This gates **`managerOnly` items (Admin, Logística)** and store-scoped data via RLS.

So: Admin/Logística → `managerOnly` (store role). CFO → `adminOnly` (global role) + `VITE_ENABLE_CFO` + `country_code==='CO'`. Confirmar/Seguimiento/Novedades/Dashboard → all members.

**Single-app-mount invariant:** `AuthContext` keeps the SAME `user` object reference across `TOKEN_REFRESHED` events (only `session` updates). If `user`'s reference changed on every token refresh, `StoreContext.refresh` (`useCallback([user])`) would re-run, set `store.loading=true`, and `ProtectedLayout` would unmount the whole app — operators "lose their place / the CRM restarts". `StoreContext` likewise only sets `loading=true` on the FIRST load (`hasLoadedRef`). Preserve both guards when touching auth/store.

`activeStoreId` persists in `localStorage('guardian.activeStoreId')`. RLS on `orders` and most tables is now **store-scoped** (`store_id` + membership), layered on top of the older `auth.uid()` operator policies — see migration `20260521010000_multitienda_sp2_upsert_store_id.sql` and `20260522010000_store_supervisor_role_selfcontained.sql`.

### Key Domain Types

- `OrderData` — canonical in-memory order shape (`src/lib/orderUtils.ts`)
- `DbOrderRow` — raw Supabase DB row (nullable fields); mapped to `OrderData` via `dbToOrderData()` in `src/lib/orderUtils.ts` (there is no `mapDbRow`)
- `COL_MAP` — multi-alias Excel column mapping (`src/lib/constants.ts`)
- `CARRIER_TRACK` (CO) / `CARRIER_TRACK_EC` (EC) / `CARRIER_TRACK_BY_COUNTRY` — per-carrier tracking URLs, resolved by country via `getTrackingUrl` (see Multi-Country). `CARRIER_DEADLINES` — per-carrier SLA days

### Gráficos (recharts) — la trampa que costó meses

**⛔ RECHARTS NO RENDERIZA COMPONENTES PROPIOS COMO HIJOS DE UN CHART.** Un
`<BarGradientDefs/>` (function component que devuelve `<defs>`) como hijo de `<BarChart>` se
DESCARTA en silencio: el gradiente nunca llega al DOM y cada barra queda con
`fill="url(#inexistente)"` → **invisible**. Así estuvieron MESES muertos "Estados por día de
creación" y "Desempeño por transportadora" en /logistica (medido en producción 23-ago-2026:
barras con geometría real y `getElementById` del gradiente en null). Los `<defs>` van INLINE
dentro del chart. OJO: ProductivityDashboard, DailyReportsView, CustomerHistoryCard y los
charts del CFO usan el mismo patrón `BarGradientDefs` — candidatos al mismo bug, verificar
en pantalla antes de asumir que se ven.

## 📍 Dónde está el resto — `docs/ARQUITECTURA.md`

El detalle por módulo vive ahí para que este archivo no viaje entero en cada pregunta.
**Abrí la sección que corresponda ANTES de tocar su módulo**: ahí están las trampas que ya
costaron plata, y trabajar sin leerlas es exactamente cómo se reintroducen.

| Si vas a tocar… | Leé en `docs/ARQUITECTURA.md` |
|---|---|
| una pantalla o ruta | `Page / Tab Map` |
| cualquier `supabase/functions/*` | `Supabase Edge Functions` |
| una RPC de Postgres | `Key RPCs` |
| plata, wallet, márgenes | `Wallet Categorías` · `Módulo Finanzas` |
| Ecuador, Colombia o Guatemala | `Multi-Country (CO + EC + GT)` |
| `/seguimiento`, el tablero, las listas | `Listas SLA` · `Protocolo del turno` · `Frescura del dato` |
| cancelaciones y sus motivos | `Módulo Cancelaciones` |
| métricas de la operadora | `Productividad operadora` |
| direcciones o el semáforo | `Address Validator` |
| tarjetas, tilt, gráficos | `Capa ui3d` |
| algo del bot de WhatsApp | `Bot de WhatsApp — RETIRADO` (histórico) |
| un plan/spec de `docs/superpowers/` | `Convención docs/superpowers/` |

Incidentes ya cerrados: `Lecciones de producción (2026-07-21)`, ahí mismo.

### Test Files

Tests use Vitest + Testing Library (~124 archivos). Test files live next to the source files they test:
- `src/lib/*.test.ts` — pure utility unit tests (no DOM needed)
- `src/components/**/*.test.tsx` — component tests with jsdom
- Setup file: `src/test/setup.ts` polyfills `matchMedia` and `ResizeObserver` for jsdom. Required for any component that uses Radix primitives (most shadcn/ui components do).
- **Do not mock the Supabase client** — tests run against the real Supabase project. The few existing component tests stub network calls inline; do not introduce a global Supabase mock. `src/test/aislamientoTiendasRls.test.ts` es literalmente eso: golpea la base REAL con la clave `anon` y exige que ~10 tablas (`orders`, `store_dropi_config`, `profiles`…) estén cerradas y que un DELETE sea rechazado. **Sin red o sin `.env` se SALTA (`skipped`) a propósito, no da verde** — un `pass` mentiroso acá sería peor que no tener la prueba.
- **`src/test/*.test.ts` son PRUEBAS GUARDIANAS, no unit tests** — leen el árbol de archivos con `fs` y fallan si alguien reintroduce un error que ya costó plata o clientes. Si una de estas se pone roja, el problema es tu cambio, no la prueba: `googleApagado` (ausencia del código de Google/Haiku — ojo con su helper `sinComentarios`, lleva `(?<!:)` para no confundir el `//` de `https://`), `marcaBlancaYVersion` (ninguna pantalla `.tsx` nombra "Rushmira", la tienda del dueño de la plataforma — los comentarios en `.ts` que documentan incidentes reales sí se quedan; y `useVersionCheck` avisa pero NUNCA recarga sola, una operadora a mitad de llamada no puede perder el formulario), `aislamientoTiendasEstatico` / `multitiendaEdge` / `permisosRolesAuditoria` (nada consulta sin `store_id`, ninguna edge function salta `isStoreMember`; la lista de tablas se descubre sola, así que una tabla nueva entra a la auditoría sin que nadie la agregue), `edgeConstantesFantasma` (constantes usadas y nunca declaradas), `onboardingNoEsPorton`, `rpcBinding` (ver la memoria del `this` perdido en `supabase.rpc`), `themeContrast`.

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

### Design System

Tailwind + shadcn/ui components (`src/components/ui/`). Custom CSS variables for theming are in `src/index.css`. The design token names follow shadcn conventions: `bg-surface`, `bg-card`, `text-accent`, `border-border`, etc. Dark/light mode toggled via `useTheme` hook and stored in `localStorage`.

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
- **`.claude/settings.local.json`** — **corregido 2026-08-15: esta advertencia ya no aplica.**
  Decía que sus reglas de permisos apuntaban a un home distinto al checkout
  (`C:\Users\FABIAN\...`) y que por eso no matcheaban. Verificado: TODAS las rutas del archivo
  son `C:\Users\hoyos\...`, que ES el checkout actual. No gastes tiempo "arreglando" rutas que
  ya están bien. (Sí conviene mirar el archivo antes de asumir por qué se pide un permiso: son
  ~199 líneas de reglas.)
