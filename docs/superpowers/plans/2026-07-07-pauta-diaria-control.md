# Control diario de pauta por tienda — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Una bitácora diaria de pauta por tienda (Meta/TikTok) que se resta de la Ganancia Neta en "Cómo voy" de Logística para mostrar el NETO real, multi-país (CO/EC), visible solo a encargados.

**Architecture:** Tabla nueva `store_ad_spend_daily` (store-scoped, manager-only vía `is_store_manager`), RPCs SECURITY DEFINER para upsert/delete, un hook `useStoreAdSpend`, un panel + diálogo en Logística → Resumen, y el wiring de la resta en `MesActualResumen`. La lectura degrada a vacío si la migration no está aplicada, así "Cómo voy" nunca se rompe.

**Tech Stack:** React 18 + TS (non-strict) + @tanstack/react-query + Supabase (Postgres/RLS) + Tailwind/shadcn + Vitest.

**Spec:** `docs/superpowers/specs/2026-07-07-pauta-diaria-control-design.md`
**Rama:** `agente/pauta-diaria-control` (ya creada, spec commiteado).

---

## File Structure

- **Create** `supabase/migrations/20260707180000_store_ad_spend_daily.sql` — tabla + RLS + trigger + RPCs.
- **Create** `src/hooks/useStoreAdSpend.ts` — query (con degradación) + mutations + `sumAdSpend` puro + labels.
- **Create** `src/hooks/useStoreAdSpend.test.ts` — test unitario de `sumAdSpend`.
- **Create** `src/components/logistics/StoreAdSpendDialog.tsx` — formulario de carga diaria.
- **Create** `src/components/logistics/StoreAdSpendPanel.tsx` — panel "Pauta diaria" (totales + tabla + botón).
- **Modify** `src/components/logistics/MesActualResumen.tsx` — resta de pauta → NETO en el bloque "Wallet REAL".
- **Modify** `src/components/tabs/LogisticaTab.tsx:372` — insertar `<StoreAdSpendPanel filters={filters} />` tras `MesActualResumen`.

---

### Task 1: Migration — tabla `store_ad_spend_daily` + RLS + RPCs

**Files:**
- Create: `supabase/migrations/20260707180000_store_ad_spend_daily.sql`

- [ ] **Step 1: Escribir la migration completa**

