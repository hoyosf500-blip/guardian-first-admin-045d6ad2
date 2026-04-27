# Logística — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sección administrativa nueva `/logistica` que muestra rendimiento por transportadora, devoluciones por ciudad y productos con peor entrega — para que el admin tome decisiones de logística (con qué transportadora trabajar, qué ciudades evitar, qué productos quitar del catálogo).

**Architecture:** 4 RPCs Postgres `SECURITY DEFINER` con admin gate y filtro de rango temporal hacen agregaciones en DB (no en frontend). El frontend usa TanStack Query para cache + un único hook `useLogisticsStats` que paraleliza los 4 fetches. UI con sub-tabs shadcn (Resumen / Transportadoras / Ciudades / Productos), tablas con sort por columna, charts recharts, y export CSV.

**Tech Stack:** PostgreSQL (RPCs SECURITY DEFINER) · React 18 + TypeScript · @tanstack/react-query (ya en repo) · shadcn/ui Tabs/Card/Table · recharts (ya en `vendor-charts`) · `formatCOP` helper de Tanda 5 · Vitest para tests.

---

## Decisiones técnicas (con fundamento)

| # | Decisión | Por qué |
|---|---|---|
| **D1** | 4 RPCs separadas (`_summary`, `_by_carrier`, `_by_city`, `_by_product`) en vez de 1 mega-RPC | El plan original (Kimi) hacía `CROSS JOIN` entre 3 sub-queries, generando producto cartesiano (10×50×30 = 15k filas duplicadas). 4 RPCs paralelos son más rápidos y el shape es directamente el que la UI necesita |
| **D2** | Filtro temporal sobre `fecha::DATE` (no `created_at`) | `created_at` es cuándo lo insertamos en NUESTRA DB (depende del cron Dropi); `fecha` es la fecha real del pedido. Para análisis logístico, importa la fecha real |
| **D3** | Excluir `CANCELADO` del análisis de transportadora | `CANCELADO` lo decide la operadora ANTES de despachar — no es responsabilidad del carrier. Mezclarlos distorsiona la tasa de entrega |
| **D4** | Categorías exactas: `entregados=ENTREGADO`, `devueltos=DEVOLUCION+DEVOLUCION EN TRANSITO+RECHAZADO`, `en_transito=EN TRANSPORTE/DESPACHO/TRASLADO/REPARTO/...` | Estados canónicos de Dropi (verificados en `STATUS_COLUMNS` de CrmTable) |
| **D5** | Min 5 pedidos por defecto, parametrizable desde UI (slider) | Sin filtro mínimo, una ciudad con 1 pedido devuelto sale 100% devolución y gana el ranking |
| **D6** | TanStack Query con `staleTime: 5min` | Las queries son agregaciones — no necesitan refresh constante. 5 min de cache reduce carga DB |
| **D7** | Rangos: 7d / 30d / 90d / custom (date picker) | Default 30d. Custom permite analizar campañas específicas |
| **D8** | Tab admin-only (gate `isAdmin` igual que `/admin`) | Decisión expresa del usuario ("abajo de Admin") |
| **D9** | Export CSV (no Excel) por sub-tab | CSV es nativo (`Blob`+`URL.createObjectURL`), no requiere xlsx eager-loaded. Excel ya tenemos lazy en ConfirmarTab; no agregar más peso |
| **D10** | Índices parciales nuevos en `transportadora`, `ciudad`, `producto` | Las RPCs hacen `GROUP BY` sobre esas columnas. Sin índice, seq scan en cada fetch. Partial `WHERE col IS NOT NULL AND col <> ''` evita indexar valores vacíos |

---

## File Structure

```
supabase/migrations/
  20260427130000_logistica_rpcs.sql                 NEW · 4 RPCs + índices

src/lib/
  logistics.types.ts                                NEW · interfaces TS
  csvExport.ts                                      NEW · helper download CSV

src/hooks/
  useLogisticsStats.ts                              NEW · TanStack Query hook

src/components/logistics/
  LogisticsSkeleton.tsx                             NEW · skeleton loaders
  LogisticsErrorState.tsx                           NEW · error UI
  DateRangeFilter.tsx                               NEW · 7d/30d/90d/custom
  MinOrdersFilter.tsx                               NEW · slider
  SummaryCards.tsx                                  NEW · 4 KPIs top
  CarrierStatsTable.tsx                             NEW · tabla + bar chart
  CityReturnsTable.tsx                              NEW · tabla
  ProductFailuresTable.tsx                          NEW · tabla
  SortableHeader.tsx                                NEW · helper para sort

src/components/tabs/
  LogisticaTab.tsx                                  NEW · compone todo

src/pages/
  LogisticsPage.tsx                                 NEW · gate + lazy

src/components/
  ProtectedLayout.tsx                               MODIFY · agregar NAV item

src/
  App.tsx                                           MODIFY · ruta + lazy

src/lib/
  logistics.types.test.ts                           NEW · type guards (smoke)
  csvExport.test.ts                                 NEW · CSV serialization

src/hooks/
  useLogisticsStats.test.ts                         NEW · mock supabase

CLAUDE.md                                           MODIFY · nueva sección
README.md                                           MODIFY · nueva ruta
```

**Diseño de responsabilidades:**
- `logistics.types.ts` — contratos entre backend y frontend (los nombres de campos matchean los `RETURNS TABLE` de las RPCs).
- `useLogisticsStats.ts` — única fuente de verdad de fetches; cualquier componente que necesite stats lo invoca.
- Componentes en `src/components/logistics/` son tontos: reciben data por props, no fetchean.
- `LogisticaTab.tsx` orquesta: invoca el hook, distribuye data a hijos, controla filtros.

---

# Sprint 1 — Backend (RPCs + tipos + hook)

Producto del sprint: 4 RPCs aplicadas en DB + tipos TS sincronizados + hook funcional con tests. **Deployable como PR independiente**: nada se rompe en producción si el frontend no se completa.

## Task 1: Migration con índices y 4 RPCs

**Files:**
- Create: `supabase/migrations/20260427130000_logistica_rpcs.sql`

- [ ] **Step 1: Crear el archivo de migration con la cabecera**

```sql
-- Logística — RPCs analíticos + índices
--
-- 4 RPCs SECURITY DEFINER con admin gate. Cada una agrega `orders` por
-- una dimensión (carrier / city / product) o devuelve un summary global.
-- Filtran por `fecha::DATE` (la fecha real del pedido), excluyen
-- 'CANCELADO' del numerador/denominador del análisis de carrier (porque
-- es responsabilidad de la operadora, no del transportista).
--
-- Aplicar con `supabase db push`. Idempotente (CREATE OR REPLACE +
-- CREATE INDEX IF NOT EXISTS).

-- ─────────────────────────────────────────────────────────────────
-- Índices parciales para soportar GROUP BY de las RPCs
-- ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_transportadora_partial
  ON public.orders (transportadora)
  WHERE transportadora IS NOT NULL AND transportadora <> '';

CREATE INDEX IF NOT EXISTS idx_orders_ciudad_partial
  ON public.orders (ciudad, departamento)
  WHERE ciudad IS NOT NULL AND ciudad <> '';

CREATE INDEX IF NOT EXISTS idx_orders_producto_partial
  ON public.orders (producto)
  WHERE producto IS NOT NULL AND producto <> '';

-- Índice combinado para WHERE fecha::DATE BETWEEN ... AND ...
-- Usamos índice funcional sobre el cast a DATE.
CREATE INDEX IF NOT EXISTS idx_orders_fecha_date
  ON public.orders ((fecha::date))
  WHERE fecha IS NOT NULL AND fecha <> '';
```

