# Guardian First Admin

CRM React/TypeScript para call-center COD (Cash-on-Delivery) integrado con la transportadora Dropi (Colombia). Operadoras llaman a clientes para confirmar/cancelar pedidos, dar seguimiento, resolver novedades de transportadora y rescatar entregas fallidas.

## Stack

- React 18 + Vite + TypeScript
- Tailwind + shadcn/ui
- Supabase (Postgres + Auth + Edge Functions Deno + Realtime)
- Dropi API (sync via cron cada 1 min)

## Setup

```bash
npm install
cp .env.example .env   # rellenar con valores del proyecto Supabase
npm run dev
```

## Comandos

```bash
npm run dev          # Vite dev server
npm run build        # Production build
npm run lint         # ESLint
npm run test         # Vitest una vez
npm run test:watch   # Vitest watch mode

# Test individual
npx vitest run src/lib/orderUtils.test.ts

# Edge Functions (deploy individual)
supabase functions deploy dropi-sync
supabase functions deploy dropi-cron
supabase functions deploy dropi-update-order
supabase functions deploy dropi-resolve-incidence
supabase functions deploy dropi-fingerprint
supabase functions deploy ai-order-assistant

# Migraciones DB
supabase db push
```

## Arquitectura (resumen)

| Ruta | Tab | Propósito |
|------|-----|-----------|
| `/confirmar` | ConfirmarTab | Cola de llamadas — confirma/cancela pedidos |
| `/seguimiento` | SeguimientoTab | Tracking de pedidos despachados |
| `/novedades` | NovedadesTab | Resuelve incidencias de transportadora |
| `/rescate` | RescateTab | Recovery queue (entregas fallidas) |
| `/admin` | AdminTab | Config, gated por `isAdmin` |
| `/dashboard` | DashboardTab | KPIs |
| `/pedido/:id` | OrderDetailPage | Detalle de un pedido |

Para detalles internos (data flow, RLS, RPCs, tipos), ver [CLAUDE.md](./CLAUDE.md).

Para el relay HTTP a Dropi desde otros proyectos, ver [RELAY_README.md](./RELAY_README.md).