```sql
-- Control diario de pauta por tienda (Meta/TikTok), aparte de la mensual del CFO.
-- Store-scoped y manager-only (owner/supervisor) vía is_store_manager. El monto va
-- en la moneda de la tienda (COP en CO, USD en EC) — por eso NO se llama amount_cop.
-- Se resta de la Ganancia Neta en "Cómo voy" para mostrar el NETO real.

CREATE TABLE IF NOT EXISTS public.store_ad_spend_daily (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  spend_date  DATE NOT NULL,
  platform    TEXT NOT NULL CHECK (platform IN ('meta','tiktok','other')),
  amount      NUMERIC NOT NULL DEFAULT 0 CHECK (amount >= 0),
  notas       TEXT,
  created_by  UUID DEFAULT auth.uid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, spend_date, platform)
);

CREATE INDEX IF NOT EXISTS store_ad_spend_daily_store_date_idx
  ON public.store_ad_spend_daily (store_id, spend_date DESC);

-- ── RLS — manager-only por tienda (owner o supervisor) ──────────────────────
ALTER TABLE public.store_ad_spend_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "store_ad_spend_manager_select" ON public.store_ad_spend_daily;
CREATE POLICY "store_ad_spend_manager_select" ON public.store_ad_spend_daily
  FOR SELECT TO authenticated USING (public.is_store_manager(store_id));

DROP POLICY IF EXISTS "store_ad_spend_manager_insert" ON public.store_ad_spend_daily;
CREATE POLICY "store_ad_spend_manager_insert" ON public.store_ad_spend_daily
  FOR INSERT TO authenticated WITH CHECK (public.is_store_manager(store_id));

DROP POLICY IF EXISTS "store_ad_spend_manager_update" ON public.store_ad_spend_daily;
CREATE POLICY "store_ad_spend_manager_update" ON public.store_ad_spend_daily
  FOR UPDATE TO authenticated
  USING (public.is_store_manager(store_id))
  WITH CHECK (public.is_store_manager(store_id));

DROP POLICY IF EXISTS "store_ad_spend_manager_delete" ON public.store_ad_spend_daily;
CREATE POLICY "store_ad_spend_manager_delete" ON public.store_ad_spend_daily
  FOR DELETE TO authenticated USING (public.is_store_manager(store_id));

-- ── Trigger updated_at ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_store_ad_spend_daily_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS store_ad_spend_daily_updated_at_trg ON public.store_ad_spend_daily;
CREATE TRIGGER store_ad_spend_daily_updated_at_trg
  BEFORE UPDATE ON public.store_ad_spend_daily
  FOR EACH ROW EXECUTE FUNCTION public.tg_store_ad_spend_daily_updated_at();

-- ── RPC upsert (idempotente por store_id + spend_date + platform) ───────────
CREATE OR REPLACE FUNCTION public.upsert_store_ad_spend_daily(
  p_store_id   UUID,
  p_spend_date DATE,
  p_platform   TEXT,
  p_amount     NUMERIC,
  p_notas      TEXT
)
RETURNS public.store_ad_spend_daily
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_row public.store_ad_spend_daily;
BEGIN
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'Solo encargados de la tienda' USING ERRCODE = '42501';
  END IF;
  IF p_platform NOT IN ('meta','tiktok','other') THEN
    RAISE EXCEPTION 'platform inválido' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.store_ad_spend_daily (store_id, spend_date, platform, amount, notas, created_by)
  VALUES (p_store_id, p_spend_date, p_platform, COALESCE(p_amount, 0), NULLIF(p_notas, ''), auth.uid())
  ON CONFLICT (store_id, spend_date, platform) DO UPDATE SET
    amount = EXCLUDED.amount,
    notas  = EXCLUDED.notas
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_store_ad_spend_daily(UUID, DATE, TEXT, NUMERIC, TEXT) TO authenticated;

-- ── RPC delete (chequea manager de la tienda dueña de la fila) ──────────────
CREATE OR REPLACE FUNCTION public.delete_store_ad_spend_daily(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_store UUID;
BEGIN
  SELECT store_id INTO v_store FROM public.store_ad_spend_daily WHERE id = p_id;
  IF v_store IS NULL THEN RETURN FALSE; END IF;
  IF NOT public.is_store_manager(v_store) THEN
    RAISE EXCEPTION 'Solo encargados de la tienda' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.store_ad_spend_daily WHERE id = p_id;
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_store_ad_spend_daily(UUID) TO authenticated;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260707180000_store_ad_spend_daily.sql
git commit -m "feat(pauta): migration store_ad_spend_daily + RLS manager + RPCs upsert/delete

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

> **Nota de deploy:** Lovable NO aplica migrations solo. Se aplica con `supabase db push` o prompt a Lovable, y se verifica por REST (ver Task 7).

---

### Task 2: Hook `useStoreAdSpend` + test de `sumAdSpend` (TDD)

**Files:**
- Create: `src/hooks/useStoreAdSpend.ts`
- Test: `src/hooks/useStoreAdSpend.test.ts`

- [ ] **Step 1: Escribir el test que falla**

`src/hooks/useStoreAdSpend.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { sumAdSpend, type StoreAdSpendRow } from './useStoreAdSpend';

function row(platform: 'meta' | 'tiktok' | 'other', amount: number): StoreAdSpendRow {
  return {
    id: 'x', store_id: 's', spend_date: '2026-07-06',
    platform, amount, notas: null, created_at: '', updated_at: '',
  };
}