- [ ] **Step 2: RPC `logistics_summary` (KPIs globales)**

Append al archivo:

```sql
-- ─────────────────────────────────────────────────────────────────
-- logistics_summary — KPIs globales (4 cards en el header del tab)
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.logistics_summary(
  p_from_date DATE,
  p_to_date   DATE
)
RETURNS TABLE (
  total_pedidos    BIGINT,
  entregados       BIGINT,
  devueltos        BIGINT,
  en_transito      BIGINT,
  tasa_entrega     NUMERIC,
  tasa_devolucion  NUMERIC,
  valor_entregado  NUMERIC,
  valor_perdido    NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT estado, valor
    FROM public.orders
    WHERE fecha IS NOT NULL
      AND fecha <> ''
      AND fecha::date BETWEEN p_from_date AND p_to_date
      AND UPPER(estado) <> 'CANCELADO'  -- D3
  )
  SELECT
    COUNT(*) AS total_pedidos,
    COUNT(*) FILTER (WHERE UPPER(estado) = 'ENTREGADO') AS entregados,
    COUNT(*) FILTER (WHERE UPPER(estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')) AS devueltos,
    COUNT(*) FILTER (WHERE UPPER(estado) IN
      ('EN TRANSPORTE', 'EN DESPACHO', 'EN TRASLADO NACIONAL',
       'EN TERMINAL ORIGEN', 'EN TERMINAL DESTINO',
       'EN REPARTO', 'EN DISTRIBUCION', 'EN REEXPEDICION',
       'TELEMERCADEO', 'REENVIO', 'REENVÍO',
       'EN BODEGA TRANSPORTADORA', 'ADMITIDA',
       'EN BODEGA DROPI', 'RECOGIDO POR DROPI')) AS en_transito,
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(estado) = 'ENTREGADO'))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0),
      2
    ) AS tasa_entrega,
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(estado) IN
        ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0),
      2
    ) AS tasa_devolucion,
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) = 'ENTREGADO'), 0) AS valor_entregado,
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')), 0) AS valor_perdido
  FROM base;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_summary(DATE, DATE) TO authenticated;
```

- [ ] **Step 3: RPC `logistics_by_carrier`**

Append:

```sql
-- ─────────────────────────────────────────────────────────────────
-- logistics_by_carrier — métricas agrupadas por transportadora
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.logistics_by_carrier(
  p_from_date    DATE,
  p_to_date      DATE,
  p_min_orders   INTEGER DEFAULT 5
)
RETURNS TABLE (
  transportadora   TEXT,
  total_pedidos    BIGINT,
  entregados       BIGINT,
  devueltos        BIGINT,
  en_transito      BIGINT,
  novedades        BIGINT,
  tasa_entrega     NUMERIC,
  tasa_devolucion  NUMERIC,
  valor_entregado  NUMERIC,
  valor_perdido    NUMERIC,
  avg_dias_entrega NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    o.transportadora::TEXT,
    COUNT(*) AS total_pedidos,
    COUNT(*) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO') AS entregados,
    COUNT(*) FILTER (WHERE UPPER(o.estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')) AS devueltos,
    COUNT(*) FILTER (WHERE UPPER(o.estado) IN
      ('EN TRANSPORTE', 'EN DESPACHO', 'EN TRASLADO NACIONAL',
       'EN TERMINAL ORIGEN', 'EN TERMINAL DESTINO',
       'EN REPARTO', 'EN DISTRIBUCION', 'EN REEXPEDICION',
       'TELEMERCADEO', 'REENVIO', 'REENVÍO')) AS en_transito,
    COUNT(*) FILTER (WHERE UPPER(o.estado) IN
      ('NOVEDAD', 'INTENTO DE ENTREGA')) AS novedades,
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0),
      2
    ) AS tasa_entrega,
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(o.estado) IN
        ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0),
      2
    ) AS tasa_devolucion,
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'), 0) AS valor_entregado,
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')), 0) AS valor_perdido,
    ROUND(AVG(o.dias_conf) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'), 1) AS avg_dias_entrega
  FROM public.orders o
  WHERE o.fecha IS NOT NULL
    AND o.fecha <> ''
    AND o.fecha::date BETWEEN p_from_date AND p_to_date
    AND o.transportadora IS NOT NULL
    AND o.transportadora <> ''
    AND UPPER(o.estado) <> 'CANCELADO'  -- D3
  GROUP BY o.transportadora
  HAVING COUNT(*) >= p_min_orders
  ORDER BY entregados DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_by_carrier(DATE, DATE, INTEGER) TO authenticated;
```

- [ ] **Step 4: RPC `logistics_by_city`**

Append:

```sql
-- ─────────────────────────────────────────────────────────────────
-- logistics_by_city — devoluciones por ciudad (Top N)
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.logistics_by_city(
  p_from_date    DATE,
  p_to_date      DATE,
  p_min_orders   INTEGER DEFAULT 5,
  p_limit        INTEGER DEFAULT 50
)
RETURNS TABLE (
  ciudad           TEXT,
  departamento     TEXT,
  total_pedidos    BIGINT,
  entregados       BIGINT,
  devueltos        BIGINT,
  tasa_devolucion  NUMERIC,
  tasa_entrega     NUMERIC,
  valor_perdido    NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    o.ciudad::TEXT,
    COALESCE(o.departamento, '')::TEXT AS departamento,
    COUNT(*) AS total_pedidos,
    COUNT(*) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO') AS entregados,
    COUNT(*) FILTER (WHERE UPPER(o.estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')) AS devueltos,
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(o.estado) IN
        ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0),
      2
    ) AS tasa_devolucion,
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0),
      2
    ) AS tasa_entrega,
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')), 0) AS valor_perdido
  FROM public.orders o
  WHERE o.fecha IS NOT NULL
    AND o.fecha <> ''
    AND o.fecha::date BETWEEN p_from_date AND p_to_date
    AND o.ciudad IS NOT NULL
    AND o.ciudad <> ''
    AND UPPER(o.estado) <> 'CANCELADO'
  GROUP BY o.ciudad, COALESCE(o.departamento, '')
  HAVING COUNT(*) >= p_min_orders
  ORDER BY tasa_devolucion DESC, total_pedidos DESC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_by_city(DATE, DATE, INTEGER, INTEGER) TO authenticated;
```

- [ ] **Step 5: RPC `logistics_by_product`**

Append:

```sql
-- ─────────────────────────────────────────────────────────────────
-- logistics_by_product — productos con peor entrega (Top N)
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.logistics_by_product(
  p_from_date    DATE,
  p_to_date      DATE,
  p_min_orders   INTEGER DEFAULT 5,
  p_limit        INTEGER DEFAULT 50
)
RETURNS TABLE (
  producto         TEXT,
  total_pedidos    BIGINT,
  entregados       BIGINT,
  devueltos        BIGINT,
  tasa_entrega     NUMERIC,
  tasa_devolucion  NUMERIC,
  valor_entregado  NUMERIC,
  valor_perdido    NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    o.producto::TEXT,
    COUNT(*) AS total_pedidos,
    COUNT(*) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO') AS entregados,
    COUNT(*) FILTER (WHERE UPPER(o.estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')) AS devueltos,
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0),
      2
    ) AS tasa_entrega,
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(o.estado) IN
        ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0),
      2
    ) AS tasa_devolucion,
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'), 0) AS valor_entregado,
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')), 0) AS valor_perdido
  FROM public.orders o
  WHERE o.fecha IS NOT NULL
    AND o.fecha <> ''
    AND o.fecha::date BETWEEN p_from_date AND p_to_date
    AND o.producto IS NOT NULL
    AND o.producto <> ''
    AND UPPER(o.estado) <> 'CANCELADO'
  GROUP BY o.producto
  HAVING COUNT(*) >= p_min_orders
  ORDER BY tasa_entrega ASC, total_pedidos DESC  -- los PEORES primero
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_by_product(DATE, DATE, INTEGER, INTEGER) TO authenticated;
```

- [ ] **Step 6: Aplicar migration en local y verificar**

Run: `supabase db push`
Expected: `Applying migration 20260427130000_logistica_rpcs.sql ... done` sin errores.

Sanity checks SQL en psql / SQL editor de Supabase:

```sql
-- Verificar índices creados
SELECT indexname FROM pg_indexes
WHERE tablename = 'orders'
  AND indexname IN (
    'idx_orders_transportadora_partial',
    'idx_orders_ciudad_partial',
    'idx_orders_producto_partial',
    'idx_orders_fecha_date'
  );
-- Expected: 4 filas

-- Verificar funciones
SELECT proname FROM pg_proc
WHERE proname IN (
  'logistics_summary',
  'logistics_by_carrier',
  'logistics_by_city',
  'logistics_by_product'
);
-- Expected: 4 filas

-- Smoke test (corriendo como admin)
SELECT * FROM public.logistics_summary(
  CURRENT_DATE - INTERVAL '30 days',
  CURRENT_DATE
);
-- Expected: 1 fila con números
```

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260427130000_logistica_rpcs.sql
git commit -m "feat(logistica): RPCs analíticos + índices parciales"
```

---

## Task 2: Tipos TypeScript

**Files:**
- Create: `src/lib/logistics.types.ts`
- Create: `src/lib/logistics.types.test.ts`

- [ ] **Step 1: Escribir el test primero (smoke type guard)**

```typescript
// src/lib/logistics.types.test.ts
import { describe, it, expect } from 'vitest';
import { isLogisticsSummary } from './logistics.types';

