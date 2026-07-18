# AGENTS.md — Guardian First Admin

> Compact instructions for OpenCode sessions. If a fact is obvious from filenames, it's not here.

## Commands

```bash
# Dev server (port 8080 — not 3000/5173)
npm run dev

# Production / debug builds
npm run build
npm run build:dev

# Lint
npm run lint

# Tests (Vitest + jsdom + Testing Library)
npm run test          # once
npm run test:watch    # watch mode
npx vitest run src/lib/orderUtils.test.ts   # single file
```

## Stack & Constraints

- **Frontend:** Vite + React 18 + TypeScript + Tailwind + shadcn/ui
- **Backend:** Supabase (Postgres + Auth + Edge Functions)
- **Edge functions runtime:** Deno (TypeScript) in `supabase/functions/`
- **Vite plugin:** `@vitejs/plugin-react-swc` (SWC, not Babel). `lovable-tagger` is dev-only.
- **TypeScript is NOT strict:** `tsconfig.app.json` has `strict: false`, `noImplicitAny: false`, `noUnusedLocals: false`. Do not enforce strict-mode patterns.
- **Path alias:** `@/` → `./src/`

## Env

Copy `.env.example` → `.env`. Only these two vars are used in `src/`:

```
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_SUPABASE_URL=
```

## Architecture

- **Entry:** `src/main.tsx` → `src/App.tsx`
- **Auth:** `AuthContext` reads `profiles` + `user_roles` tables. `isAdmin = user_roles.some(r => r.role === 'admin')`.
- **Order state:** `OrderContext` (inside `ProtectedLayout`) holds all in-memory order state. It wraps `useDataLoader` (Supabase queries for Seguimiento/Rescate) + `useNovedades` (active incidences).
- **Routes:** Lazy-loaded in `App.tsx`. Each route is wrapped in `ErrorBoundary` so a crash in one tab doesn't kill the whole app.
- **CounterBar** only renders on `/confirmar`.

## Data Flow

1. **Excel upload** → `ExcelUploader` parses columns via `COL_MAP` in `src/lib/constants.ts` into `OrderData[]`
2. **In-memory shape:** `OrderData` (`src/lib/orderUtils.ts`)
3. **DB row shape:** `DbOrderRow` (`src/integrations/supabase/types.ts`); mapped via `mapDbRow()`
4. **Supabase calls from UI:** Use `supabase.functions.invoke('<function-name>')` for Edge Functions.

## Supabase Edge Functions (deploy individually)

```bash
supabase functions deploy dropi-sync
supabase functions deploy dropi-update-order
supabase functions deploy dropi-resolve-incidence
supabase functions deploy dropi-fingerprint
supabase functions deploy dropi-cron
supabase functions deploy ai-order-assistant
```

- `dropi-sync` — bulk-fetches orders from Dropi API in ≤89-day chunks, upserts to DB
- `dropi-update-order` — updates single order status on Dropi
- `dropi-resolve-incidence` — resolves a novedad on Dropi and marks it in DB
- `dropi-fingerprint` — repeat-buyer detection
- `ai-order-assistant` — Claude-powered assistant

Apply DB migrations:
```bash
supabase db push
```

## Dropi Integration Quirks

- Use **integration-key**, NOT Bearer token (2FA blocks Bearer).
- `white_brand_id` is required in Dropi calls.
- Dropi token is stored in `app_settings` table (`key: dropi_token`), read at runtime — not hardcoded.

## Testing

- **Do not mock the database.** Use the real Supabase instance.
- Tests live next to source: `src/lib/*.test.ts` (pure utilities) and `src/components/**/*.test.tsx` (component tests).
- Setup file: `src/test/setup.ts` (polyfills `matchMedia` and `ResizeObserver` for jsdom).

## Important DB RPCs

- `get_daily_operator_stats(p_date)` — per-operator KPI counts (admin-only)
- `dropi_fingerprint(phone)` — repeat-buyer detection
- `confirm_order_locally(p_order_id)` — atomic local confirmation
- `cancel_orphan_pending_orders()` — cancels stale pending rows
- `claim_seg_order(p_order_id)` / `release_seg_order(p_order_id)` — Seguimiento queue claim/release
- `logistics_summary(from_date, to_date)` — global KPIs
- `logistics_by_carrier(...)` / `logistics_by_city(...)` / `logistics_by_product(...)` — admin logistics analytics

All RPCs are `SECURITY DEFINER` + admin-only.

## Style & Conventions

- UI components go in `src/components/ui/` (shadcn/ui pattern).
- Tabs go in `src/components/tabs/`, pages in `src/pages/`.
- Keep high-risk UI changes behind `isAdmin` checks when possible.