describe('sumAdSpend', () => {
  it('lista vacía → todo en 0', () => {
    expect(sumAdSpend([])).toEqual({ meta: 0, tiktok: 0, other: 0, total: 0 });
  });

  it('suma por canal y total', () => {
    const t = sumAdSpend([row('meta', 500), row('tiktok', 350), row('meta', 100), row('other', 50)]);
    expect(t.meta).toBe(600);
    expect(t.tiktok).toBe(350);
    expect(t.other).toBe(50);
    expect(t.total).toBe(1000);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/hooks/useStoreAdSpend.test.ts`
Expected: FAIL — "Failed to resolve import './useStoreAdSpend'" o "sumAdSpend is not a function".

- [ ] **Step 3: Escribir el hook completo**

`src/hooks/useStoreAdSpend.ts`:
```ts
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';

// Pauta diaria por tienda (Meta/TikTok). Store-scoped, manager-only vía RLS.
// El monto va en la moneda de la tienda (COP en CO, USD en EC).

export type AdPlatform = 'meta' | 'tiktok' | 'other';

export const PLATFORM_LABEL: Record<AdPlatform, string> = {
  meta: 'Meta',
  tiktok: 'TikTok',
  other: 'Otro',
};

export interface StoreAdSpendRow {
  id: string;
  store_id: string;
  spend_date: string;   // 'YYYY-MM-DD'
  platform: AdPlatform;
  amount: number;
  notas: string | null;
  created_at: string;
  updated_at: string;
}

const VALID_PLATFORMS: AdPlatform[] = ['meta', 'tiktok', 'other'];

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = Number(v); return isFinite(n) ? n : 0; }
  return 0;
}

function parseRow(raw: unknown): StoreAdSpendRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const platform = String(o.platform ?? '');
  if (!VALID_PLATFORMS.includes(platform as AdPlatform)) return null;
  return {
    id: String(o.id ?? ''),
    store_id: String(o.store_id ?? ''),
    spend_date: String(o.spend_date ?? ''),
    platform: platform as AdPlatform,
    amount: toNumber(o.amount),
    notas: typeof o.notas === 'string' ? o.notas : null,
    created_at: String(o.created_at ?? ''),
    updated_at: String(o.updated_at ?? ''),
  };
}

export interface AdSpendTotals { meta: number; tiktok: number; other: number; total: number; }

/** Suma pura por canal + total. */
export function sumAdSpend(rows: StoreAdSpendRow[]): AdSpendTotals {
  const out: AdSpendTotals = { meta: 0, tiktok: 0, other: 0, total: 0 };
  for (const r of rows) {
    out[r.platform] += r.amount;
    out.total += r.amount;
  }
  return out;
}

/**
 * Filas de pauta de la tienda activa en un rango de fechas (desc).
 * Degradación: si la tabla no existe todavía (migration sin aplicar), el query
 * TIRA el error y react-query lo expone en `isError` (retry:false). Los consumidores
 * usan `data ?? []` para que "Cómo voy" nunca se rompa; el panel muestra "aún no activo".
 */
export function useStoreAdSpendRange(fromDate: string, toDate: string) {
  const storeId = useActiveStoreId();
  return useQuery<StoreAdSpendRow[]>({
    queryKey: ['store-ad-spend', storeId, fromDate, toDate],
    queryFn: async () => {
      // tabla nueva, aún no en los tipos autogenerados → cast a any para el .from()
      const { data, error } = await (supabase as unknown as {
        from: (t: string) => any;
      }).from('store_ad_spend_daily')
        .select('*')
        .eq('store_id', storeId)
        .gte('spend_date', fromDate)
        .lte('spend_date', toDate)
        .order('spend_date', { ascending: false });
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      return rows.map(parseRow).filter((r): r is StoreAdSpendRow => r !== null);
    },
    staleTime: 60_000,
    retry: false,
    enabled: Boolean(fromDate && toDate && storeId),
  });
}

export interface UpsertStoreAdSpendParams {
  store_id: string;
  spend_date: string;
  platform: AdPlatform;
  amount: number;
  notas: string;
}

export function useUpsertStoreAdSpend() {
  const qc = useQueryClient();
  return useMutation<StoreAdSpendRow, Error, UpsertStoreAdSpendParams>({
    mutationFn: async (params) => {
      // .bind(supabase): preserva el `this` del método (sin bind: "Cannot read properties of undefined (reading 'rest')").
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<{ data: unknown; error: { message?: string } | null }>;
      const { data, error } = await rpc('upsert_store_ad_spend_daily', {
        p_store_id: params.store_id,
        p_spend_date: params.spend_date,
        p_platform: params.platform,
        p_amount: params.amount,
        p_notas: params.notas,
      });
      if (error) throw new Error(error.message || 'Error guardando pauta');
      const row = parseRow(data);
      if (!row) throw new Error('Respuesta inesperada del servidor');
      return row;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['store-ad-spend'] }); },
  });
}