describe('isLogisticsSummary', () => {
  it('acepta un summary válido', () => {
    const sample = {
      total_pedidos: 1000,
      entregados: 700,
      devueltos: 100,
      en_transito: 200,
      tasa_entrega: 70.0,
      tasa_devolucion: 10.0,
      valor_entregado: 50000000,
      valor_perdido: 5000000,
    };
    expect(isLogisticsSummary(sample)).toBe(true);
  });

  it('rechaza objeto sin total_pedidos', () => {
    expect(isLogisticsSummary({ entregados: 0 })).toBe(false);
  });

  it('rechaza null', () => {
    expect(isLogisticsSummary(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (debe fallar — módulo no existe)**

Run: `npx vitest run src/lib/logistics.types.test.ts`
Expected: FAIL — `Cannot find module './logistics.types'`

- [ ] **Step 3: Crear `src/lib/logistics.types.ts`**

```typescript
// Contratos de datos entre RPCs (supabase/migrations/20260427130000)
// y el frontend. Los nombres de campos matchean exactamente los
// `RETURNS TABLE (...)` de cada RPC — si cambia uno, cambia el otro.

export interface LogisticsSummary {
  total_pedidos: number;
  entregados: number;
  devueltos: number;
  en_transito: number;
  tasa_entrega: number;      // 0-100
  tasa_devolucion: number;   // 0-100
  valor_entregado: number;   // COP
  valor_perdido: number;     // COP
}

export interface CarrierStats {
  transportadora: string;
  total_pedidos: number;
  entregados: number;
  devueltos: number;
  en_transito: number;
  novedades: number;
  tasa_entrega: number;
  tasa_devolucion: number;
  valor_entregado: number;
  valor_perdido: number;
  avg_dias_entrega: number | null;
}

export interface CityReturns {
  ciudad: string;
  departamento: string;
  total_pedidos: number;
  entregados: number;
  devueltos: number;
  tasa_devolucion: number;
  tasa_entrega: number;
  valor_perdido: number;
}

export interface ProductFailure {
  producto: string;
  total_pedidos: number;
  entregados: number;
  devueltos: number;
  tasa_entrega: number;
  tasa_devolucion: number;
  valor_entregado: number;
  valor_perdido: number;
}

export interface LogisticsFilters {
  fromDate: string;     // YYYY-MM-DD
  toDate: string;       // YYYY-MM-DD
  minOrders: number;    // default 5
}

// Type guard runtime — defensivo contra payloads malformados de Supabase.
export function isLogisticsSummary(v: unknown): v is LogisticsSummary {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.total_pedidos === 'number' &&
    typeof o.entregados === 'number' &&
    typeof o.devueltos === 'number' &&
    typeof o.tasa_entrega === 'number'
  );
}
```

- [ ] **Step 4: Run test (debe pasar)**

Run: `npx vitest run src/lib/logistics.types.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/logistics.types.ts src/lib/logistics.types.test.ts
git commit -m "feat(logistica): tipos TS + type guard"
```

---

## Task 3: Hook `useLogisticsStats` con TanStack Query

**Files:**
- Create: `src/hooks/useLogisticsStats.ts`
- Create: `src/hooks/useLogisticsStats.test.ts`

- [ ] **Step 1: Test del hook (mocking supabase)**

```typescript
// src/hooks/useLogisticsStats.test.ts
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useLogisticsStats } from './useLogisticsStats';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: vi.fn().mockImplementation((fn: string) => {
      if (fn === 'logistics_summary') {
        return Promise.resolve({
          data: [{
            total_pedidos: 100, entregados: 70, devueltos: 10,
            en_transito: 20, tasa_entrega: 70, tasa_devolucion: 10,
            valor_entregado: 1000, valor_perdido: 100,
          }],
          error: null,
        });
      }
      return Promise.resolve({ data: [], error: null });
    }),
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client: qc }, children);
};

describe('useLogisticsStats', () => {
  it('devuelve summary tras la query', async () => {
    const { result } = renderHook(
      () => useLogisticsStats({ fromDate: '2026-04-01', toDate: '2026-04-27', minOrders: 5 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.summary.isSuccess).toBe(true));
    expect(result.current.summary.data?.total_pedidos).toBe(100);
  });

  it('expone loading mientras espera', () => {
    const { result } = renderHook(
      () => useLogisticsStats({ fromDate: '2026-04-01', toDate: '2026-04-27', minOrders: 5 }),
      { wrapper },
    );
    expect(result.current.summary.isLoading).toBe(true);
  });
});
```

- [ ] **Step 2: Run test (debe fallar)**

Run: `npx vitest run src/hooks/useLogisticsStats.test.ts`
Expected: FAIL — `Cannot find module './useLogisticsStats'`

- [ ] **Step 3: Implementar el hook**

```typescript
// src/hooks/useLogisticsStats.ts
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type {
  LogisticsSummary,
  CarrierStats,
  CityReturns,
  ProductFailure,
  LogisticsFilters,
} from '@/lib/logistics.types';

const STALE_5MIN = 5 * 60 * 1000;

interface RpcResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

async function callRpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await (supabase.rpc as unknown as (
    fn: string, args: Record<string, unknown>
  ) => Promise<RpcResult<T>>)(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data ?? [];
}

export interface UseLogisticsStatsResult {
  summary: UseQueryResult<LogisticsSummary | null>;
  carriers: UseQueryResult<CarrierStats[]>;
  cities: UseQueryResult<CityReturns[]>;
  products: UseQueryResult<ProductFailure[]>;
  isLoading: boolean;
  isError: boolean;
}

export function useLogisticsStats(filters: LogisticsFilters): UseLogisticsStatsResult {
  const { fromDate, toDate, minOrders } = filters;
  const baseKey = ['logistics', fromDate, toDate, minOrders] as const;

  const summary = useQuery<LogisticsSummary | null>({
    queryKey: [...baseKey, 'summary'],
    queryFn: async () => {
      const rows = await callRpc<LogisticsSummary>('logistics_summary', {
        p_from_date: fromDate,
        p_to_date: toDate,
      });
      return rows[0] ?? null;
    },
    staleTime: STALE_5MIN,
  });

  const carriers = useQuery<CarrierStats[]>({
    queryKey: [...baseKey, 'carriers'],
    queryFn: () => callRpc<CarrierStats>('logistics_by_carrier', {
      p_from_date: fromDate,
      p_to_date: toDate,
      p_min_orders: minOrders,
    }),
    staleTime: STALE_5MIN,
  });

  const cities = useQuery<CityReturns[]>({
    queryKey: [...baseKey, 'cities'],
    queryFn: () => callRpc<CityReturns>('logistics_by_city', {
      p_from_date: fromDate,
      p_to_date: toDate,
      p_min_orders: minOrders,
      p_limit: 50,
    }),
    staleTime: STALE_5MIN,
  });

  const products = useQuery<ProductFailure[]>({
    queryKey: [...baseKey, 'products'],
    queryFn: () => callRpc<ProductFailure>('logistics_by_product', {
      p_from_date: fromDate,
      p_to_date: toDate,
      p_min_orders: minOrders,
      p_limit: 50,
    }),
    staleTime: STALE_5MIN,
  });

  return {
    summary, carriers, cities, products,
    isLoading: summary.isLoading || carriers.isLoading || cities.isLoading || products.isLoading,
    isError: summary.isError || carriers.isError || cities.isError || products.isError,
  };
}
```

- [ ] **Step 4: Run test (debe pasar)**

Run: `npx vitest run src/hooks/useLogisticsStats.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useLogisticsStats.ts src/hooks/useLogisticsStats.test.ts
git commit -m "feat(logistica): hook useLogisticsStats con TanStack Query"
```

---

# Sprint 2 — Componentes base

Producto: filtros + skeletons + KPIs + helper export. **Deployable** porque no se referencia desde rutas todavía (los componentes existen pero el sidebar no los expone).

## Task 4: `DateRangeFilter` + `MinOrdersFilter`

**Files:**
- Create: `src/components/logistics/DateRangeFilter.tsx`
- Create: `src/components/logistics/MinOrdersFilter.tsx`

- [ ] **Step 1: `DateRangeFilter`**

```tsx
// src/components/logistics/DateRangeFilter.tsx
import { memo, useCallback } from 'react';
import { Calendar } from 'lucide-react';

interface Range {
  fromDate: string;
  toDate: string;
}

interface Props {
  value: Range;
  onChange: (next: Range) => void;
}

const PRESETS: { label: string; days: number }[] = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

export default memo(function DateRangeFilter({ value, onChange }: Props) {
  const applyPreset = useCallback((days: number) => {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - days);
    onChange({ fromDate: isoDate(from), toDate: isoDate(to) });
  }, [onChange]);

  // Detecta cuál preset coincide para resaltar.
  const activePreset = PRESETS.find(p => {
    const expectedFrom = new Date();
    expectedFrom.setDate(expectedFrom.getDate() - p.days);
    return isoDate(expectedFrom) === value.fromDate
        && isoDate(new Date()) === value.toDate;
  })?.label;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Calendar size={14} className="text-muted-foreground" aria-hidden="true" />
      <span className="text-xs text-muted-foreground">Rango:</span>
      <div className="flex gap-1">
        {PRESETS.map(p => (
          <button
            key={p.label}
            type="button"
            onClick={() => applyPreset(p.days)}
            aria-pressed={activePreset === p.label}
            className={`px-3 py-1 rounded-lg text-xs font-semibold border transition-colors ${
              activePreset === p.label
                ? 'bg-accent text-accent-foreground border-accent'
                : 'bg-card text-muted-foreground border-border hover:text-foreground'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <input
        type="date"
        value={value.fromDate}
        max={value.toDate}
        onChange={e => onChange({ ...value, fromDate: e.target.value })}
        aria-label="Desde"
        className="text-xs px-2 py-1 rounded-lg bg-card border border-border focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <span className="text-xs text-muted-foreground">→</span>
      <input
        type="date"
        value={value.toDate}
        min={value.fromDate}
        onChange={e => onChange({ ...value, toDate: e.target.value })}
        aria-label="Hasta"
        className="text-xs px-2 py-1 rounded-lg bg-card border border-border focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
    </div>
  );
});
```

- [ ] **Step 2: `MinOrdersFilter`**

```tsx
// src/components/logistics/MinOrdersFilter.tsx
import { memo, useCallback } from 'react';
import { Filter } from 'lucide-react';

interface Props {
  value: number;
  onChange: (n: number) => void;
}

export default memo(function MinOrdersFilter({ value, onChange }: Props) {
  const handle = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const n = parseInt(e.target.value, 10);
    if (Number.isFinite(n) && n >= 1) onChange(n);
  }, [onChange]);

  return (
    <div className="flex items-center gap-2">
      <Filter size={14} className="text-muted-foreground" aria-hidden="true" />
      <label htmlFor="min-orders" className="text-xs text-muted-foreground">
        Mínimo de pedidos:
      </label>
      <input
        id="min-orders"
        type="number"
        min={1}
        max={100}
        value={value}
        onChange={handle}
        className="w-16 text-xs px-2 py-1 rounded-lg bg-card border border-border tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <span className="text-[10px] text-muted-foreground/70">
        (filtra ruido en rankings)
      </span>
    </div>
  );
});
```

- [ ] **Step 3: Smoke render — typecheck**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: 0 errores.

- [ ] **Step 4: Commit**

```bash
git add src/components/logistics/
git commit -m "feat(logistica): DateRangeFilter + MinOrdersFilter"
```

---

## Task 5: `SummaryCards`

**Files:**
- Create: `src/components/logistics/SummaryCards.tsx`

- [ ] **Step 1: Implementar**

```tsx
// src/components/logistics/SummaryCards.tsx
import { memo } from 'react';
import { Package, CheckCircle2, RotateCcw, TrendingUp } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import type { LogisticsSummary } from '@/lib/logistics.types';

interface Props {
  data: LogisticsSummary | null;
}

interface Card {
  label: string;
  value: string;
  hint?: string;
  icon: typeof Package;
  tone: 'neutral' | 'success' | 'danger' | 'accent';
}

const TONE: Record<Card['tone'], string> = {
  neutral: 'border-border bg-card',
  success: 'border-emerald-500/30 bg-emerald-500/5',
  danger:  'border-red-500/30 bg-red-500/5',
  accent:  'border-accent/30 bg-accent/5',
};

export default memo(function SummaryCards({ data }: Props) {
  if (!data) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[0,1,2,3].map(i => (
          <div key={i} className="h-24 rounded-xl border border-border bg-card animate-pulse" />
        ))}
      </div>
    );
  }

  const cards: Card[] = [
    {
      label: 'Total envíos',
      value: data.total_pedidos.toLocaleString('es-CO'),
      hint: 'Excluye cancelados',
      icon: Package,
      tone: 'neutral',
    },
    {
      label: 'Entregados',
      value: data.entregados.toLocaleString('es-CO'),
      hint: `${data.tasa_entrega.toFixed(1)}% de tasa`,
      icon: CheckCircle2,
      tone: 'success',
    },
    {
      label: 'Devueltos',
      value: data.devueltos.toLocaleString('es-CO'),
      hint: `${data.tasa_devolucion.toFixed(1)}% de tasa`,
      icon: RotateCcw,
      tone: 'danger',
    },
    {
      label: 'Valor entregado',
      value: formatCOP(data.valor_entregado),
      hint: `Perdido: ${formatCOP(data.valor_perdido)}`,
      icon: TrendingUp,
      tone: 'accent',
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label="Resumen logístico">
      {cards.map(c => {
        const Icon = c.icon;
        return (
          <div key={c.label} className={`rounded-xl border p-4 ${TONE[c.tone]}`}>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
              <Icon size={13} aria-hidden="true" />
              <span>{c.label}</span>
            </div>
            <div className="text-2xl font-bold text-foreground tabular-nums">{c.value}</div>
            {c.hint && (
              <div className="text-[11px] text-muted-foreground mt-1">{c.hint}</div>
            )}
          </div>
        );
      })}
    </div>
  );
});
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: 0 errores.

