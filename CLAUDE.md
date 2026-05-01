# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
supabase functions deploy dropi-resolve-incidence
supabase functions deploy dropi-fingerprint
supabase functions deploy dropi-cron
supabase functions deploy ai-order-assistant
supabase functions deploy dropi-validate-address
supabase functions deploy google-places-proxy

# Apply DB migrations
supabase db push
```

## Operational Gotchas (Lovable)

- **Lovable does NOT auto-redeploy edge functions on `git push`.** Code in `supabase/functions/` ships to GitHub but the deployed runtime stays on the OLD version until someone explicitly redeploys (Lovable prompt or `supabase functions deploy`). Always design client-side fallback for any edge-function change you ship.
- **Lovable does NOT auto-apply migrations.** Files in `supabase/migrations/` need explicit `supabase db push` or a Lovable prompt. If `ORDER_COLUMNS` (`src/lib/orderColumns.ts`) references a column whose migration hasn't run, the SELECT explodes with `column X does not exist` and breaks every order-loading screen. Mitigation pattern: hotfix by removing the column from `orderColumns.ts` until the migration is applied.
- The DB row mapper is **`dbToOrderData`** (not `mapDbRow`) in `src/lib/orderUtils.ts`.

## Architecture Overview

**Guardian First Admin** is a React/TypeScript CRM for COD (Cash-on-Delivery) e-commerce operators that integrates with the Dropi carrier platform (Colombia).

### Data Flow

1. **Excel upload** → `ExcelUploader` parses columns via `COL_MAP` in `src/lib/constants.ts` into `OrderData[]`
2. **OrderContext** (`src/contexts/OrderContext.tsx`) holds all in-memory order state for the session; it wraps `useDataLoader` (Supabase DB queries for Seguimiento/Rescate) and `useNovedades` (active incidences)
3. **Supabase Edge Functions** sync/update orders from the Dropi API and are called from the UI via `supabase.functions.invoke()`
4. **Supabase project ID**: `bokhlpfmttoizjaakntc`

### Page / Tab Map

| Route | Page | Tab Component | Purpose |
|---|---|---|---|
| `/confirmar` | ConfirmarPage | ConfirmarTab | Call queue — confirm/cancel orders |
| `/seguimiento` | SeguimientoPage | SeguimientoTab | Track dispatched orders |
| `/novedades` | NovedadesPage | NovedadesTab | Resolve carrier incidences |
| `/rescate` | RescatePage | RescateTab | Recovery queue for failed deliveries |
| `/admin` | AdminPage | AdminTab | Admin-only config (isAdmin gate) |
| `/dashboard` | DashboardPage | DashboardTab | KPI metrics |
| `/logistica` | LogisticsPage | LogisticaTab | Análisis admin: rendimiento por transportadora, devoluciones por ciudad, productos con peor entrega |
| `/pedido/:id` | OrderDetailPage | order-detail/* | Single-order drill-down |

All authenticated routes share `ProtectedLayout` which:
- Wraps everything in `<OrderProvider>`
- Renders sidebar nav (Admin tab hidden for non-admins via `isAdmin`)
- Shows `CounterBar` only on `/confirmar`

### Auth & Roles

`AuthContext` (`src/contexts/AuthContext.tsx`) reads `profiles` and `user_roles` from Supabase. `isAdmin = user_roles.some(r => r.role === 'admin')`. The ref guard `profileFetchedFor` prevents double-fetch on fast connections.

Roles in `user_roles`: `admin` and `operator`. Operators see all tabs except Admin. RLS policies on the `orders` table use `auth.uid()` — operators can only read/write their own rows unless an admin-scoped policy overrides. See migration `20260416220000_fix_orders_rls_operator_view.sql` for the current operator SELECT policy.

### Key Domain Types

- `OrderData` — canonical in-memory order shape (`src/lib/orderUtils.ts`)
- `DbOrderRow` — raw Supabase DB row (nullable fields); mapped to `OrderData` via `mapDbRow()`
- `COL_MAP` — multi-alias Excel column mapping (`src/lib/constants.ts`)
- `CARRIER_TRACK` / `CARRIER_DEADLINES` — per-carrier tracking URLs and SLA days

### Supabase Edge Functions

All functions are Deno (TypeScript). They live in `supabase/functions/`:
- `dropi-sync` — bulk-fetches orders from Dropi API, chunked in ≤89-day ranges, upserts to DB
- `dropi-update-order` — updates a single order's Dropi status (bearer token from DB settings)
- `dropi-resolve-incidence` — resolves a novedad on Dropi and marks it in DB
- `dropi-fingerprint` — generates a customer fingerprint for repeat-buyer detection
- `dropi-cron` — scheduled sync trigger
- `ai-order-assistant` — Claude-powered order assistant

The Dropi token is stored in the `app_settings` table (key: `dropi_token`) and read at runtime — not hardcoded.

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

### Address Validator (validador de direcciones)

When a pending order is rendered in `CallView` / `CrmCallView`, the system runs a multi-layered validation pipeline. Touching this is fragile — read this section before changing anything.

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

### Test Files

Tests use Vitest + Testing Library. Test files live next to the source files they test:
- `src/lib/*.test.ts` — pure utility unit tests (no DOM needed)
- `src/components/**/*.test.tsx` — component tests with jsdom

### Design System

Tailwind + shadcn/ui components (`src/components/ui/`). Custom CSS variables for theming are in `src/index.css`. The design token names follow shadcn conventions: `bg-surface`, `bg-card`, `text-accent`, `border-border`, etc. Dark/light mode toggled via `useTheme` hook and stored in `localStorage`.
