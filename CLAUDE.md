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

# Apply DB migrations
supabase db push
```

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

### Test Files

Tests use Vitest + Testing Library. Test files live next to the source files they test:
- `src/lib/*.test.ts` — pure utility unit tests (no DOM needed)
- `src/components/**/*.test.tsx` — component tests with jsdom

### Design System

Tailwind + shadcn/ui components (`src/components/ui/`). Custom CSS variables for theming are in `src/index.css`. The design token names follow shadcn conventions: `bg-surface`, `bg-card`, `text-accent`, `border-border`, etc. Dark/light mode toggled via `useTheme` hook and stored in `localStorage`.