- [ ] **Step 3: Commit**

```bash
git add src/components/logistics/SummaryCards.tsx
git commit -m "feat(logistica): SummaryCards (4 KPIs top)"
```

---

## Task 6: `LogisticsSkeleton` + `LogisticsErrorState`

**Files:**
- Create: `src/components/logistics/LogisticsSkeleton.tsx`
- Create: `src/components/logistics/LogisticsErrorState.tsx`

- [ ] **Step 1: Skeleton**

```tsx
// src/components/logistics/LogisticsSkeleton.tsx
export default function LogisticsSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Cargando logística">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[0,1,2,3].map(i => (
          <div key={i} className="h-24 rounded-xl border border-border bg-card animate-pulse" />
        ))}
      </div>
      <div className="h-64 rounded-xl border border-border bg-card animate-pulse" />
      <div className="h-96 rounded-xl border border-border bg-card animate-pulse" />
    </div>
  );
}
```

- [ ] **Step 2: ErrorState**

```tsx
// src/components/logistics/LogisticsErrorState.tsx
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  message?: string;
  onRetry?: () => void;
}

export default function LogisticsErrorState({ message, onRetry }: Props) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/40 px-6 py-16 text-center" role="alert">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10">
        <AlertTriangle size={20} className="text-red-500" aria-hidden="true" />
      </div>
      <h3 className="text-base font-semibold text-foreground">No se pudo cargar la información</h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        {message || 'Verifica tu conexión o tu rol de admin.'}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold hover:border-border-strong"
        >
          <RefreshCw size={14} aria-hidden="true" /> Reintentar
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/logistics/LogisticsSkeleton.tsx src/components/logistics/LogisticsErrorState.tsx
git commit -m "feat(logistica): skeleton + error state"
```

---

## Task 7: Helper `csvExport`

**Files:**
- Create: `src/lib/csvExport.ts`
- Create: `src/lib/csvExport.test.ts`

- [ ] **Step 1: Tests**

```typescript
// src/lib/csvExport.test.ts
import { describe, it, expect } from 'vitest';
import { rowsToCsv } from './csvExport';

describe('rowsToCsv', () => {
  it('serializa header + filas básicas', () => {
    const csv = rowsToCsv(
      ['nombre', 'edad'],
      [{ nombre: 'Juan', edad: 30 }, { nombre: 'Ana', edad: 25 }],
    );
    expect(csv).toBe('nombre,edad\nJuan,30\nAna,25');
  });

  it('escapa comas y quotes', () => {
    const csv = rowsToCsv(['x'], [{ x: 'a,b' }, { x: 'a"b' }]);
    expect(csv).toBe('x\n"a,b"\n"a""b"');
  });

  it('representa null/undefined como vacío', () => {
    const csv = rowsToCsv(['x'], [{ x: null }, { x: undefined }]);
    expect(csv).toBe('x\n\n');
  });
});
```

- [ ] **Step 2: Run test (fail)**

Run: `npx vitest run src/lib/csvExport.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Implementar**

```typescript
// src/lib/csvExport.ts
function escapeCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv<T extends Record<string, unknown>>(
  headers: (keyof T & string)[],
  rows: T[],
): string {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => escapeCell(row[h])).join(','));
  }
  return lines.join('\n');
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 4: Test pasa**

Run: `npx vitest run src/lib/csvExport.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/csvExport.ts src/lib/csvExport.test.ts
git commit -m "feat(logistica): helper rowsToCsv + downloadCsv"
```

---

# Sprint 3 — Sub-tabs y wiring

Producto: tab funcional + ruta + sidebar visible. **Deployable como feature completa.**

## Task 8: `SortableHeader` helper + `CarrierStatsTable`

**Files:**
- Create: `src/components/logistics/SortableHeader.tsx`
- Create: `src/components/logistics/CarrierStatsTable.tsx`

- [ ] **Step 1: `SortableHeader`**

```tsx
// src/components/logistics/SortableHeader.tsx
import { memo } from 'react';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';

export type SortDir = 'asc' | 'desc';

interface Props<Key extends string> {
  label: string;
  sortKey: Key;
  activeKey: Key | null;
  activeDir: SortDir;
  onSort: (key: Key) => void;
  className?: string;
}

function SortableHeaderInner<Key extends string>({
  label, sortKey, activeKey, activeDir, onSort, className,
}: Props<Key>) {
  const isActive = activeKey === sortKey;
  const Icon = !isActive ? ChevronsUpDown : activeDir === 'asc' ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={`inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider hover:text-foreground transition-colors ${
        isActive ? 'text-foreground' : 'text-muted-foreground'
      } ${className || ''}`}
      aria-sort={isActive ? (activeDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span>{label}</span>
      <Icon size={11} aria-hidden="true" />
    </button>
  );
}

export const SortableHeader = memo(SortableHeaderInner) as typeof SortableHeaderInner;
```

- [ ] **Step 2: `CarrierStatsTable`**