export function useDeleteStoreAdSpend() {
  const qc = useQueryClient();
  return useMutation<boolean, Error, string>({
    mutationFn: async (id: string) => {
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<{ data: unknown; error: { message?: string } | null }>;
      const { data, error } = await rpc('delete_store_ad_spend_daily', { p_id: id });
      if (error) throw new Error(error.message || 'Error eliminando pauta');
      return Boolean(data);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['store-ad-spend'] }); },
  });
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run src/hooks/useStoreAdSpend.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useStoreAdSpend.ts src/hooks/useStoreAdSpend.test.ts
git commit -m "feat(pauta): hook useStoreAdSpend (query degradable + mutations + sumAdSpend)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Diálogo de carga diaria `StoreAdSpendDialog`

**Files:**
- Create: `src/components/logistics/StoreAdSpendDialog.tsx`

- [ ] **Step 1: Escribir el componente**

`src/components/logistics/StoreAdSpendDialog.tsx`:
```tsx
import { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useStore } from '@/contexts/StoreContext';
import { bogotaToday } from '@/lib/utils';
import {
  useUpsertStoreAdSpend, useDeleteStoreAdSpend,
  type AdPlatform, type StoreAdSpendRow,
} from '@/hooks/useStoreAdSpend';

// Carga diaria de pauta por canal. Una fila = un canal en un día con su monto.
// Default de fecha = AYER (el caso típico: "ayer gasté X"). Upsert por (día, canal).

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: StoreAdSpendRow | null;   // null = creando
}

const PLATFORMS: { value: AdPlatform; label: string }[] = [
  { value: 'meta', label: 'Meta (Facebook / Instagram)' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'other', label: 'Otro' },
];

/** Ayer en zona Bogotá (YYYY-MM-DD). Mediodía UTC para evitar bordes de TZ/DST. */
function yesterdayBogota(): string {
  const d = new Date(`${bogotaToday()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export default function StoreAdSpendDialog({ open, onOpenChange, editing }: Props) {
  const { activeStoreId, activeStore } = useStore();
  const upsert = useUpsertStoreAdSpend();
  const del = useDeleteStoreAdSpend();

  const [spendDate, setSpendDate] = useState(yesterdayBogota());
  const [platform, setPlatform] = useState<AdPlatform>('meta');
  const [amount, setAmount] = useState('');
  const [notas, setNotas] = useState('');

  const currencyLabel = activeStore?.country_code === 'EC' ? 'USD' : 'COP';

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setSpendDate(editing.spend_date);
      setPlatform(editing.platform);
      setAmount(String(editing.amount));
      setNotas(editing.notas ?? '');
    } else {
      setSpendDate(yesterdayBogota());
      setPlatform('meta');
      setAmount('');
      setNotas('');
    }
  }, [open, editing]);

  // Enteros: se strippean separadores (consistente con el resto de la app, sin centavos).
  const parseAmount = (v: string): number => {
    const clean = v.replace(/[^\d]/g, '');
    const n = Number(clean);
    return isFinite(n) && n >= 0 ? n : 0;
  };

  const handleSubmit = async () => {
    if (!activeStoreId) { toast.error('Sin tienda activa'); return; }
    if (!spendDate) { toast.error('Elegí una fecha'); return; }
    const amt = parseAmount(amount);
    try {
      await upsert.mutateAsync({
        store_id: activeStoreId,
        spend_date: spendDate,
        platform,
        amount: amt,
        notas: notas.trim(),
      });
      toast.success('Pauta guardada');
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      toast.error(`No se pudo guardar: ${msg}`);
    }
  };

  const handleDelete = async () => {
    if (!editing) return;
    if (!window.confirm('¿Eliminar este registro de pauta?')) return;
    try {
      await del.mutateAsync(editing.id);
      toast.success('Registro eliminado');
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      toast.error(`No se pudo eliminar: ${msg}`);
    }
  };

  const busy = upsert.isPending || del.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Editar pauta del día' : 'Registrar pauta del día'}</DialogTitle>
          <DialogDescription className="text-xs">
            Cuánto gastaste ese día en cada canal. Un monto por canal por día — si te
            equivocaste, lo editás y se sobreescribe.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ad-date" className="text-xs">Fecha</Label>
              <Input
                id="ad-date"
                type="date"
                value={spendDate}
                onChange={(e) => setSpendDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Canal</Label>
              <Select value={platform} onValueChange={(v) => setPlatform(v as AdPlatform)}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map((p) => (
                    <SelectItem key={p.value} value={p.value} className="text-xs">{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ad-amount" className="text-xs">Monto ({currencyLabel})</Label>
            <Input
              id="ad-amount"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ad-notas" className="text-xs">Nota (opcional)</Label>
            <Textarea
              id="ad-notas"
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              placeholder="cuenta, campaña, observación…"
              rows={2}
            />
          </div>
        </div>

        <DialogFooter className="flex flex-row sm:justify-between gap-2">
          {editing ? (
            <Button
              type="button" variant="outline" onClick={handleDelete} disabled={busy}
              className="text-red border-red/40 hover:bg-red/5"
            >
              <Trash2 size={14} className="mr-1.5" /> Eliminar
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={handleSubmit} disabled={busy}>
              {busy ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" /> Guardando…
                </span>
              ) : 'Guardar'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: sin errores nuevos en `StoreAdSpendDialog.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/components/logistics/StoreAdSpendDialog.tsx
git commit -m "feat(pauta): diálogo de carga diaria (fecha default=ayer, moneda por país)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Panel "Pauta diaria" `StoreAdSpendPanel`

**Files:**
- Create: `src/components/logistics/StoreAdSpendPanel.tsx`

- [ ] **Step 1: Escribir el componente**

`src/components/logistics/StoreAdSpendPanel.tsx`:
```tsx
import { useState } from 'react';
import { Megaphone, Plus, Pencil, AlertCircle } from 'lucide-react';
import type { LogisticsFilters } from '@/lib/logistics.types';
import { useStore } from '@/contexts/StoreContext';
import { formatCOP } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  useStoreAdSpendRange, sumAdSpend, PLATFORM_LABEL,
  type StoreAdSpendRow,
} from '@/hooks/useStoreAdSpend';
import StoreAdSpendDialog from './StoreAdSpendDialog';

// Panel "Pauta diaria" — vive en Logística → Resumen, debajo de "Cómo voy".
// Totales del período por canal + tabla de últimos días (editable) + botón cargar.
// managerOnly ya lo garantiza Logística; igual gateamos por isManagerOfActive.

interface Props { filters: LogisticsFilters; }

function fmtDay(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  if (!y || !m || !day) return d;
  return new Date(y, m - 1, day).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
}

export default function StoreAdSpendPanel({ filters }: Props) {
  const { isManagerOfActive } = useStore();
  const { data, isLoading, isError } = useStoreAdSpendRange(filters.fromDate, filters.toDate);
  const [dialog, setDialog] = useState<{ open: boolean; row: StoreAdSpendRow | null }>({ open: false, row: null });

  if (!isManagerOfActive) return null;

  const rows = data ?? [];
  const totals = sumAdSpend(rows);

  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <header className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Megaphone size={14} className="text-accent" />
          <h3 className="text-sm font-semibold text-foreground">Pauta diaria</h3>
        </div>
        <Button size="sm" variant="outline" className="h-8" onClick={() => setDialog({ open: true, row: null })}>
          <Plus size={12} className="mr-1.5" /> Registrar pauta
        </Button>
      </header>

      {isError ? (
        <div className="px-5 py-4 flex items-start gap-2 text-xs text-muted-foreground">
          <AlertCircle size={14} className="text-warning shrink-0 mt-0.5" />
          <span>
            El control de pauta aún no está activo (falta aplicar la migración en la base).
            Cuando se aplique, acá vas a poder registrar tu gasto diario.
          </span>
        </div>
      ) : (
        <>
          {/* Totales del período por canal */}
          <div className="px-5 py-3 border-b border-border flex items-center gap-4 flex-wrap text-xs">
            <span className="text-muted-foreground">Este período:</span>
            <span className="text-foreground"><strong>Meta</strong> {formatCOP(totals.meta)}</span>
            <span className="text-foreground"><strong>TikTok</strong> {formatCOP(totals.tiktok)}</span>
            {totals.other > 0 && (
              <span className="text-foreground"><strong>Otros</strong> {formatCOP(totals.other)}</span>
            )}
            <span className="ml-auto text-accent font-bold">Total {formatCOP(totals.total)}</span>
          </div>

          {/* Tabla de últimos días */}
          {isLoading ? (
            <div className="p-5"><div className="h-16 animate-pulse bg-muted/30 rounded" /></div>
          ) : rows.length === 0 ? (
            <div className="px-5 py-6 text-center text-sm text-muted-foreground">
              Sin pauta cargada en este período. Tocá <strong>Registrar pauta</strong> para anotar
              lo del día.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-muted-foreground text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="px-5 py-2 text-left font-semibold">Día</th>
                  <th className="px-5 py-2 text-left font-semibold">Canal</th>
                  <th className="px-5 py-2 text-right font-semibold">Monto</th>
                  <th className="px-5 py-2 text-left font-semibold">Nota</th>
                  <th className="px-5 py-2 text-right font-semibold">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-muted/20">
                    <td className="px-5 py-2 text-xs text-foreground">{fmtDay(r.spend_date)}</td>
                    <td className="px-5 py-2 text-xs text-foreground">{PLATFORM_LABEL[r.platform]}</td>
                    <td className="px-5 py-2 text-right text-xs font-mono tabular-nums text-foreground">{formatCOP(r.amount)}</td>
                    <td className="px-5 py-2 text-xs text-muted-foreground truncate max-w-[12rem]">{r.notas ?? ''}</td>
                    <td className="px-5 py-2 text-right">
                      <button
                        onClick={() => setDialog({ open: true, row: r })}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                      >
                        <Pencil size={11} /> Editar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <StoreAdSpendDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog({ open, row: open ? dialog.row : null })}
        editing={dialog.row}
      />
    </section>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: sin errores nuevos. Confirmá que `LogisticsFilters` tiene `fromDate`/`toDate` (usado por `MesActualResumen`, mismo tipo).

- [ ] **Step 3: Commit**

```bash
git add src/components/logistics/StoreAdSpendPanel.tsx
git commit -m "feat(pauta): panel Pauta diaria (totales por canal + tabla + estado 'aún no activo')

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Wiring del NETO en `MesActualResumen` + insertar panel en `LogisticaTab`

**Files:**
- Modify: `src/components/logistics/MesActualResumen.tsx`
- Modify: `src/components/tabs/LogisticaTab.tsx:372`

- [ ] **Step 1: Importar el hook en `MesActualResumen.tsx`**

Agregá el import junto a los otros hooks (después de la línea `import { useGananciaNetaDropi } from '@/hooks/useGananciaNetaDropi';`):
```tsx
import { useStoreAdSpendRange, sumAdSpend } from '@/hooks/useStoreAdSpend';
```

- [ ] **Step 2: Calcular pauta y NETO**

Después del bloque `const { data: wallet, isLoading: walletLoading } = useWalletMovements({...});` agregá:
```tsx
  const { data: adRows } = useStoreAdSpendRange(filters.fromDate, filters.toDate);
  const pautaTotal = sumAdSpend(adRows ?? []).total;
```

Y después de la línea `const totalSalidas = ganancia?.total_salidas ?? 0;` agregá:
```tsx
  const netoDespuesPauta = gananciaNeta - pautaTotal;
```

- [ ] **Step 3: Insertar las filas de pauta/NETO en el bloque "Wallet REAL"**

En el bloque Wallet REAL, entre la fila "Ganancia neta operativa del mes" y la fila "Saldo disponible hoy" (la que empieza con `<div className="flex items-center justify-between gap-2 border-t border-border pt-2.5 mt-2.5">`), insertá:
```tsx
                {pautaTotal > 0 && (
                  <>
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className="text-xs text-muted-foreground">− Pauta del período (Meta / TikTok)</span>
                      <span className="text-sm font-bold tabular-nums text-red shrink-0">
                        −{formatCOP(pautaTotal)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5 mt-1">
                      <span className="text-xs text-foreground font-semibold">NETO después de pauta</span>
                      <span className={`text-base font-bold tabular-nums shrink-0 ${netoDespuesPauta >= 0 ? 'text-green' : 'text-red'}`}>
                        {formatCOP(netoDespuesPauta)}
                      </span>
                    </div>
                  </>
                )}
```

> El resultado: "Ganancia neta operativa" → "− Pauta del período" → "NETO después de pauta" → "Saldo disponible hoy". Si `pautaTotal === 0`, no se muestra ninguna resta (queda igual que hoy).

- [ ] **Step 4: Insertar el panel en `LogisticaTab.tsx`**

Agregá el import (junto a `import MesActualResumen from '@/components/logistics/MesActualResumen';`, línea ~29):
```tsx
import StoreAdSpendPanel from '@/components/logistics/StoreAdSpendPanel';
```

En el `<TabsContent value="resumen">`, justo después de `<MesActualResumen summary={summary.data ?? null} filters={filters} />` (línea ~372), agregá:
```tsx
            {/* Pauta diaria por tienda — se resta de la Ganancia Neta de arriba. */}
            <StoreAdSpendPanel filters={filters} />
```

- [ ] **Step 5: Typecheck + tests existentes de Logística**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: sin errores.
Run: `npx vitest run src/components/logistics`
Expected: PASS (los tests existentes de `FinanzasTab`/`CarrierStatsTable` no cambian de contrato).

- [ ] **Step 6: Commit**

```bash
git add src/components/logistics/MesActualResumen.tsx src/components/tabs/LogisticaTab.tsx
git commit -m "feat(pauta): restar pauta del período → NETO real en Cómo voy + panel en Resumen

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Verificación final (build gates) + push

**Files:** ninguno (solo comandos)

- [ ] **Step 1: Suite completa**

Run: `npm run test`
Expected: todo verde (incluye `useStoreAdSpend.test.ts`).

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: sin errores.
Run: `npm run lint`
Expected: sin errores nuevos introducidos por los archivos de este plan.

- [ ] **Step 3: Push de la rama**

```bash
git push -u origin agente/pauta-diaria-control
```
Expected: rama publicada; PR listo para abrir.

---

### Task 7: Deploy + verificación en vivo (definición de "listo")

**No es código — es el cierre según la regla del dueño.**

- [ ] **Step 1: Merge a `main`** (con autorización del dueño) para que Lovable jale el frontend.
- [ ] **Step 2: Aplicar la migration** (`supabase db push` o prompt a Lovable). Lovable NO la aplica solo.
- [ ] **Step 3: Verificar por REST** (sesión admin en el navegador, patrón de CLAUDE.md):
  - Que la tabla existe: `GET /rest/v1/store_ad_spend_daily?select=id&limit=1` → 200 (no 404/PGRST205).
  - Upsert vía RPC: `POST /rest/v1/rpc/upsert_store_ad_spend_daily` con `{p_store_id, p_spend_date:'2026-07-06', p_platform:'tiktok', p_amount:350000, p_notas:'prueba'}` → devuelve la fila.
  - Que el panel muestra la fila y el NETO baja en "Cómo voy" en la cantidad cargada.
  - Borrar la fila de prueba (botón Eliminar) y confirmar que el NETO vuelve a la Ganancia.
- [ ] **Step 4:** Actualizar el memory `optimizacion_ecuador_audit.md` o crear uno nuevo con el estado final.

---

## Self-Review (hecho por el autor del plan)

**Cobertura del spec:**
- Tabla `store_ad_spend_daily` + RLS `is_store_manager` + RPCs upsert/delete → Task 1. ✓
- Hook con degradación + mutations + `sumAdSpend` + test → Task 2. ✓
- `StoreAdSpendDialog` (fecha=ayer, canal, monto, nota, moneda por país) → Task 3. ✓
- `StoreAdSpendPanel` (totales + tabla + "aún no activo") → Task 4. ✓
- Wiring del NETO en `MesActualResumen` + panel en `LogisticaTab` → Task 5. ✓
- Multi-país (captura en moneda de tienda, display `formatCOP` compartido) → Tasks 3/4 (currencyLabel + formatCOP). ✓
- Degradación si falta migration (Cómo voy no se rompe) → hook `retry:false` + `data ?? []` en consumidores. ✓
- Definición de "listo" (main + SQL aplicado + verificado) → Tasks 6/7. ✓

**Placeholders:** ninguno — todo el código está completo.

**Consistencia de tipos:** `StoreAdSpendRow`, `AdPlatform`, `sumAdSpend`, `PLATFORM_LABEL`, `useStoreAdSpendRange`, `useUpsertStoreAdSpend`, `useDeleteStoreAdSpend`, `UpsertStoreAdSpendParams` — mismos nombres en hook, diálogo, panel y `MesActualResumen`. Los nombres de columnas (`spend_date`, `platform`, `amount`, `notas`, `store_id`) coinciden entre migration, RPCs y `parseRow`. Los params RPC (`p_store_id`, `p_spend_date`, `p_platform`, `p_amount`, `p_notas`) coinciden entre migration y hook.