```tsx
// src/components/logistics/CarrierStatsTable.tsx
import { memo, useMemo, useState } from 'react';
import { Download, Truck } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { formatCOP } from '@/lib/utils';
import { rowsToCsv, downloadCsv } from '@/lib/csvExport';
import { SortableHeader, type SortDir } from './SortableHeader';
import type { CarrierStats } from '@/lib/logistics.types';

interface Props { rows: CarrierStats[]; }

type Key = keyof CarrierStats;

export default memo(function CarrierStatsTable({ rows }: Props) {
  const [sortKey, setSortKey] = useState<Key>('entregados');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      return sortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return out;
  }, [rows, sortKey, sortDir]);

  const onSort = (k: Key) => {
    if (k === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  };

  const exportCsv = () => {
    const csv = rowsToCsv<CarrierStats>(
      ['transportadora', 'total_pedidos', 'entregados', 'devueltos',
       'tasa_entrega', 'tasa_devolucion', 'valor_entregado', 'valor_perdido', 'avg_dias_entrega'],
      sorted,
    );
    downloadCsv(`logistica-transportadoras-${new Date().toISOString().split('T')[0]}.csv`, csv);
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
        <Truck size={20} className="mx-auto text-muted-foreground mb-2" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">
          No hay transportadoras con suficientes pedidos en este rango.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Bar chart Top 5 — entregas vs devoluciones */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Top 5 — entrega vs devolución (%)</h3>
        </div>
        <ResponsiveContainer width="100%" height={Math.max(180, sorted.slice(0, 5).length * 36)}>
          <BarChart data={sorted.slice(0, 5)} layout="vertical" margin={{ left: 80, right: 12 }}>
            <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="transportadora" tick={{ fontSize: 11 }} width={140} />
            <Tooltip
              formatter={(v: number, n: string) => [`${v.toFixed(1)}%`, n]}
              contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 12 }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="tasa_entrega"     name="Entrega %"    fill="#10b981" />
            <Bar dataKey="tasa_devolucion"  name="Devolución %" fill="#ef4444" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Tabla detalle */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between p-3 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">Detalle por transportadora</h3>
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold hover:border-border-strong"
          >
            <Download size={12} aria-hidden="true" /> CSV
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface/40">
              <tr className="text-left">
                <th className="px-3 py-2"><SortableHeader<Key> label="Transportadora" sortKey="transportadora" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Envíos" sortKey="total_pedidos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Entregados" sortKey="entregados" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Devueltos" sortKey="devueltos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Entrega %" sortKey="tasa_entrega" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Devol %" sortKey="tasa_devolucion" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Días promedio" sortKey="avg_dias_entrega" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Valor entregado" sortKey="valor_entregado" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(r => (
                <tr key={r.transportadora} className="border-t border-border/50 hover:bg-card/60">
                  <td className="px-3 py-2 font-semibold text-foreground">{r.transportadora}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.total_pedidos.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-500">{r.entregados.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-red-500">{r.devueltos.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.tasa_entrega.toFixed(1)}%</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.tasa_devolucion.toFixed(1)}%</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.avg_dias_entrega != null ? `${r.avg_dias_entrega}d` : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-mono text-xs">{formatCOP(r.valor_entregado)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
});
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: 0 errores.

- [ ] **Step 4: Commit**

```bash
git add src/components/logistics/SortableHeader.tsx src/components/logistics/CarrierStatsTable.tsx
git commit -m "feat(logistica): tabla transportadoras con sort + chart + CSV"
```

---

## Task 9: `CityReturnsTable`

**Files:**
- Create: `src/components/logistics/CityReturnsTable.tsx`

- [ ] **Step 1: Implementar (mismo patrón que CarrierStats, simplificado sin chart)**

```tsx
// src/components/logistics/CityReturnsTable.tsx
import { memo, useMemo, useState } from 'react';
import { Download, MapPin } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import { rowsToCsv, downloadCsv } from '@/lib/csvExport';
import { SortableHeader, type SortDir } from './SortableHeader';
import type { CityReturns } from '@/lib/logistics.types';

interface Props { rows: CityReturns[]; }

type Key = keyof CityReturns;

export default memo(function CityReturnsTable({ rows }: Props) {
  const [sortKey, setSortKey] = useState<Key>('tasa_devolucion');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      return sortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return out;
  }, [rows, sortKey, sortDir]);

  const onSort = (k: Key) => {
    if (k === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  };

  const exportCsv = () => {
    const csv = rowsToCsv<CityReturns>(
      ['ciudad', 'departamento', 'total_pedidos', 'entregados', 'devueltos',
       'tasa_entrega', 'tasa_devolucion', 'valor_perdido'],
      sorted,
    );
    downloadCsv(`logistica-ciudades-${new Date().toISOString().split('T')[0]}.csv`, csv);
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
        <MapPin size={20} className="mx-auto text-muted-foreground mb-2" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">
          No hay ciudades con suficientes pedidos en este rango.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">
          Top {sorted.length} ciudades por tasa de devolución
        </h3>
        <button
          type="button"
          onClick={exportCsv}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold hover:border-border-strong"
        >
          <Download size={12} aria-hidden="true" /> CSV
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface/40">
            <tr className="text-left">
              <th className="px-3 py-2 w-8">#</th>
              <th className="px-3 py-2"><SortableHeader<Key> label="Ciudad" sortKey="ciudad" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              <th className="px-3 py-2"><SortableHeader<Key> label="Depto" sortKey="departamento" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Envíos" sortKey="total_pedidos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Devueltos" sortKey="devueltos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Devol %" sortKey="tasa_devolucion" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Valor perdido" sortKey="valor_perdido" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, idx) => (
              <tr key={`${r.ciudad}|${r.departamento}`} className="border-t border-border/50 hover:bg-card/60">
                <td className="px-3 py-2 text-muted-foreground tabular-nums">{idx + 1}</td>
                <td className="px-3 py-2 font-semibold text-foreground">{r.ciudad}</td>
                <td className="px-3 py-2 text-muted-foreground">{r.departamento || '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.total_pedidos.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2 text-right tabular-nums text-red-500">{r.devueltos.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2 text-right tabular-nums font-bold">{r.tasa_devolucion.toFixed(1)}%</td>
                <td className="px-3 py-2 text-right tabular-nums font-mono text-xs text-red-500">{formatCOP(r.valor_perdido)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});
```

- [ ] **Step 2: Commit**

```bash
git add src/components/logistics/CityReturnsTable.tsx
git commit -m "feat(logistica): tabla ciudades con sort + CSV"
```

---

## Task 10: `ProductFailuresTable`

**Files:**
- Create: `src/components/logistics/ProductFailuresTable.tsx`

- [ ] **Step 1: Implementar (mismo patrón)**

```tsx
// src/components/logistics/ProductFailuresTable.tsx
import { memo, useMemo, useState } from 'react';
import { Download, Package } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import { rowsToCsv, downloadCsv } from '@/lib/csvExport';
import { SortableHeader, type SortDir } from './SortableHeader';
import type { ProductFailure } from '@/lib/logistics.types';

interface Props { rows: ProductFailure[]; }

type Key = keyof ProductFailure;

export default memo(function ProductFailuresTable({ rows }: Props) {
  const [sortKey, setSortKey] = useState<Key>('tasa_entrega');
  const [sortDir, setSortDir] = useState<SortDir>('asc'); // los PEORES primero

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      return sortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return out;
  }, [rows, sortKey, sortDir]);

  const onSort = (k: Key) => {
    if (k === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir(k === 'tasa_entrega' ? 'asc' : 'desc'); }
  };

  const exportCsv = () => {
    const csv = rowsToCsv<ProductFailure>(
      ['producto', 'total_pedidos', 'entregados', 'devueltos',
       'tasa_entrega', 'tasa_devolucion', 'valor_entregado', 'valor_perdido'],
      sorted,
    );
    downloadCsv(`logistica-productos-${new Date().toISOString().split('T')[0]}.csv`, csv);
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
        <Package size={20} className="mx-auto text-muted-foreground mb-2" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">
          No hay productos con suficientes pedidos en este rango.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">
          Top {sorted.length} productos con menor tasa de entrega
        </h3>
        <button
          type="button"
          onClick={exportCsv}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold hover:border-border-strong"
        >
          <Download size={12} aria-hidden="true" /> CSV
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface/40">
            <tr className="text-left">
              <th className="px-3 py-2 w-8">#</th>
              <th className="px-3 py-2"><SortableHeader<Key> label="Producto" sortKey="producto" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Envíos" sortKey="total_pedidos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Entregados" sortKey="entregados" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Devueltos" sortKey="devueltos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Entrega %" sortKey="tasa_entrega" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Devol %" sortKey="tasa_devolucion" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Valor perdido" sortKey="valor_perdido" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, idx) => (
              <tr key={r.producto} className="border-t border-border/50 hover:bg-card/60">
                <td className="px-3 py-2 text-muted-foreground tabular-nums">{idx + 1}</td>
                <td className="px-3 py-2 font-semibold text-foreground max-w-md truncate" title={r.producto}>{r.producto}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.total_pedidos.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2 text-right tabular-nums text-emerald-500">{r.entregados.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2 text-right tabular-nums text-red-500">{r.devueltos.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2 text-right tabular-nums font-bold">{r.tasa_entrega.toFixed(1)}%</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.tasa_devolucion.toFixed(1)}%</td>
                <td className="px-3 py-2 text-right tabular-nums font-mono text-xs text-red-500">{formatCOP(r.valor_perdido)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});
```

- [ ] **Step 2: Commit**

```bash
git add src/components/logistics/ProductFailuresTable.tsx
git commit -m "feat(logistica): tabla productos con sort + CSV"
```

---

## Task 11: `LogisticaTab` (orquestador)

**Files:**
- Create: `src/components/tabs/LogisticaTab.tsx`

- [ ] **Step 1: Implementar**

```tsx
// src/components/tabs/LogisticaTab.tsx
import { useState, useMemo } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useLogisticsStats } from '@/hooks/useLogisticsStats';
import DateRangeFilter from '@/components/logistics/DateRangeFilter';
import MinOrdersFilter from '@/components/logistics/MinOrdersFilter';
import SummaryCards from '@/components/logistics/SummaryCards';
import CarrierStatsTable from '@/components/logistics/CarrierStatsTable';
import CityReturnsTable from '@/components/logistics/CityReturnsTable';
import ProductFailuresTable from '@/components/logistics/ProductFailuresTable';
import LogisticsSkeleton from '@/components/logistics/LogisticsSkeleton';
import LogisticsErrorState from '@/components/logistics/LogisticsErrorState';
import type { LogisticsFilters } from '@/lib/logistics.types';
import { Truck, MapPin, Package } from 'lucide-react';

function defaultRange(): { fromDate: string; toDate: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return {
    fromDate: from.toISOString().split('T')[0],
    toDate: to.toISOString().split('T')[0],
  };
}

export default function LogisticaTab() {
  const [filters, setFilters] = useState<LogisticsFilters>(() => ({
    ...defaultRange(),
    minOrders: 5,
  }));

  const { summary, carriers, cities, products, isLoading, isError } = useLogisticsStats(filters);

  const errorMsg = useMemo(() => {
    if (summary.isError)  return summary.error?.message;
    if (carriers.isError) return carriers.error?.message;
    if (cities.isError)   return cities.error?.message;
    if (products.isError) return products.error?.message;
    return undefined;
  }, [summary, carriers, cities, products]);

  const refetchAll = () => {
    summary.refetch(); carriers.refetch(); cities.refetch(); products.refetch();
  };

  return (
    <div className="space-y-5">
      {/* Filtros */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between border border-border bg-card rounded-xl p-3.5">
        <DateRangeFilter
          value={{ fromDate: filters.fromDate, toDate: filters.toDate }}
          onChange={r => setFilters(f => ({ ...f, ...r }))}
        />
        <MinOrdersFilter
          value={filters.minOrders}
          onChange={n => setFilters(f => ({ ...f, minOrders: n }))}
        />
      </div>

      {/* Estados globales */}
      {isError && <LogisticsErrorState message={errorMsg} onRetry={refetchAll} />}

      {!isError && isLoading && <LogisticsSkeleton />}

      {!isError && !isLoading && (
        <>
          {/* KPIs */}
          <SummaryCards data={summary.data ?? null} />

          {/* Sub-tabs */}
          <Tabs defaultValue="carriers" className="w-full">
            <TabsList>
              <TabsTrigger value="carriers"><Truck size={13} className="mr-1.5" /> Transportadoras</TabsTrigger>
              <TabsTrigger value="cities"><MapPin size={13} className="mr-1.5" /> Ciudades</TabsTrigger>
              <TabsTrigger value="products"><Package size={13} className="mr-1.5" /> Productos</TabsTrigger>
            </TabsList>

            <TabsContent value="carriers" className="mt-4">
              <CarrierStatsTable rows={carriers.data ?? []} />
            </TabsContent>
            <TabsContent value="cities" className="mt-4">
              <CityReturnsTable rows={cities.data ?? []} />
            </TabsContent>
            <TabsContent value="products" className="mt-4">
              <ProductFailuresTable rows={products.data ?? []} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: 0 errores.

- [ ] **Step 3: Commit**

```bash
git add src/components/tabs/LogisticaTab.tsx
git commit -m "feat(logistica): LogisticaTab orquestador con sub-tabs"
```

---

## Task 12: `LogisticsPage` + ruta + sidebar item

**Files:**
- Create: `src/pages/LogisticsPage.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/ProtectedLayout.tsx`

- [ ] **Step 1: Página wrapper**

```tsx
// src/pages/LogisticsPage.tsx
import { useAuth } from '@/contexts/AuthContext';
import { Navigate } from 'react-router-dom';
import LogisticaTab from '@/components/tabs/LogisticaTab';

export default function LogisticsPage() {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Navigate to="/dashboard" replace />;
  return <LogisticaTab />;
}
```

- [ ] **Step 2: Ruta lazy en `src/App.tsx`**

Buscar el bloque de `lazy(() => import(...))` (líneas 14-22) y agregar:

```tsx
const LogisticsPage = lazy(() => import("@/pages/LogisticsPage"));
```

Y dentro de `<Route element={<ProtectedLayout />}>` agregar:

```tsx
<Route path="/logistica" element={route(<LogisticsPage />)} />
```

(Usar el helper `route()` que ya envuelve cada ruta con su propio ErrorBoundary, OLD-1 de Tanda 5.)

- [ ] **Step 3: Sidebar item en `src/components/ProtectedLayout.tsx`**

Agregar `Truck` al import de `lucide-react` (línea 8):

```tsx
import { BarChart3, Phone, Package, LifeBuoy, Settings, Sun, Moon, LogOut, Menu, AlertTriangle, RefreshCw, X, Truck } from 'lucide-react';
```

Agregar al array `NAV_ITEMS` (línea 24-31), DESPUÉS de Admin:

```tsx
{ path: '/logistica', icon: Truck, label: 'Logística', adminOnly: true },
```

El filtro `visibleTabs = NAV_ITEMS.filter(t => !t.adminOnly || isAdmin)` ya existe (línea 69) y oculta el item para no-admins automáticamente.

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: 0 errores.

Run: `npm run lint`
Expected: 0 errores nuevos.

- [ ] **Step 5: Smoke test manual en dev**

Run: `npm run dev`

Navegar a `http://localhost:8080/logistica` (logueado como admin):
- Ver el sidebar con item "Logística" (icono Truck)
- Ver el título "Logística" en el topbar
- Ver SummaryCards + sub-tabs Transportadoras/Ciudades/Productos
- Cambiar rango fecha → datos se actualizan
- Cambiar min-orders → datos se actualizan
- Click en "CSV" → descarga archivo

Como no-admin, ir a `/logistica` redirige a `/dashboard`.

- [ ] **Step 6: Commit**

```bash
git add src/pages/LogisticsPage.tsx src/App.tsx src/components/ProtectedLayout.tsx
git commit -m "feat(logistica): page wrapper + ruta + sidebar item (admin-only)"
```

---

## Task 13: Tests adicionales del flujo completo

**Files:**
- Create: `src/components/logistics/CarrierStatsTable.test.tsx`

- [ ] **Step 1: Test smoke render**

```tsx
// src/components/logistics/CarrierStatsTable.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import CarrierStatsTable from './CarrierStatsTable';
import type { CarrierStats } from '@/lib/logistics.types';

const SAMPLE: CarrierStats[] = [
  {
    transportadora: 'Servientrega',
    total_pedidos: 100, entregados: 70, devueltos: 10,
    en_transito: 20, novedades: 0,
    tasa_entrega: 70, tasa_devolucion: 10,
    valor_entregado: 5000000, valor_perdido: 500000,
    avg_dias_entrega: 3.2,
  },
];

describe('CarrierStatsTable', () => {
  it('renderiza la transportadora con sus métricas', () => {
    render(<CarrierStatsTable rows={SAMPLE} />);
    expect(screen.getByText('Servientrega')).toBeInTheDocument();
    expect(screen.getByText('70.0%')).toBeInTheDocument();
    expect(screen.getByText('3.2d')).toBeInTheDocument();
  });

  it('muestra empty state si no hay filas', () => {
    render(<CarrierStatsTable rows={[]} />);
    expect(screen.getByText(/no hay transportadoras/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run src/components/logistics/CarrierStatsTable.test.tsx`
Expected: PASS — 2 tests.

- [ ] **Step 3: Commit**

```bash
git add src/components/logistics/CarrierStatsTable.test.tsx
git commit -m "test(logistica): smoke render de CarrierStatsTable"
```

---

## Task 14: Update docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: CLAUDE.md — agregar `/logistica` a la tabla de rutas**

Buscar la tabla "Page / Tab Map" y agregar fila:

```markdown
| `/logistica` | LogisticsPage | LogisticaTab | Análisis admin: rendimiento por transportadora, devoluciones por ciudad, productos con peor entrega |
```

- [ ] **Step 2: CLAUDE.md — agregar a "Key RPCs"**

```markdown
- `logistics_summary(from_date, to_date)` — KPIs globales (total/entregados/devueltos/valor)
- `logistics_by_carrier(from_date, to_date, min_orders)` — métricas por transportadora
- `logistics_by_city(from_date, to_date, min_orders, limit)` — top ciudades por tasa de devolución
- `logistics_by_product(from_date, to_date, min_orders, limit)` — top productos con peor tasa de entrega
- Todas SECURITY DEFINER + admin-only. Ver migration 20260427130000.
```

- [ ] **Step 3: README.md — agregar fila a la tabla de rutas**

```markdown
| `/logistica` | LogisticaTab | Análisis logístico (admin) — transportadoras, ciudades, productos |
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs(logistica): actualiza rutas y RPCs"
```

---

## Self-Review

**1. Spec coverage** — ¿cada requisito tiene tarea?

| Requisito del usuario | Tarea(s) |
|---|---|
| Sección "Logística" abajo de Admin en sidebar | T12 (NAV_ITEMS + ProtectedLayout) |
| Admin-only | T12 (`<Navigate to="/dashboard">` + `adminOnly: true`) |
| Rendimiento por transportadora | T1 (RPC), T8 (tabla + chart) |
| Qué transportadora entrega más | T8 (sort por `entregados` desc) |
| En qué ciudad hay más devoluciones | T1 (RPC), T9 (tabla con sort tasa_devolucion desc) |
| Qué producto no se está entregando | T1 (RPC), T10 (tabla con sort tasa_entrega asc — peores arriba) |
| KPIs globales | T1 (RPC summary), T5 (SummaryCards) |
| Filtro de rango temporal | T4 (DateRangeFilter) |
| Robustez (loading/error) | T6 (Skeleton + ErrorState) |
| Performance | T1 (índices parciales), T3 (TanStack Query cache 5min), T8-T10 (React.memo + useMemo) |
| Export | T7 (csvExport) + T8/T9/T10 (botones CSV) |
| Tests | T2 (types), T3 (hook), T7 (csv), T13 (smoke render) |
| Docs | T14 |

**2. Placeholder scan** — busqué red flags: ningún "TBD", "implement later", ni "similar to". Todo el código está completo.

**3. Type consistency** — los nombres de campos son idénticos en:
- `RETURNS TABLE (...)` de las 4 RPCs
- `interface CarrierStats / CityReturns / ProductFailure / LogisticsSummary`
- `keyof T` de los componentes de tabla
- Headers del CSV export

`avg_dias_entrega` es `NUMERIC` en SQL → `number | null` en TS (ROUND devuelve null si no hay rows que cumplan FILTER). Cubierto en TypeScript.

`tasa_entrega` puede ser `null` también (NULLIF en SQL si total = 0). Componentes lo manejan con `?? 0`.

---

## Tiempo estimado realista

| Sprint | Tareas | Tiempo |
|---|---|---|
| Sprint 1 (backend + tipos + hook) | T1-T3 | 1.5 h |
| Sprint 2 (componentes base) | T4-T7 | 1.5 h |
| Sprint 3 (sub-tabs + wiring + tests + docs) | T8-T14 | 3 h |
| **Total** | **14 tareas** | **~6 h** |

---

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| `avg_dias_entrega` puede ser `null` si no hay entregados | Tipo `number \| null` en TS + render condicional `?? '—'` |
| Locales `'es-CO'` raros en navegadores podrían fallar | Test `formatCOP` en `utils.test.ts` ya cubre. Fallback a regex match en CSV |
| RPC `logistics_summary` con rango grande puede ser lenta sin índice de fecha | T1 crea `idx_orders_fecha_date` funcional |
| Cambios de `STATUS_COLUMNS` en frontend desincronizan con SQL UPPER hardcoded | Comment en migration apunta a `CrmTable.STATUS_COLUMNS` para auditar drift |
| Si `auth.uid()` es null (cron service-role), `has_role` devuelve false → RPC tira excepción | Las RPCs son llamadas SOLO desde frontend autenticado. El cron no las invoca |
| `CROSS JOIN` bug del plan original | Mitigado por D1 (4 RPCs separadas) |

---

## Execution Handoff

Plan guardado en `docs/superpowers/plans/2026-04-27-logistica.md`. Dos opciones de ejecución:

**1. Subagent-Driven (recomendado)** — un subagente fresh por tarea, revisión entre tareas, iteración rápida con `/superpowers:subagent-driven-development`.

**2. Inline Execution** — ejecuto las tareas en esta sesión con `/superpowers:executing-plans`, batch con checkpoints para revisar.

¿Cuál prefieres?
