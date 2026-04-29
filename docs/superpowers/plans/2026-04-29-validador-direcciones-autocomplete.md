# Validador de Direcciones con Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir validador de direcciones con autocomplete Google Places + feedback accionable + gate al confirmar, integrado en CallView y EditOrderDialog.

**Architecture:** 3 capas — (1) AddressAutocomplete combobox con Google Places + cache L1/L2/L3, (2) AddressFeedbackCard con missing_fields + botón Copiar WhatsApp para casos free-write/rural, (3) DespachoGateButton con `canConfirmOrder()` puro que bloquea red sin override admin. Cap diario server-side $2.50/día solo para Address Validation + Haiku, GCP cap mensual $50 para autocomplete browser-direct. Backwards-compat con Excel uploads existentes.

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind + shadcn/ui, Supabase (Postgres + RLS + Edge Functions Deno), TanStack React Query, Vitest + Testing Library, Google Places API (New) + Address Validation API, Anthropic Claude Haiku 4.5.

**Spec base:** [`docs/superpowers/specs/2026-04-29-validador-direcciones-design.md`](../specs/2026-04-29-validador-direcciones-design.md)

---

## File Structure

### Archivos nuevos

| Path | Responsabilidad |
|---|---|
| `supabase/migrations/20260501000000_validador_direcciones.sql` | Schema: ALTER orders + tabla `address_autocomplete_cache` + keys app_settings + RPC `consume_google_quota` + RPC `cleanup_expired_autocomplete_cache` |
| `supabase/migrations/20260501010000_validador_direcciones_cron.sql` | pg_cron jobs: reset diario quota + cleanup cache |
| `src/lib/canConfirmOrder.ts` (+ test) | Función pura: green/yellow/red × isAdmin × override × phone × Coordinadora |
| `src/lib/addressNormalize.ts` (+ test) | Función pura: normalizar query para cache key |
| `src/lib/parseGooglePlace.ts` (+ test) | Parsear `address_components` → `{direccion, barrio, address_kind}` |
| `src/lib/buildWhatsAppMessage.ts` (+ test) | Generar `suggested_customer_message` desde `missing_fields` |
| `src/lib/mapAddressKind.ts` (+ test) | Decidir urban/rural/pickup_office/unknown desde keywords |
| `src/hooks/useGooglePlaces.ts` | Lazy load Google Maps JS API + Cache L1 (memory) |
| `src/hooks/useAddressAutocompleteCache.ts` | Read/write Cache L2 (DB) + Cache L3 (recurrent customer) |
| `src/hooks/useGoogleQuota.ts` | Lee app_settings de cuota Google para widget admin |
| `src/components/address/AddressAutocomplete.tsx` (+ test) | Combobox con dropdown sugerencias + banner Cache L3 |
| `src/components/address/AddressFeedbackCard.tsx` (+ test) | Card 4 estados + botón Copiar WhatsApp + override admin |
| `src/components/address/DespachoGateButton.tsx` (+ test) | Wrapper del botón Confirmar con tooltip de motivo bloqueo |
| `src/components/admin/GoogleQuotaWidget.tsx` (+ test) | Widget en /admin: usado/budget + estimado fin de mes |

### Archivos modificados

| Path | Cambios |
|---|---|
| `src/lib/orderUtils.ts` | Extender `DbOrderRow`, `OrderData`, `mapDbRow()` con campos nuevos |
| `src/integrations/supabase/types.ts` | Regenerar (auto via Supabase CLI o Lovable) |
| `src/lib/addressHeuristic.ts` | Agregar keywords rurales (manzana, lote, finca, vereda, corregimiento, km, sector) + detección pickup-office |
| `supabase/functions/dropi-validate-address/index.ts` | Capa pickup-office detection + heurística rural-aware + Haiku 4.5 + chequeo de cap server-side |
| `src/components/CallView.tsx` | Reemplazar input dirección por `<AddressAutocomplete>` + insertar `<AddressFeedbackCard>` + reemplazar botón Confirmar por `<DespachoGateButton>` |
| `src/components/EditOrderDialog.tsx` | Igual que CallView (sin DespachoGateButton, no aplica) |
| `src/components/CrmCallView.tsx` | Solo insertar `<AddressFeedbackCard>` (legacy, no autocomplete) |
| `src/lib/colombiaGeo.ts` | Reemplazar contenido por catálogo DANE 1.123 municipios. Mantener API pública `getCiudadesDe(departamento)` |
| `src/components/tabs/AdminTab.tsx` | Agregar `<GoogleQuotaWidget>` |

---

## Tasks

### Task 1: Migración de schema

**Files:**
- Create: `supabase/migrations/20260501000000_validador_direcciones.sql`

- [ ] **Step 1: Crear el archivo de migración**

```sql
-- Schema para validador de direcciones con autocomplete.
-- Spec: docs/superpowers/specs/2026-04-29-validador-direcciones-design.md
--
-- Agrega columnas a orders (todas nullable, backwards-compat con Excel uploads),
-- tabla address_autocomplete_cache (L2), keys de app_settings para cuota Google,
-- y RPCs consume_google_quota + cleanup_expired_autocomplete_cache.

-- 1. Columnas nuevas en orders
ALTER TABLE public.orders
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

CREATE INDEX IF NOT EXISTS orders_google_place_id_idx
  ON public.orders(google_place_id)
  WHERE google_place_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS orders_validation_decision_idx
  ON public.orders(validation_decision);

CREATE INDEX IF NOT EXISTS orders_phone_place_id_idx
  ON public.orders(phone)
  WHERE google_place_id IS NOT NULL;

-- 2. Tabla nueva address_autocomplete_cache (Cache L2)
CREATE TABLE IF NOT EXISTS public.address_autocomplete_cache (
  id BIGSERIAL PRIMARY KEY,
  query_normalized TEXT NOT NULL,
  ciudad_filter TEXT,
  suggestions JSONB NOT NULL,
  hit_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (query_normalized, ciudad_filter)
);

CREATE INDEX IF NOT EXISTS address_autocomplete_cache_expires_idx
  ON public.address_autocomplete_cache(expires_at);

ALTER TABLE public.address_autocomplete_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "autocomplete_cache_authenticated_all" ON public.address_autocomplete_cache;
CREATE POLICY "autocomplete_cache_authenticated_all"
  ON public.address_autocomplete_cache
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- 3. Keys de app_settings para cuota Google diaria
INSERT INTO public.app_settings (key, value)
VALUES
  ('google_api_daily_budget_usd', '2.50'),
  ('google_api_used_today_usd',   '0.00'),
  ('google_api_used_today_date',  to_char(now() AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD'))
ON CONFLICT (key) DO NOTHING;

-- 4. RPC consume_google_quota
CREATE OR REPLACE FUNCTION public.consume_google_quota(p_amount_usd NUMERIC)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_today TEXT := to_char(now() AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD');
  v_stored_date TEXT;
  v_used NUMERIC;
  v_budget NUMERIC;
BEGIN
  SELECT value INTO v_stored_date FROM app_settings WHERE key = 'google_api_used_today_date';
  IF v_stored_date IS DISTINCT FROM v_today THEN
    UPDATE app_settings SET value = '0.00' WHERE key = 'google_api_used_today_usd';
    UPDATE app_settings SET value = v_today  WHERE key = 'google_api_used_today_date';
  END IF;

  SELECT value::NUMERIC INTO v_used   FROM app_settings WHERE key = 'google_api_used_today_usd';
  SELECT value::NUMERIC INTO v_budget FROM app_settings WHERE key = 'google_api_daily_budget_usd';

  IF v_used + p_amount_usd > v_budget THEN
    RETURN FALSE;
  END IF;

  UPDATE app_settings
  SET value = (v_used + p_amount_usd)::TEXT
  WHERE key = 'google_api_used_today_usd';

  RETURN TRUE;
END;
$func$;

REVOKE ALL ON FUNCTION public.consume_google_quota(NUMERIC) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.consume_google_quota(NUMERIC) TO authenticated, service_role;

-- 5. RPC cleanup_expired_autocomplete_cache
CREATE OR REPLACE FUNCTION public.cleanup_expired_autocomplete_cache()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM address_autocomplete_cache WHERE expires_at < now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$func$;

REVOKE ALL ON FUNCTION public.cleanup_expired_autocomplete_cache() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_autocomplete_cache() TO service_role;

COMMENT ON TABLE public.address_autocomplete_cache IS
  'Cache L2 de sugerencias Google Places por query normalizada. TTL 30 días.';
COMMENT ON FUNCTION public.consume_google_quota(NUMERIC) IS
  'Atomic check-and-increment de cuota diaria Google APIs. Retorna FALSE si excede el cap.';
```

- [ ] **Step 2: Verificar el archivo creado**

Run: `head -20 supabase/migrations/20260501000000_validador_direcciones.sql`
Expected: ver el comentario header + el primer ALTER TABLE.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260501000000_validador_direcciones.sql
git commit -m "feat(validador): migración schema (orders + autocomplete_cache + cuota RPCs)"
```

---

### Task 2: Migración de cron jobs

**Files:**
- Create: `supabase/migrations/20260501010000_validador_direcciones_cron.sql`

- [ ] **Step 1: Crear el archivo**

```sql
-- pg_cron jobs para validador de direcciones.

-- Reset diario de cuota a las 00:00 Bogotá (== 05:00 UTC)
SELECT cron.schedule(
  'reset-google-quota-daily',
  '0 5 * * *',
  $$
    UPDATE public.app_settings SET value = '0.00' WHERE key = 'google_api_used_today_usd';
    UPDATE public.app_settings SET value = to_char(now() AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD')
      WHERE key = 'google_api_used_today_date';
  $$
);

-- Cleanup de cache expirado a las 02:00 Bogotá (== 07:00 UTC)
SELECT cron.schedule(
  'cleanup-autocomplete-cache-daily',
  '0 7 * * *',
  $$ SELECT public.cleanup_expired_autocomplete_cache(); $$
);
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260501010000_validador_direcciones_cron.sql
git commit -m "feat(validador): pg_cron diario para reset cuota + cleanup cache"
```

---

### Task 3: Extender tipos en orderUtils.ts

**Files:**
- Modify: `src/lib/orderUtils.ts`

- [ ] **Step 1: Leer el archivo actual y ubicar `DbOrderRow` + `OrderData` + `mapDbRow`**

Run: `grep -n "DbOrderRow\|OrderData\|mapDbRow" src/lib/orderUtils.ts | head -10`

- [ ] **Step 2: Agregar campos a `DbOrderRow` (al final del bloque)**

```typescript
  // Validador de direcciones — agregado por migración 20260501000000
  barrio?: string | null;
  complemento?: string | null;
  documento_destinatario?: string | null;
  google_place_id?: string | null;
  lat?: number | null;
  lng?: number | null;
  validation_decision?: 'green' | 'yellow' | 'red' | 'pickup_office' | null;
  address_kind?: 'urban' | 'rural' | 'pickup_office' | 'unknown' | null;
  missing_fields?: string[] | null;
  suggested_customer_message?: string | null;
  address_parsed?: Record<string, unknown> | null;
```

- [ ] **Step 3: Agregar mismos campos a `OrderData`**

```typescript
  barrio: string;
  complemento: string;
  documentoDestinatario: string;
  googlePlaceId: string;
  lat: number | null;
  lng: number | null;
  validationDecision: 'green' | 'yellow' | 'red' | 'pickup_office' | null;
  addressKind: 'urban' | 'rural' | 'pickup_office' | 'unknown' | null;
  missingFields: string[];
  suggestedCustomerMessage: string;
  addressParsed: Record<string, unknown> | null;
```

- [ ] **Step 4: Extender `mapDbRow()` (en el `return`)**

```typescript
    barrio: o.barrio || '',
    complemento: o.complemento || '',
    documentoDestinatario: o.documento_destinatario || '',
    googlePlaceId: o.google_place_id || '',
    lat: typeof o.lat === 'number' ? o.lat : null,
    lng: typeof o.lng === 'number' ? o.lng : null,
    validationDecision: o.validation_decision ?? null,
    addressKind: o.address_kind ?? null,
    missingFields: Array.isArray(o.missing_fields) ? o.missing_fields : [],
    suggestedCustomerMessage: o.suggested_customer_message || '',
    addressParsed: (o.address_parsed as Record<string, unknown>) ?? null,
```

- [ ] **Step 5: Build pasa sin errores**

Run: `npm run build`
Expected: build limpio. Si hay errores en consumers de OrderData (porque agregamos required fields), agregar defaults en esos consumers.

- [ ] **Step 6: Commit**

```bash
git add src/lib/orderUtils.ts
git commit -m "feat(validador): extender DbOrderRow + OrderData con campos validación"
```

---

### Task 4: canConfirmOrder pure function

**Files:**
- Create: `src/lib/canConfirmOrder.ts`
- Test: `src/lib/canConfirmOrder.test.ts`

- [ ] **Step 1: Escribir test failing**

```typescript
// src/lib/canConfirmOrder.test.ts
import { describe, it, expect } from 'vitest';
import { canConfirmOrder } from './canConfirmOrder';

describe('canConfirmOrder', () => {
  const baseInput = {
    validation_decision: 'green' as const,
    telefonoValido: true,
    documentoSiCoordinadora: true,
    isAdmin: false,
    overrideChecked: false,
  };

  it('green + valid phone -> can confirm', () => {
    expect(canConfirmOrder(baseInput)).toEqual({ canConfirm: true });
  });

  it('pickup_office + valid phone -> can confirm', () => {
    expect(canConfirmOrder({ ...baseInput, validation_decision: 'pickup_office' })).toEqual({ canConfirm: true });
  });

  it('yellow without override -> blocked', () => {
    const r = canConfirmOrder({ ...baseInput, validation_decision: 'yellow' });
    expect(r.canConfirm).toBe(false);
    expect(r.reason).toMatch(/confirma/i);
  });

  it('yellow + override -> can confirm', () => {
    expect(canConfirmOrder({ ...baseInput, validation_decision: 'yellow', overrideChecked: true })).toEqual({ canConfirm: true });
  });

  it('red without override -> blocked', () => {
    const r = canConfirmOrder({ ...baseInput, validation_decision: 'red' });
    expect(r.canConfirm).toBe(false);
    expect(r.reason).toMatch(/incompleta|falta/i);
  });

  it('red + admin + override -> can confirm', () => {
    expect(canConfirmOrder({ ...baseInput, validation_decision: 'red', isAdmin: true, overrideChecked: true })).toEqual({ canConfirm: true });
  });

  it('red + non-admin + override -> still blocked', () => {
    const r = canConfirmOrder({ ...baseInput, validation_decision: 'red', isAdmin: false, overrideChecked: true });
    expect(r.canConfirm).toBe(false);
    expect(r.reason).toMatch(/admin/i);
  });

  it('null decision -> blocked', () => {
    const r = canConfirmOrder({ ...baseInput, validation_decision: null });
    expect(r.canConfirm).toBe(false);
    expect(r.reason).toMatch(/pendiente/i);
  });

  it('phone invalid -> blocked even with override', () => {
    const r = canConfirmOrder({ ...baseInput, telefonoValido: false, isAdmin: true, overrideChecked: true });
    expect(r.canConfirm).toBe(false);
    expect(r.reason).toMatch(/tel/i);
  });

  it('Coordinadora sin documento -> blocked even with override', () => {
    const r = canConfirmOrder({ ...baseInput, documentoSiCoordinadora: false, isAdmin: true, overrideChecked: true });
    expect(r.canConfirm).toBe(false);
    expect(r.reason).toMatch(/documento|cédula|cedula/i);
  });
});
```

- [ ] **Step 2: Run test → debe fallar**

Run: `npx vitest run src/lib/canConfirmOrder.test.ts`
Expected: FAIL — `Cannot find module './canConfirmOrder'`.

- [ ] **Step 3: Implementar la función**

```typescript
// src/lib/canConfirmOrder.ts
export type ValidationDecision = 'green' | 'yellow' | 'red' | 'pickup_office';

export interface CanConfirmInput {
  validation_decision: ValidationDecision | null;
  telefonoValido: boolean;
  documentoSiCoordinadora: boolean;
  isAdmin: boolean;
  overrideChecked: boolean;
}

export interface CanConfirmResult {
  canConfirm: boolean;
  reason?: string;
}

export function canConfirmOrder(input: CanConfirmInput): CanConfirmResult {
  if (!input.telefonoValido) {
    return { canConfirm: false, reason: 'Teléfono inválido (debe iniciar en 3 y tener 10 dígitos)' };
  }
  if (!input.documentoSiCoordinadora) {
    return { canConfirm: false, reason: 'Coordinadora requiere cédula del destinatario' };
  }

  const decision = input.validation_decision;

  if (decision === 'green' || decision === 'pickup_office') return { canConfirm: true };

  if (decision === 'yellow') {
    if (input.overrideChecked) return { canConfirm: true };
    return { canConfirm: false, reason: 'Confirma con el cliente y marca el checkbox' };
  }

  if (decision === 'red') {
    if (input.isAdmin && input.overrideChecked) return { canConfirm: true };
    if (!input.isAdmin) return { canConfirm: false, reason: 'Dirección incompleta — solo admin puede forzar' };
    return { canConfirm: false, reason: 'Dirección incompleta — falta datos del cliente' };
  }

  return { canConfirm: false, reason: 'Validación pendiente' };
}
```

- [ ] **Step 4: Run test → debe pasar**

Run: `npx vitest run src/lib/canConfirmOrder.test.ts`
Expected: PASS — 10/10.

- [ ] **Step 5: Commit**

```bash
git add src/lib/canConfirmOrder.ts src/lib/canConfirmOrder.test.ts
git commit -m "feat(validador): canConfirmOrder pure function"
```

---

### Task 5: addressNormalize pure function

**Files:**
- Create: `src/lib/addressNormalize.ts`
- Test: `src/lib/addressNormalize.test.ts`

- [ ] **Step 1: Escribir test failing**

```typescript
// src/lib/addressNormalize.test.ts
import { describe, it, expect } from 'vitest';
import { addressNormalize } from './addressNormalize';

describe('addressNormalize', () => {
  it('lowercase', () => {
    expect(addressNormalize('Calle 8 #5-67')).toBe('calle 8 #5-67');
  });
  it('elimina tildes', () => {
    expect(addressNormalize('Carrera 30 Bogotá')).toBe('carrera 30 bogota');
  });
  it('colapsa espacios múltiples', () => {
    expect(addressNormalize('  Calle    8   #5-67  ')).toBe('calle 8 #5-67');
  });
  it('trim', () => {
    expect(addressNormalize('  Calle 8  ')).toBe('calle 8');
  });
  it('Ñ se mantiene como N', () => {
    expect(addressNormalize('Cañas')).toBe('canas');
  });
  it('combinado', () => {
    expect(addressNormalize('  CARRERA   30   #45  Bogotá  ')).toBe('carrera 30 #45 bogota');
  });
  it('vacío', () => {
    expect(addressNormalize('')).toBe('');
  });
  it('solo whitespace', () => {
    expect(addressNormalize('   ')).toBe('');
  });
});
```

- [ ] **Step 2: Run test → debe fallar**

Run: `npx vitest run src/lib/addressNormalize.test.ts`

- [ ] **Step 3: Implementar**

```typescript
// src/lib/addressNormalize.ts
/** Normaliza dirección para usar como cache key. Idempotente. */
export function addressNormalize(input: string): string {
  if (!input) return '';
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
```

- [ ] **Step 4: Run test → debe pasar**

Run: `npx vitest run src/lib/addressNormalize.test.ts`
Expected: PASS — 8/8.

- [ ] **Step 5: Commit**

```bash
git add src/lib/addressNormalize.ts src/lib/addressNormalize.test.ts
git commit -m "feat(validador): addressNormalize para cache keys"
```

---

### Task 6: parseGooglePlace pure function

**Files:**
- Create: `src/lib/parseGooglePlace.ts`
- Test: `src/lib/parseGooglePlace.test.ts`

- [ ] **Step 1: Escribir test failing**

```typescript
// src/lib/parseGooglePlace.test.ts
import { describe, it, expect } from 'vitest';
import { parseGooglePlace } from './parseGooglePlace';

const urbanPlace = {
  place_id: 'ChIJP_urban_id',
  formatted_address: 'Calle 8 #5-67, Chapinero, Bogotá, Colombia',
  geometry: { location: { lat: () => 4.601, lng: () => -74.062 } },
  address_components: [
    { long_name: '5-67', short_name: '5-67', types: ['street_number'] },
    { long_name: 'Calle 8', short_name: 'Cl 8', types: ['route'] },
    { long_name: 'Chapinero', short_name: 'Chapinero', types: ['sublocality'] },
    { long_name: 'Bogotá', short_name: 'Bogotá', types: ['locality', 'political'] },
    { long_name: 'Colombia', short_name: 'CO', types: ['country', 'political'] },
  ],
};

describe('parseGooglePlace', () => {
  it('extrae direccion como formatted_address', () => {
    expect(parseGooglePlace(urbanPlace).direccion).toBe('Calle 8 #5-67, Chapinero, Bogotá, Colombia');
  });
  it('extrae barrio del sublocality', () => {
    expect(parseGooglePlace(urbanPlace).barrio).toBe('Chapinero');
  });
  it('extrae place_id', () => {
    expect(parseGooglePlace(urbanPlace).place_id).toBe('ChIJP_urban_id');
  });
  it('extrae lat/lng', () => {
    const r = parseGooglePlace(urbanPlace);
    expect(r.lat).toBe(4.601);
    expect(r.lng).toBe(-74.062);
  });
  it('marca urban si tiene route + locality', () => {
    expect(parseGooglePlace(urbanPlace).address_kind).toBe('urban');
  });
  it('barrio null si no hay sublocality', () => {
    const noBarrio = { ...urbanPlace, address_components: urbanPlace.address_components.filter(c => !c.types.includes('sublocality')) };
    expect(parseGooglePlace(noBarrio).barrio).toBeNull();
  });
  it('lat/lng como números literales también funciona', () => {
    const literal = { ...urbanPlace, geometry: { location: { lat: 4.601, lng: -74.062 } as unknown as { lat: () => number; lng: () => number } } };
    const r = parseGooglePlace(literal);
    expect(r.lat).toBe(4.601);
    expect(r.lng).toBe(-74.062);
  });
  it('sin geometry retorna lat/lng null', () => {
    const noGeom = { ...urbanPlace, geometry: undefined };
    const r = parseGooglePlace(noGeom);
    expect(r.lat).toBeNull();
    expect(r.lng).toBeNull();
  });
});
```

- [ ] **Step 2: Run test → debe fallar**

Run: `npx vitest run src/lib/parseGooglePlace.test.ts`

- [ ] **Step 3: Implementar**

```typescript
// src/lib/parseGooglePlace.ts
interface AddressComponent { long_name: string; short_name: string; types: string[]; }
interface GeometryLocation { lat: number | (() => number); lng: number | (() => number); }
interface PlaceLike {
  place_id?: string;
  formatted_address?: string;
  geometry?: { location?: GeometryLocation };
  address_components?: AddressComponent[];
}

export interface ParsedPlace {
  place_id: string | null;
  direccion: string;
  barrio: string | null;
  lat: number | null;
  lng: number | null;
  address_kind: 'urban' | 'rural' | 'unknown';
  components: AddressComponent[];
}

function readLatLng(geom?: { location?: GeometryLocation }): { lat: number | null; lng: number | null } {
  if (!geom?.location) return { lat: null, lng: null };
  const lat = typeof geom.location.lat === 'function' ? geom.location.lat() : geom.location.lat;
  const lng = typeof geom.location.lng === 'function' ? geom.location.lng() : geom.location.lng;
  return {
    lat: typeof lat === 'number' ? lat : null,
    lng: typeof lng === 'number' ? lng : null,
  };
}

function findComponent(components: AddressComponent[], type: string): string | null {
  const m = components.find((c) => c.types.includes(type));
  return m ? m.long_name : null;
}

export function parseGooglePlace(place: PlaceLike): ParsedPlace {
  const components = place.address_components ?? [];
  const hasRoute = components.some((c) => c.types.includes('route'));
  const hasLocality = components.some((c) => c.types.includes('locality'));
  const { lat, lng } = readLatLng(place.geometry);

  return {
    place_id: place.place_id ?? null,
    direccion: place.formatted_address ?? '',
    barrio: findComponent(components, 'sublocality') ?? findComponent(components, 'sublocality_level_1'),
    lat,
    lng,
    address_kind: hasRoute && hasLocality ? 'urban' : 'unknown',
    components,
  };
}
```

- [ ] **Step 4: Run test → debe pasar**

Run: `npx vitest run src/lib/parseGooglePlace.test.ts`
Expected: PASS — 8/8.

- [ ] **Step 5: Commit**

```bash
git add src/lib/parseGooglePlace.ts src/lib/parseGooglePlace.test.ts
git commit -m "feat(validador): parseGooglePlace extrae datos de Google Places"
```

---

### Task 7: buildWhatsAppMessage pure function

**Files:**
- Create: `src/lib/buildWhatsAppMessage.ts`
- Test: `src/lib/buildWhatsAppMessage.test.ts`

- [ ] **Step 1: Escribir test failing**

```typescript
// src/lib/buildWhatsAppMessage.test.ts
import { describe, it, expect } from 'vitest';
import { buildWhatsAppMessage } from './buildWhatsAppMessage';

describe('buildWhatsAppMessage', () => {
  it('placa faltante', () => {
    const m = buildWhatsAppMessage({ missing_fields: ['placa'], nombre: 'Carlos' });
    expect(m).toMatch(/Carlos/);
    expect(m).toMatch(/placa|número/i);
  });
  it('barrio faltante', () => {
    const m = buildWhatsAppMessage({ missing_fields: ['barrio'], nombre: 'María' });
    expect(m).toMatch(/María/);
    expect(m).toMatch(/barrio/i);
  });
  it('múltiples campos', () => {
    const m = buildWhatsAppMessage({ missing_fields: ['placa', 'barrio'], nombre: 'Juan' });
    expect(m).toMatch(/placa|número/i);
    expect(m).toMatch(/barrio/i);
  });
  it('saludo genérico si nombre vacío', () => {
    const m = buildWhatsAppMessage({ missing_fields: ['placa'], nombre: '' });
    expect(m.startsWith('Hola')).toBe(true);
  });
  it('campo desconocido genera mensaje genérico', () => {
    const m = buildWhatsAppMessage({ missing_fields: ['xyz'], nombre: 'Pedro' });
    expect(m).toMatch(/dirección/i);
  });
  it('vacío retorna string vacío', () => {
    expect(buildWhatsAppMessage({ missing_fields: [], nombre: 'Pedro' })).toBe('');
  });
  it('incluye producto si se pasa', () => {
    const m = buildWhatsAppMessage({ missing_fields: ['placa'], nombre: 'Ana', producto: 'Reloj' });
    expect(m).toMatch(/Reloj/);
  });
});
```

- [ ] **Step 2: Run test → debe fallar**

Run: `npx vitest run src/lib/buildWhatsAppMessage.test.ts`

- [ ] **Step 3: Implementar**

```typescript
// src/lib/buildWhatsAppMessage.ts
interface BuildInput {
  missing_fields: string[];
  nombre: string;
  producto?: string;
}

const FIELD_LABELS: Record<string, string> = {
  placa: 'el número de la placa de la casa o apartamento',
  barrio: 'el barrio',
  complemento: 'algún punto de referencia (cerca a un colegio, tienda, etc.)',
  telefono: 'un número de teléfono alternativo',
};

export function buildWhatsAppMessage(input: BuildInput): string {
  if (input.missing_fields.length === 0) return '';

  const saludo = input.nombre ? `Hola ${input.nombre}` : 'Hola';
  const productoCtx = input.producto ? `Para tu pedido de "${input.producto}", ` : 'Para tu pedido, ';

  const labels = input.missing_fields.map((f) => FIELD_LABELS[f]).filter(Boolean);

  if (labels.length === 0) {
    return `${saludo}, ${productoCtx}necesito que me confirmes algunos datos de tu dirección para poder despacharlo. ¿Puedes ayudarme?`;
  }

  const lista = labels.length === 1
    ? labels[0]
    : labels.slice(0, -1).join(', ') + ' y ' + labels[labels.length - 1];

  return `${saludo}, ${productoCtx}me hace falta confirmar ${lista}. ¿Me lo puedes pasar por aquí para despacharte cuanto antes?`;
}
```

- [ ] **Step 4: Run test → debe pasar**

Run: `npx vitest run src/lib/buildWhatsAppMessage.test.ts`
Expected: PASS — 7/7.

- [ ] **Step 5: Commit**

```bash
git add src/lib/buildWhatsAppMessage.ts src/lib/buildWhatsAppMessage.test.ts
git commit -m "feat(validador): buildWhatsAppMessage para feedback accionable"
```

---

### Task 8: mapAddressKind pure function

**Files:**
- Create: `src/lib/mapAddressKind.ts`
- Test: `src/lib/mapAddressKind.test.ts`

- [ ] **Step 1: Escribir test failing**

```typescript
// src/lib/mapAddressKind.test.ts
import { describe, it, expect } from 'vitest';
import { mapAddressKind } from './mapAddressKind';

describe('mapAddressKind', () => {
  it('urbano por calle', () => expect(mapAddressKind('Calle 8 #5-67, Bogotá')).toBe('urban'));
  it('urbano por carrera', () => expect(mapAddressKind('Carrera 30 #45, Medellín')).toBe('urban'));
  it('urbano por avenida', () => expect(mapAddressKind('Avenida 19 #100')).toBe('urban'));
  it('urbano por diagonal', () => expect(mapAddressKind('Diagonal 45')).toBe('urban'));
  it('urbano por transversal', () => expect(mapAddressKind('Transversal 60 #45')).toBe('urban'));
  it('rural por manzana', () => expect(mapAddressKind('Manzana 7 Lote 3')).toBe('rural'));
  it('rural por mz', () => expect(mapAddressKind('Mz B Lt 4')).toBe('rural'));
  it('rural por finca', () => expect(mapAddressKind('Finca La Esperanza')).toBe('rural'));
  it('rural por vereda', () => expect(mapAddressKind('Vereda La Esmeralda')).toBe('rural'));
  it('rural por corregimiento', () => expect(mapAddressKind('Corregimiento El Tablón')).toBe('rural'));
  it('rural por kilómetro', () => expect(mapAddressKind('Km 5 vía a Cali')).toBe('rural'));
  it('rural por sector', () => expect(mapAddressKind('Sector La Loma')).toBe('rural'));
  it('pickup por oficina inter', () => expect(mapAddressKind('Oficina Interrapidísimo Cali')).toBe('pickup_office'));
  it('pickup por sucursal', () => expect(mapAddressKind('Sucursal Envía centro')).toBe('pickup_office'));
  it('pickup por cliente retira', () => expect(mapAddressKind('Cliente retira en oficina')).toBe('pickup_office'));
  it('insensible a tildes', () => {
    expect(mapAddressKind('CARRERA 30')).toBe('urban');
    expect(mapAddressKind('VEREDA La Esmeralda')).toBe('rural');
  });
  it('vacío -> unknown', () => expect(mapAddressKind('')).toBe('unknown'));
  it('asdf -> unknown', () => expect(mapAddressKind('asdf qwer')).toBe('unknown'));
  it('pickup tiene prioridad sobre urbano', () => {
    expect(mapAddressKind('Calle 8 oficina Interrapidísimo')).toBe('pickup_office');
  });
});
```

- [ ] **Step 2: Run test → debe fallar**

Run: `npx vitest run src/lib/mapAddressKind.test.ts`

- [ ] **Step 3: Implementar**

```typescript
// src/lib/mapAddressKind.ts
const PICKUP_PATTERNS = [
  /oficina[\s_-]*(inter[\s-]?rapidisimo|envia|coordinadora|tcc|domina|veloces|servientrega)/i,
  /\bsucursal\b/i,
  /cliente[\s_-]*retira/i,
  /\bpunto[\s_-]*(dropi|drop)\b/i,
  /retiro[\s_-]*en[\s_-]*oficina/i,
];

const RURAL_PATTERNS = [
  /\bmanzana\b/i, /\bmz\b/i, /\bmza\b/i, /\blote\b/i, /\blt\b/i,
  /\bfinca\b/i, /\bvereda\b/i, /\bcorregimiento\b/i, /\bkm\b/i,
  /kilometro/i, /\bsector\b/i,
];

const URBAN_PATTERNS = [
  /\bcalle\b/i, /\bcl\b/i, /\bcll\b/i, /\bcarrera\b/i, /\bcra\b/i,
  /\bkr\b/i, /\bavenida\b/i, /\bav\b/i, /\bdiagonal\b/i, /\bdg\b/i,
  /\btransversal\b/i, /\btv\b/i, /\bcdla\b/i,
];

function normalize(input: string): string {
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function mapAddressKind(direccion: string): 'urban' | 'rural' | 'pickup_office' | 'unknown' {
  if (!direccion || !direccion.trim()) return 'unknown';
  const n = normalize(direccion);
  if (PICKUP_PATTERNS.some((re) => re.test(n))) return 'pickup_office';
  if (RURAL_PATTERNS.some((re) => re.test(n))) return 'rural';
  if (URBAN_PATTERNS.some((re) => re.test(n))) return 'urban';
  return 'unknown';
}
```

- [ ] **Step 4: Run test → debe pasar**

Run: `npx vitest run src/lib/mapAddressKind.test.ts`
Expected: PASS — 19/19.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mapAddressKind.ts src/lib/mapAddressKind.test.ts
git commit -m "feat(validador): mapAddressKind detecta urban/rural/pickup_office"
```

---

### Task 9: Extender addressHeuristic.ts

**Files:**
- Modify: `src/lib/addressHeuristic.ts`

- [ ] **Step 1: Leer estructura actual**

Run: `head -80 src/lib/addressHeuristic.ts`

- [ ] **Step 2: Importar mapAddressKind**

Top del archivo:
```typescript
import { mapAddressKind } from './mapAddressKind';
```

- [ ] **Step 3: Antes de la lógica regex urbana, agregar early returns**

```typescript
const kind = mapAddressKind(direccion);

if (kind === 'pickup_office') {
  return {
    decision: 'green' as const,
    address_kind: 'pickup_office' as const,
    missing_fields: [],
    suggested_customer_message: '',
    localOnly: true,
  };
}

if (kind === 'rural') {
  return {
    decision: 'yellow' as const,
    address_kind: 'rural' as const,
    missing_fields: ['complemento'],
    suggested_customer_message: '',
    localOnly: true,
  };
}
```

- [ ] **Step 4: En el return final urbano, agregar `address_kind: kind`**

- [ ] **Step 5: Build pasa + tests existentes pasan**

Run: `npm run build && npm run test`
Expected: build limpio + tests no se rompen.

- [ ] **Step 6: Commit**

```bash
git add src/lib/addressHeuristic.ts
git commit -m "feat(validador): heurística rural-aware + pickup-office detection"
```

---

### Task 10: Extender edge function dropi-validate-address

**Files:**
- Create: `supabase/functions/dropi-validate-address/_addressKind.ts`
- Modify: `supabase/functions/dropi-validate-address/index.ts`

- [ ] **Step 1: Crear port de mapAddressKind para Deno**

```typescript
// supabase/functions/dropi-validate-address/_addressKind.ts
// Port intencional de src/lib/mapAddressKind.ts. Mantener sincronizado.

const PICKUP_PATTERNS = [
  /oficina[\s_-]*(inter[\s-]?rapidisimo|envia|coordinadora|tcc|domina|veloces|servientrega)/i,
  /\bsucursal\b/i,
  /cliente[\s_-]*retira/i,
  /\bpunto[\s_-]*(dropi|drop)\b/i,
  /retiro[\s_-]*en[\s_-]*oficina/i,
];

const RURAL_PATTERNS = [
  /\bmanzana\b/i, /\bmz\b/i, /\bmza\b/i, /\blote\b/i, /\blt\b/i,
  /\bfinca\b/i, /\bvereda\b/i, /\bcorregimiento\b/i, /\bkm\b/i,
  /kilometro/i, /\bsector\b/i,
];

const URBAN_PATTERNS = [
  /\bcalle\b/i, /\bcl\b/i, /\bcll\b/i, /\bcarrera\b/i, /\bcra\b/i,
  /\bkr\b/i, /\bavenida\b/i, /\bav\b/i, /\bdiagonal\b/i, /\bdg\b/i,
  /\btransversal\b/i, /\btv\b/i, /\bcdla\b/i,
];

function normalize(input: string): string {
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function mapAddressKind(direccion: string): 'urban' | 'rural' | 'pickup_office' | 'unknown' {
  if (!direccion || !direccion.trim()) return 'unknown';
  const n = normalize(direccion);
  if (PICKUP_PATTERNS.some((re) => re.test(n))) return 'pickup_office';
  if (RURAL_PATTERNS.some((re) => re.test(n))) return 'rural';
  if (URBAN_PATTERNS.some((re) => re.test(n))) return 'urban';
  return 'unknown';
}
```

- [ ] **Step 2: Importar y usar en index.ts**

```typescript
import { mapAddressKind } from "./_addressKind.ts";
```

Antes de llamar a Google Address Validation:

```typescript
const kind = mapAddressKind(direccion);

if (kind === 'pickup_office') {
  return new Response(JSON.stringify({
    ok: true,
    decision: 'green',
    address_kind: 'pickup_office',
    missing_fields: [],
    suggested_customer_message: '',
  }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
```

- [ ] **Step 3: Agregar chequeo de cuota antes del fetch a Google Address Validation**

```typescript
const { data: quotaOK } = await sb.rpc('consume_google_quota', { p_amount_usd: 0.005 });
if (!quotaOK) {
  return new Response(JSON.stringify({
    ok: true,
    decision: 'yellow',
    address_kind: kind,
    missing_fields: [],
    suggested_customer_message: '',
    localOnly: true,
    fallback_reason: 'cap_exceeded',
  }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
```

- [ ] **Step 4: Agregar capa Haiku 4.5 condicional**

Después de Google Address Validation, si el resultado es ambiguo:

```typescript
if (googleResult.suspicious || googleResult.hasUnconfirmedComponents) {
  const haikuQuota = await sb.rpc('consume_google_quota', { p_amount_usd: 0.0005 });
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');

  if (haikuQuota.data && anthropicKey) {
    const haikuRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Eres un analista de logística COD en Colombia. Analiza esta dirección y decide si es entregable.\n\nDirección: ${direccion}\nCiudad: ${ciudad}\nDepartamento: ${departamento}\n\nResponde SOLO con JSON:\n{\n  "decision": "green" | "yellow" | "red",\n  "address_kind": "urban" | "rural" | "pickup_office" | "unknown",\n  "missing_fields": [...],\n  "suggested_customer_message": "Hola, ..."\n}`,
        }],
      }),
    });

    if (haikuRes.ok) {
      const haikuData = await haikuRes.json();
      const text = haikuData.content?.[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        decision = parsed.decision;
        missing_fields = parsed.missing_fields ?? [];
        suggested_customer_message = parsed.suggested_customer_message ?? '';
      }
    }
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/dropi-validate-address/index.ts supabase/functions/dropi-validate-address/_addressKind.ts
git commit -m "feat(validador): edge function con pickup + rural-aware + Haiku + cap"
```

---

### Task 11: Hook useGooglePlaces

**Files:**
- Create: `src/hooks/useGooglePlaces.ts`

- [ ] **Step 1: Crear el hook**

```typescript
// src/hooks/useGooglePlaces.ts
import { useEffect, useRef, useState } from 'react';

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

interface AutocompletePrediction {
  description: string;
  place_id: string;
  structured_formatting?: { main_text: string; secondary_text: string };
}

interface PlaceDetailsResult {
  place_id: string;
  formatted_address: string;
  geometry?: { location?: { lat: () => number; lng: () => number } };
  address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
}

interface GoogleApi {
  autocomplete: (query: string, ciudadBias?: string) => Promise<AutocompletePrediction[]>;
  getDetails: (place_id: string) => Promise<PlaceDetailsResult | null>;
  available: boolean;
}

let scriptLoadPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (scriptLoadPromise) return scriptLoadPromise;
  if (!GOOGLE_MAPS_KEY) {
    scriptLoadPromise = Promise.reject(new Error('VITE_GOOGLE_MAPS_API_KEY missing'));
    return scriptLoadPromise;
  }
  if (typeof window !== 'undefined' && (window as unknown as { google?: unknown }).google) {
    scriptLoadPromise = Promise.resolve();
    return scriptLoadPromise;
  }
  scriptLoadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_KEY}&libraries=places&v=weekly`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Maps script'));
    document.head.appendChild(script);
  });
  return scriptLoadPromise;
}

const memoryCache = new Map<string, AutocompletePrediction[]>();

function memoryKey(query: string, ciudad?: string): string {
  return `${query.trim().toLowerCase()}|${(ciudad || '').toLowerCase()}`;
}

export function useGooglePlaces(): GoogleApi {
  const [available, setAvailable] = useState(false);
  const sessionTokenRef = useRef<unknown>(null);

  useEffect(() => {
    loadScript().then(() => setAvailable(true)).catch(() => setAvailable(false));
  }, []);

  return {
    available,

    autocomplete: async (query: string, ciudadBias?: string) => {
      if (!available || !query.trim()) return [];
      const key = memoryKey(query, ciudadBias);
      const cached = memoryCache.get(key);
      if (cached) return cached;

      const google = (window as unknown as { google: { maps: { places: { AutocompleteService: new () => unknown; AutocompleteSessionToken: new () => unknown } } } }).google;
      if (!google) return [];

      if (!sessionTokenRef.current) {
        sessionTokenRef.current = new google.maps.places.AutocompleteSessionToken();
      }

      const service = new google.maps.places.AutocompleteService() as unknown as {
        getPlacePredictions: (
          req: Record<string, unknown>,
          cb: (preds: AutocompletePrediction[] | null, status: string) => void,
        ) => void;
      };

      return new Promise<AutocompletePrediction[]>((resolve) => {
        service.getPlacePredictions(
          {
            input: query,
            componentRestrictions: { country: 'co' },
            sessionToken: sessionTokenRef.current,
          },
          (predictions, status) => {
            const result = (status === 'OK' && Array.isArray(predictions)) ? predictions! : [];
            memoryCache.set(key, result);
            resolve(result);
          },
        );
      });
    },

    getDetails: async (place_id: string) => {
      if (!available) return null;
      const google = (window as unknown as { google: { maps: { places: { PlacesService: new (attr: HTMLDivElement) => unknown } } } }).google;
      if (!google) return null;

      const div = document.createElement('div');
      const service = new google.maps.places.PlacesService(div) as unknown as {
        getDetails: (
          req: Record<string, unknown>,
          cb: (place: PlaceDetailsResult | null, status: string) => void,
        ) => void;
      };

      return new Promise<PlaceDetailsResult | null>((resolve) => {
        service.getDetails(
          {
            placeId: place_id,
            fields: ['place_id', 'formatted_address', 'geometry', 'address_components'],
            sessionToken: sessionTokenRef.current,
          },
          (place, status) => {
            sessionTokenRef.current = null;
            resolve(status === 'OK' ? place : null);
          },
        );
      });
    },
  };
}
```

- [ ] **Step 2: Build pasa**

Run: `npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useGooglePlaces.ts
git commit -m "feat(validador): useGooglePlaces hook con lazy load + cache L1"
```

---

### Task 12: Hook useAddressAutocompleteCache

**Files:**
- Create: `src/hooks/useAddressAutocompleteCache.ts`

- [ ] **Step 1: Crear el hook**

```typescript
// src/hooks/useAddressAutocompleteCache.ts
import { supabase } from '@/integrations/supabase/client';
import { addressNormalize } from '@/lib/addressNormalize';

interface Suggestion {
  description: string;
  place_id: string;
  structured_formatting?: { main_text: string; secondary_text: string };
}

const TTL_DAYS = 30;

export interface RecurrentCustomerHit {
  direccion: string;
  google_place_id: string;
  lat: number | null;
  lng: number | null;
  upload_date: string;
}

export async function lookupAutocompleteCache(
  query: string,
  ciudad: string | undefined,
): Promise<Suggestion[] | null> {
  const norm = addressNormalize(query);
  if (!norm || norm.length < 3) return null;

  const { data } = await supabase
    .from('address_autocomplete_cache')
    .select('suggestions, expires_at')
    .eq('query_normalized', norm)
    .eq('ciudad_filter', ciudad ?? '')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  return data ? (data.suggestions as Suggestion[]) : null;
}

export async function storeAutocompleteCache(
  query: string,
  ciudad: string | undefined,
  suggestions: Suggestion[],
): Promise<void> {
  const norm = addressNormalize(query);
  if (!norm || norm.length < 3 || suggestions.length === 0) return;

  const expires_at = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await supabase
    .from('address_autocomplete_cache')
    .upsert(
      { query_normalized: norm, ciudad_filter: ciudad ?? '', suggestions, hit_count: 0, expires_at },
      { onConflict: 'query_normalized,ciudad_filter' },
    );
}

export async function lookupRecurrentCustomer(phone: string): Promise<RecurrentCustomerHit | null> {
  if (!phone || phone.length < 10) return null;

  const { data } = await supabase
    .from('orders')
    .select('direccion, google_place_id, lat, lng, upload_date')
    .eq('phone', phone)
    .not('google_place_id', 'is', null)
    .order('upload_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data || !data.google_place_id) return null;
  return data as RecurrentCustomerHit;
}
```

- [ ] **Step 2: Build pasa**

Run: `npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useAddressAutocompleteCache.ts
git commit -m "feat(validador): hooks Cache L2 (DB) + Cache L3 (recurrent customer)"
```

---

### Task 13: AddressFeedbackCard component

**Files:**
- Create: `src/components/address/AddressFeedbackCard.tsx`
- Test: `src/components/address/AddressFeedbackCard.test.tsx`

- [ ] **Step 1: Escribir test failing**

```tsx
// src/components/address/AddressFeedbackCard.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AddressFeedbackCard } from './AddressFeedbackCard';

const baseProps = {
  decision: 'green' as const,
  missingFields: [] as string[],
  suggestedMessage: '',
  isAdmin: false,
  onOverrideChange: vi.fn(),
  carrier: '',
};

describe('AddressFeedbackCard', () => {
  it('green muestra "Dirección verificada"', () => {
    render(<AddressFeedbackCard {...baseProps} />);
    expect(screen.getByText(/verificada/i)).toBeInTheDocument();
  });

  it('pickup_office muestra carrier', () => {
    render(<AddressFeedbackCard {...baseProps} decision="pickup_office" carrier="Interrapidísimo" />);
    expect(screen.getByText(/retiro/i)).toBeInTheDocument();
    expect(screen.getByText(/Interrapidísimo/)).toBeInTheDocument();
  });

  it('yellow muestra checks', () => {
    render(<AddressFeedbackCard {...baseProps} decision="yellow" missingFields={['barrio', 'complemento']} />);
    expect(screen.getByText(/barrio/i)).toBeInTheDocument();
    expect(screen.getByText(/referencia/i)).toBeInTheDocument();
  });

  it('red muestra missing_fields + botón Copiar', () => {
    render(<AddressFeedbackCard {...baseProps} decision="red" missingFields={['placa']} suggestedMessage="Hola Carlos" />);
    expect(screen.getByText(/falta/i)).toBeInTheDocument();
    expect(screen.getByText(/Hola Carlos/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copiar/i })).toBeInTheDocument();
  });

  it('red + admin muestra checkbox override', () => {
    render(<AddressFeedbackCard {...baseProps} decision="red" missingFields={['placa']} suggestedMessage="x" isAdmin={true} />);
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });

  it('red + non-admin NO muestra checkbox', () => {
    render(<AddressFeedbackCard {...baseProps} decision="red" missingFields={['placa']} suggestedMessage="x" isAdmin={false} />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('botón copiar invoca clipboard', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AddressFeedbackCard {...baseProps} decision="red" missingFields={['placa']} suggestedMessage="Mensaje a copiar" />);
    fireEvent.click(screen.getByRole('button', { name: /copiar/i }));
    expect(writeText).toHaveBeenCalledWith('Mensaje a copiar');
  });
});
```

- [ ] **Step 2: Run test → debe fallar**

Run: `npx vitest run src/components/address/AddressFeedbackCard.test.tsx`

- [ ] **Step 3: Implementar**

```tsx
// src/components/address/AddressFeedbackCard.tsx
import { useState } from 'react';
import { Check, AlertTriangle, AlertCircle, Store, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

const FIELD_LABEL_ES: Record<string, string> = {
  placa: 'placa de la casa',
  barrio: 'barrio',
  complemento: 'punto de referencia',
  telefono: 'teléfono alternativo',
};

export interface AddressFeedbackCardProps {
  decision: 'green' | 'yellow' | 'red' | 'pickup_office' | null;
  missingFields: string[];
  suggestedMessage: string;
  isAdmin: boolean;
  onOverrideChange: (overrideChecked: boolean) => void;
  carrier?: string;
}

export function AddressFeedbackCard({
  decision, missingFields, suggestedMessage, isAdmin, onOverrideChange, carrier,
}: AddressFeedbackCardProps) {
  const [copied, setCopied] = useState(false);
  const [overrideChecked, setOverrideChecked] = useState(false);

  if (decision === null) return null;

  if (decision === 'green') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
        <Check size={14} />
        <span>Dirección verificada</span>
      </div>
    );
  }

  if (decision === 'pickup_office') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-info/40 bg-info/10 px-3 py-2 text-sm text-info">
        <Store size={14} />
        <span>Retiro en oficina{carrier ? ` · ${carrier}` : ''}</span>
      </div>
    );
  }

  if (decision === 'yellow') {
    return (
      <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
        <div className="mb-1 flex items-center gap-2 text-warning font-medium">
          <AlertTriangle size={14} />
          <span>Confirmar con cliente:</span>
        </div>
        <ul className="ml-6 list-disc text-foreground">
          {missingFields.length > 0
            ? missingFields.map((f) => <li key={f}>{FIELD_LABEL_ES[f] ?? f}</li>)
            : <li>Verifica datos clave antes de despachar</li>}
        </ul>
      </div>
    );
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(suggestedMessage);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const handleOverride = (checked: boolean) => {
    setOverrideChecked(checked);
    onOverrideChange(checked);
  };

  return (
    <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm space-y-3">
      <div>
        <div className="mb-1 flex items-center gap-2 text-danger font-medium">
          <AlertCircle size={14} />
          <span>Falta:</span>
        </div>
        <ul className="ml-6 list-disc text-foreground">
          {missingFields.map((f) => <li key={f}>{FIELD_LABEL_ES[f] ?? f}</li>)}
        </ul>
      </div>

      {suggestedMessage && (
        <div>
          <div className="mb-1 font-medium text-foreground">Mensaje WhatsApp sugerido:</div>
          <div className="rounded bg-card border border-border p-2 text-xs text-muted-foreground whitespace-pre-wrap">
            {suggestedMessage}
          </div>
          <Button size="sm" variant="outline" className="mt-2" onClick={handleCopy}>
            <Copy size={12} className="mr-1" />
            {copied ? 'Copiado' : 'Copiar'}
          </Button>
        </div>
      )}

      {isAdmin && (
        <label className="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground">
          <Checkbox checked={overrideChecked} onCheckedChange={(v) => handleOverride(v === true)} />
          <span>Confirmé manualmente con el cliente — proceder</span>
        </label>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test → debe pasar**

Run: `npx vitest run src/components/address/AddressFeedbackCard.test.tsx`
Expected: PASS — 7/7.

- [ ] **Step 5: Commit**

```bash
git add src/components/address/AddressFeedbackCard.tsx src/components/address/AddressFeedbackCard.test.tsx
git commit -m "feat(validador): AddressFeedbackCard 4 estados + copiar WhatsApp"
```

---

### Task 14: AddressAutocomplete component

**Files:**
- Create: `src/components/address/AddressAutocomplete.tsx`
- Test: `src/components/address/AddressAutocomplete.test.tsx`

- [ ] **Step 1: Escribir test failing (con mocks)**

```tsx
// src/components/address/AddressAutocomplete.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddressAutocomplete } from './AddressAutocomplete';

vi.mock('@/hooks/useGooglePlaces', () => ({
  useGooglePlaces: () => ({
    available: true,
    autocomplete: vi.fn().mockResolvedValue([
      { place_id: 'p1', description: 'Calle 8 #5-67, Bogotá', structured_formatting: { main_text: 'Calle 8 #5-67', secondary_text: 'Bogotá' } },
    ]),
    getDetails: vi.fn().mockResolvedValue({
      place_id: 'p1',
      formatted_address: 'Calle 8 #5-67, Bogotá, Colombia',
      geometry: { location: { lat: () => 4.601, lng: () => -74.062 } },
      address_components: [{ long_name: 'Bogotá', short_name: 'Bogotá', types: ['locality'] }],
    }),
  }),
}));

vi.mock('@/hooks/useAddressAutocompleteCache', () => ({
  lookupAutocompleteCache: vi.fn().mockResolvedValue(null),
  storeAutocompleteCache: vi.fn().mockResolvedValue(undefined),
  lookupRecurrentCustomer: vi.fn().mockResolvedValue(null),
}));

describe('AddressAutocomplete', () => {
  it('renderiza input con value inicial', () => {
    render(<AddressAutocomplete value="texto inicial" onChange={vi.fn()} />);
    expect(screen.getByDisplayValue('texto inicial')).toBeInTheDocument();
  });

  it('al tipear muestra sugerencias después de debounce', async () => {
    render(<AddressAutocomplete value="" onChange={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Calle 8' } });
    await waitFor(() => expect(screen.getByText(/Calle 8 #5-67/)).toBeInTheDocument(), { timeout: 1000 });
  });

  it('click en sugerencia llama onChange con datos completos', async () => {
    const onChange = vi.fn();
    render(<AddressAutocomplete value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Calle 8' } });
    await waitFor(() => screen.getByText(/Calle 8 #5-67/), { timeout: 1000 });
    fireEvent.click(screen.getByText(/Calle 8 #5-67/));
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
        direccion: 'Calle 8 #5-67, Bogotá, Colombia',
        place_id: 'p1',
        lat: 4.601,
        lng: -74.062,
        source: 'autocomplete',
      }));
    });
  });

  it('muestra opción "escribir libre"', async () => {
    render(<AddressAutocomplete value="" onChange={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Calle 8' } });
    await waitFor(() => expect(screen.getByText(/escribir libre/i)).toBeInTheDocument(), { timeout: 1000 });
  });
});
```

- [ ] **Step 2: Run test → debe fallar**

Run: `npx vitest run src/components/address/AddressAutocomplete.test.tsx`

- [ ] **Step 3: Implementar**

```tsx
// src/components/address/AddressAutocomplete.tsx
import { useEffect, useRef, useState } from 'react';
import { MapPin, Edit2, Check } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useGooglePlaces } from '@/hooks/useGooglePlaces';
import {
  lookupAutocompleteCache, storeAutocompleteCache, lookupRecurrentCustomer,
} from '@/hooks/useAddressAutocompleteCache';
import { parseGooglePlace } from '@/lib/parseGooglePlace';
import { mapAddressKind } from '@/lib/mapAddressKind';

export interface AddressUpdate {
  direccion: string;
  barrio?: string;
  place_id?: string;
  lat?: number | null;
  lng?: number | null;
  address_kind: 'urban' | 'rural' | 'pickup_office' | 'unknown';
  source: 'autocomplete' | 'free_write' | 'recurrent_customer';
}

interface Suggestion {
  description: string;
  place_id: string;
  structured_formatting?: { main_text: string; secondary_text: string };
}

interface Props {
  value: string;
  onChange: (next: AddressUpdate) => void;
  ciudad?: string;
  departamento?: string;
  customerPhone?: string;
  disabled?: boolean;
  placeholder?: string;
}

const DEBOUNCE_MS = 300;
const MIN_CHARS = 3;

export function AddressAutocomplete({
  value, onChange, ciudad, customerPhone, disabled, placeholder,
}: Props) {
  const [query, setQuery] = useState(value);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [recurrent, setRecurrent] = useState<{ direccion: string; place_id: string; lat: number | null; lng: number | null } | null>(null);
  const [recurrentDismissed, setRecurrentDismissed] = useState(false);
  const [selectedFromAutocomplete, setSelectedFromAutocomplete] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const places = useGooglePlaces();

  useEffect(() => {
    if (!customerPhone) return;
    void lookupRecurrentCustomer(customerPhone).then((hit) => {
      if (hit && hit.direccion !== value) {
        setRecurrent({ direccion: hit.direccion, place_id: hit.google_place_id, lat: hit.lat, lng: hit.lng });
      }
    });
  }, [customerPhone, value]);

  useEffect(() => { setQuery(value); }, [value]);

  const fetchSuggestions = async (q: string) => {
    if (q.length < MIN_CHARS) {
      setSuggestions([]);
      return;
    }
    const cached = await lookupAutocompleteCache(q, ciudad);
    if (cached) {
      setSuggestions(cached);
      setOpen(true);
      return;
    }
    if (places.available) {
      const result = await places.autocomplete(q, ciudad);
      setSuggestions(result);
      setOpen(true);
      void storeAutocompleteCache(q, ciudad, result);
    }
  };

  const handleInput = (next: string) => {
    setQuery(next);
    setSelectedFromAutocomplete(false);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => fetchSuggestions(next), DEBOUNCE_MS);

    onChange({ direccion: next, address_kind: mapAddressKind(next), source: 'free_write' });
  };

  const handleSelect = async (sug: Suggestion) => {
    const details = places.available ? await places.getDetails(sug.place_id) : null;
    if (details) {
      const parsed = parseGooglePlace(details);
      onChange({
        direccion: parsed.direccion,
        barrio: parsed.barrio ?? undefined,
        place_id: parsed.place_id ?? undefined,
        lat: parsed.lat,
        lng: parsed.lng,
        address_kind: parsed.address_kind === 'urban' ? 'urban' : 'unknown',
        source: 'autocomplete',
      });
      setQuery(parsed.direccion);
    } else {
      onChange({ direccion: sug.description, place_id: sug.place_id, address_kind: 'urban', source: 'autocomplete' });
      setQuery(sug.description);
    }
    setSelectedFromAutocomplete(true);
    setOpen(false);
  };

  const useRecurrent = () => {
    if (!recurrent) return;
    setQuery(recurrent.direccion);
    onChange({
      direccion: recurrent.direccion,
      place_id: recurrent.place_id,
      lat: recurrent.lat,
      lng: recurrent.lng,
      address_kind: 'urban',
      source: 'recurrent_customer',
    });
    setRecurrentDismissed(true);
  };

  return (
    <div className="relative w-full space-y-2">
      {recurrent && !recurrentDismissed && (
        <div className="rounded-md border border-info/40 bg-info/10 p-2 text-xs">
          <div className="flex items-center gap-2 text-info font-medium">
            <MapPin size={12} />
            <span>Misma dirección de pedido anterior:</span>
          </div>
          <div className="ml-4 mt-1 text-foreground">{recurrent.direccion}</div>
          <div className="ml-4 mt-1 flex gap-2">
            <button type="button" className="text-info hover:underline" onClick={useRecurrent}>Usar esta</button>
            <button type="button" className="text-muted-foreground hover:underline" onClick={() => setRecurrentDismissed(true)}>Editar nueva</button>
          </div>
        </div>
      )}

      <div className="relative">
        <Input
          value={query}
          onChange={(e) => handleInput(e.target.value)}
          disabled={disabled}
          placeholder={placeholder ?? 'Calle 8 #5-67, Bogotá'}
          onFocus={() => query.length >= MIN_CHARS && suggestions.length > 0 && setOpen(true)}
          className="pr-8"
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground">
          {selectedFromAutocomplete ? <Check size={14} className="text-success" /> : <Edit2 size={14} />}
        </span>
      </div>

      {open && suggestions.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full rounded-md border border-border bg-card shadow-lg">
          {suggestions.slice(0, 5).map((sug) => (
            <li key={sug.place_id}>
              <button
                type="button"
                className="w-full text-left px-3 py-2 hover:bg-muted/40 text-sm"
                onClick={() => handleSelect(sug)}
              >
                <div className="font-medium">{sug.structured_formatting?.main_text ?? sug.description}</div>
                {sug.structured_formatting?.secondary_text && (
                  <div className="text-xs text-muted-foreground">{sug.structured_formatting.secondary_text}</div>
                )}
              </button>
            </li>
          ))}
          <li className="border-t border-border">
            <button
              type="button"
              className="w-full text-left px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40"
              onClick={() => setOpen(false)}
            >
              Mi dirección no está aquí — escribir libre
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test → debe pasar**

Run: `npx vitest run src/components/address/AddressAutocomplete.test.tsx`
Expected: PASS — 4/4.

- [ ] **Step 5: Commit**

```bash
git add src/components/address/AddressAutocomplete.tsx src/components/address/AddressAutocomplete.test.tsx
git commit -m "feat(validador): AddressAutocomplete con cache 3 capas + Google Places"
```

---

### Task 15: DespachoGateButton component

**Files:**
- Create: `src/components/address/DespachoGateButton.tsx`
- Test: `src/components/address/DespachoGateButton.test.tsx`

- [ ] **Step 1: Escribir test failing**

```tsx
// src/components/address/DespachoGateButton.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DespachoGateButton } from './DespachoGateButton';

const baseGate = {
  validation_decision: 'green' as const,
  telefonoValido: true,
  documentoSiCoordinadora: true,
  isAdmin: false,
  overrideChecked: false,
};

describe('DespachoGateButton', () => {
  it('green: button habilitado', () => {
    const onConfirm = vi.fn();
    render(<DespachoGateButton gate={baseGate} onConfirm={onConfirm}>Confirmar</DespachoGateButton>);
    const btn = screen.getByRole('button', { name: /confirmar/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalled();
  });

  it('red sin override: button disabled', () => {
    render(<DespachoGateButton gate={{ ...baseGate, validation_decision: 'red' }} onConfirm={vi.fn()}>Confirmar</DespachoGateButton>);
    expect(screen.getByRole('button', { name: /confirmar/i })).toBeDisabled();
  });

  it('phone invalid: button disabled', () => {
    render(<DespachoGateButton gate={{ ...baseGate, telefonoValido: false }} onConfirm={vi.fn()}>Confirmar</DespachoGateButton>);
    expect(screen.getByRole('button', { name: /confirmar/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test → debe fallar**

Run: `npx vitest run src/components/address/DespachoGateButton.test.tsx`

- [ ] **Step 3: Implementar**

```tsx
// src/components/address/DespachoGateButton.tsx
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { canConfirmOrder, type CanConfirmInput } from '@/lib/canConfirmOrder';

interface Props {
  gate: CanConfirmInput;
  onConfirm: () => void;
  children: ReactNode;
  variant?: 'default' | 'outline';
  size?: 'default' | 'sm' | 'lg';
}

export function DespachoGateButton({ gate, onConfirm, children, variant = 'default', size = 'default' }: Props) {
  const result = canConfirmOrder(gate);

  if (result.canConfirm) {
    return <Button variant={variant} size={size} onClick={onConfirm}>{children}</Button>;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-block">
            <Button variant={variant} size={size} disabled>{children}</Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{result.reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
```

- [ ] **Step 4: Run test → debe pasar**

Run: `npx vitest run src/components/address/DespachoGateButton.test.tsx`
Expected: PASS — 3/3.

- [ ] **Step 5: Commit**

```bash
git add src/components/address/DespachoGateButton.tsx src/components/address/DespachoGateButton.test.tsx
git commit -m "feat(validador): DespachoGateButton con tooltip de motivo"
```

---

### Task 16: Integrar componentes en CallView

**Files:**
- Modify: `src/components/CallView.tsx`

- [ ] **Step 1: Localizar el input de dirección y el botón Confirmar actuales**

Run: `grep -n "direccion\|AddressValidationBadge\|onConfirm\|handleConfirmar" src/components/CallView.tsx`

- [ ] **Step 2: Importar componentes nuevos**

```tsx
import { AddressAutocomplete } from '@/components/address/AddressAutocomplete';
import { AddressFeedbackCard } from '@/components/address/AddressFeedbackCard';
import { DespachoGateButton } from '@/components/address/DespachoGateButton';
```

- [ ] **Step 3: Agregar state local para override**

```tsx
const [addressOverride, setAddressOverride] = useState(false);
```

- [ ] **Step 4: Helper validarTelefono**

```tsx
function validarTelefono(phone: string): boolean {
  const clean = (phone || '').replace(/\D/g, '');
  return clean.length === 10 && clean.startsWith('3');
}
```

- [ ] **Step 5: Reemplazar input dirección por AddressAutocomplete**

```tsx
<AddressAutocomplete
  value={order.direccion}
  ciudad={order.ciudad}
  departamento={order.departamento}
  customerPhone={order.phone}
  onChange={(update) => {
    const patch: Record<string, unknown> = { direccion: update.direccion };
    if (update.barrio !== undefined) patch.barrio = update.barrio;
    if (update.place_id !== undefined) patch.google_place_id = update.place_id;
    if (update.lat !== undefined) patch.lat = update.lat;
    if (update.lng !== undefined) patch.lng = update.lng;
    patch.address_kind = update.address_kind;
    if (update.source === 'autocomplete' || update.source === 'recurrent_customer') {
      patch.validation_decision = 'green';
      patch.missing_fields = [];
      patch.suggested_customer_message = '';
    }
    void supabase.from('orders').update(patch).eq('id', order.id);
  }}
/>
```

- [ ] **Step 6: Insertar AddressFeedbackCard debajo del input**

```tsx
<AddressFeedbackCard
  decision={order.validationDecision}
  missingFields={order.missingFields ?? []}
  suggestedMessage={order.suggestedCustomerMessage}
  isAdmin={isAdmin}
  carrier={order.transportadora}
  onOverrideChange={setAddressOverride}
/>
```

- [ ] **Step 7: Reemplazar botón Confirmar por DespachoGateButton**

```tsx
<DespachoGateButton
  gate={{
    validation_decision: order.validationDecision,
    telefonoValido: validarTelefono(order.phone),
    documentoSiCoordinadora: (order.transportadora || '').toLowerCase() !== 'coordinadora' || Boolean(order.documentoDestinatario),
    isAdmin,
    overrideChecked: addressOverride,
  }}
  onConfirm={handleConfirmar}
>
  Confirmar pedido
</DespachoGateButton>
```

- [ ] **Step 8: Build pasa**

Run: `npm run build`

- [ ] **Step 9: Commit**

```bash
git add src/components/CallView.tsx
git commit -m "feat(validador): integrar autocomplete + feedback + gate en CallView"
```

---

### Task 17: Integrar componentes en EditOrderDialog

**Files:**
- Modify: `src/components/EditOrderDialog.tsx`

- [ ] **Step 1: Leer EditOrderDialog**

Run: `grep -n "direccion\|AddressValidationBadge" src/components/EditOrderDialog.tsx`

- [ ] **Step 2: Importar AddressAutocomplete + AddressFeedbackCard**

```tsx
import { AddressAutocomplete } from '@/components/address/AddressAutocomplete';
import { AddressFeedbackCard } from '@/components/address/AddressFeedbackCard';
```

- [ ] **Step 3: Reemplazar input por AddressAutocomplete (adaptado al state local)**

```tsx
<AddressAutocomplete
  value={formData.direccion}
  ciudad={formData.ciudad}
  customerPhone={formData.phone}
  onChange={(update) => {
    setFormData((prev) => ({
      ...prev,
      direccion: update.direccion,
      ...(update.barrio !== undefined ? { barrio: update.barrio } : {}),
      ...(update.place_id !== undefined ? { googlePlaceId: update.place_id } : {}),
      ...(update.lat !== undefined ? { lat: update.lat } : {}),
      ...(update.lng !== undefined ? { lng: update.lng } : {}),
      addressKind: update.address_kind,
      ...(update.source === 'autocomplete' || update.source === 'recurrent_customer' ? {
        validationDecision: 'green' as const,
        missingFields: [] as string[],
        suggestedCustomerMessage: '',
      } : {}),
    }));
  }}
/>
```

- [ ] **Step 4: Insertar AddressFeedbackCard**

```tsx
<AddressFeedbackCard
  decision={formData.validationDecision}
  missingFields={formData.missingFields ?? []}
  suggestedMessage={formData.suggestedCustomerMessage ?? ''}
  isAdmin={isAdmin}
  carrier={formData.transportadora}
  onOverrideChange={() => { /* EditOrderDialog no aplica gate */ }}
/>
```

- [ ] **Step 5: Build pasa**

Run: `npm run build`

- [ ] **Step 6: Commit**

```bash
git add src/components/EditOrderDialog.tsx
git commit -m "feat(validador): integrar autocomplete + feedback en EditOrderDialog"
```

---

### Task 18: Integrar AddressFeedbackCard en CrmCallView

**Files:**
- Modify: `src/components/CrmCallView.tsx`

- [ ] **Step 1: Localizar AddressValidationBadge actual**

Run: `grep -n "AddressValidationBadge" src/components/CrmCallView.tsx`

- [ ] **Step 2: Reemplazar por AddressFeedbackCard**

```tsx
import { AddressFeedbackCard } from '@/components/address/AddressFeedbackCard';

// Reemplazar el badge actual por:
<AddressFeedbackCard
  decision={order.validationDecision}
  missingFields={order.missingFields ?? []}
  suggestedMessage={order.suggestedCustomerMessage}
  isAdmin={isAdmin}
  carrier={order.transportadora}
  onOverrideChange={() => { /* legacy, sin gate */ }}
/>
```

(NO reemplazar input de dirección — CrmCallView es legacy y no merece autocomplete.)

- [ ] **Step 3: Build pasa**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add src/components/CrmCallView.tsx
git commit -m "feat(validador): AddressFeedbackCard en CrmCallView legacy"
```

---

### Task 19: Reemplazar colombiaGeo.ts con catálogo DANE

**Files:**
- Modify: `src/lib/colombiaGeo.ts`
- Create: `src/lib/dane-divipola.json`

- [ ] **Step 1: Bajar catálogo DANE (acción manual del implementer)**

El implementer descarga el dataset oficial de https://www.datos.gov.co/Mapas-Nacionales/DIVIPOLA-Codigos-municipios/gdxc-w37w (CSV) y lo convierte a JSON con shape `{ departamento: string, ciudad: string, codigo_dane: string }[]`. Debe contener ~1.123 municipios. Bogotá D.C. va separado de Cundinamarca.

Si el implementer no puede descargar (sandboxed), usar el package npm `colombia-divipola` o equivalente como fallback:

```bash
npm install colombia-divipola
node -e "console.log(JSON.stringify(require('colombia-divipola').municipios.map(m => ({ departamento: m.dept, ciudad: m.name, codigo_dane: m.code }))))" > src/lib/dane-divipola.json
```

- [ ] **Step 2: Reemplazar `src/lib/colombiaGeo.ts`**

```typescript
// src/lib/colombiaGeo.ts
import dane from './dane-divipola.json';

export interface DivipolaEntry {
  departamento: string;
  ciudad: string;
  codigo_dane: string;
}

const ENTRIES = dane as DivipolaEntry[];

export function getDepartamentos(): string[] {
  const set = new Set(ENTRIES.map((e) => e.departamento));
  return Array.from(set).sort();
}

export function getCiudadesDe(departamento: string): string[] {
  return ENTRIES
    .filter((e) => e.departamento === departamento)
    .map((e) => e.ciudad)
    .sort();
}

export function getDaneCode(departamento: string, ciudad: string): string | null {
  const match = ENTRIES.find((e) => e.departamento === departamento && e.ciudad === ciudad);
  return match ? match.codigo_dane : null;
}
```

- [ ] **Step 3: Build pasa + tests existentes pasan**

Run: `npm run build && npm run test`
Expected: API pública (`getCiudadesDe`, `getDepartamentos`) mantiene firmas, tests no se rompen.

- [ ] **Step 4: Commit**

```bash
git add src/lib/colombiaGeo.ts src/lib/dane-divipola.json
git commit -m "feat(validador): catálogo DANE 1.123 municipios reemplaza estático"
```

---

### Task 20: Hook useGoogleQuota

**Files:**
- Create: `src/hooks/useGoogleQuota.ts`

- [ ] **Step 1: Crear el hook**

```typescript
// src/hooks/useGoogleQuota.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

interface QuotaSnapshot {
  budget_usd: number;
  used_usd: number;
  used_today_date: string;
  pct: number;
  exceeded: boolean;
}

async function fetchQuota(): Promise<QuotaSnapshot> {
  const { data } = await supabase
    .from('app_settings')
    .select('key, value')
    .in('key', ['google_api_daily_budget_usd', 'google_api_used_today_usd', 'google_api_used_today_date']);

  const map = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  const budget = parseFloat(map.google_api_daily_budget_usd ?? '2.50');
  const used = parseFloat(map.google_api_used_today_usd ?? '0.00');
  const used_today_date = map.google_api_used_today_date ?? '';

  return {
    budget_usd: budget,
    used_usd: used,
    used_today_date,
    pct: budget > 0 ? Math.min(1, used / budget) : 0,
    exceeded: used >= budget,
  };
}

export function useGoogleQuota() {
  return useQuery({
    queryKey: ['google_quota'],
    queryFn: fetchQuota,
    refetchInterval: 60_000,
    staleTime: 50_000,
  });
}
```

- [ ] **Step 2: Build pasa**

Run: `npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useGoogleQuota.ts
git commit -m "feat(validador): useGoogleQuota hook"
```

---

### Task 21: GoogleQuotaWidget admin component

**Files:**
- Create: `src/components/admin/GoogleQuotaWidget.tsx`
- Test: `src/components/admin/GoogleQuotaWidget.test.tsx`

- [ ] **Step 1: Escribir test failing**

```tsx
// src/components/admin/GoogleQuotaWidget.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GoogleQuotaWidget } from './GoogleQuotaWidget';

vi.mock('@/hooks/useGoogleQuota', () => ({
  useGoogleQuota: () => ({
    data: { budget_usd: 2.5, used_usd: 0.43, used_today_date: '2026-04-29', pct: 0.172, exceeded: false },
    isLoading: false,
  }),
}));

describe('GoogleQuotaWidget', () => {
  const wrap = (ui: React.ReactNode) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
  };

  it('muestra usado/budget', () => {
    wrap(<GoogleQuotaWidget />);
    expect(screen.getByText(/0\.43/)).toBeInTheDocument();
    expect(screen.getByText(/2\.50/)).toBeInTheDocument();
  });

  it('muestra porcentaje', () => {
    wrap(<GoogleQuotaWidget />);
    expect(screen.getByText(/17%/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test → debe fallar**

Run: `npx vitest run src/components/admin/GoogleQuotaWidget.test.tsx`

- [ ] **Step 3: Implementar**

```tsx
// src/components/admin/GoogleQuotaWidget.tsx
import { Activity, AlertTriangle } from 'lucide-react';
import { useGoogleQuota } from '@/hooks/useGoogleQuota';

export function GoogleQuotaWidget() {
  const { data, isLoading } = useGoogleQuota();

  if (isLoading || !data) {
    return <div className="rounded-md border border-border bg-card p-3 text-sm text-muted-foreground">Cargando cuota Google…</div>;
  }

  const pct = Math.round(data.pct * 100);
  const tone = data.exceeded ? 'danger' : data.pct > 0.8 ? 'warning' : 'info';

  const toneClass = tone === 'danger'
    ? 'border-danger/40 bg-danger/10 text-danger'
    : tone === 'warning'
      ? 'border-warning/40 bg-warning/10 text-warning'
      : 'border-info/40 bg-info/10 text-info';

  const Icon = tone === 'danger' || tone === 'warning' ? AlertTriangle : Activity;

  return (
    <div className={`rounded-md border p-3 text-sm ${toneClass}`}>
      <div className="flex items-center gap-2 font-medium">
        <Icon size={14} />
        <span>Cuota Google API hoy</span>
      </div>
      <div className="mt-2 text-foreground tabular-nums">
        Usado: <span className="font-semibold">${data.used_usd.toFixed(2)}</span> / ${data.budget_usd.toFixed(2)} ({pct}%)
      </div>
      <div className="mt-1 text-xs text-muted-foreground">Fecha: {data.used_today_date}</div>
      {data.exceeded && (
        <div className="mt-2 text-xs text-danger">Cuota excedida — autocomplete deshabilitado hasta mañana</div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test → debe pasar**

Run: `npx vitest run src/components/admin/GoogleQuotaWidget.test.tsx`
Expected: PASS — 2/2.

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/GoogleQuotaWidget.tsx src/components/admin/GoogleQuotaWidget.test.tsx
git commit -m "feat(validador): GoogleQuotaWidget para admin"
```

---

### Task 22: Integrar GoogleQuotaWidget en AdminTab

**Files:**
- Modify: `src/components/tabs/AdminTab.tsx`

- [ ] **Step 1: Leer AdminTab para encontrar lugar adecuado**

Run: `grep -n "Token sesión\|<section\|<Card\|export default" src/components/tabs/AdminTab.tsx | head -10`

- [ ] **Step 2: Importar y agregar al JSX**

Top:
```tsx
import { GoogleQuotaWidget } from '@/components/admin/GoogleQuotaWidget';
```

En el JSX (cerca de la sección "Token sesión Dropi"):
```tsx
<div className="my-4">
  <GoogleQuotaWidget />
</div>
```

- [ ] **Step 3: Build pasa**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add src/components/tabs/AdminTab.tsx
git commit -m "feat(validador): widget de cuota Google en AdminTab"
```

---

### Task 23: Smoke test manual + cierre

**Files:** ninguno — solo validación en preview de Lovable.

- [ ] **Step 1: Aplicar las dos migraciones SQL en Lovable Cloud**

Pegar el contenido de `supabase/migrations/20260501000000_validador_direcciones.sql` en SQL Editor → Run. Después la `_cron.sql` → Run. Ambas deben decir "Query succeeded".

- [ ] **Step 2: Pedir a Lovable que redeploye edge function**

Prompt en chat de Lovable: "Redeploya `dropi-validate-address` con el commit actual de main".

- [ ] **Step 3: Smoke checklist en /confirmar**

- [ ] CallView abre, tipear "Calle 8" en dirección → ver sugerencias urbanas
- [ ] Click en sugerencia → form se llena, ícono check aparece, badge verde
- [ ] Tipear "Vereda La Esmeralda" → "no hay coincidencias", click "escribir libre"
- [ ] Termina de tipear, blur → badge yellow con feedback rural
- [ ] Pedido `pickup_office`: tipear "Oficina Interrapidísimo Cali" → detección automática, badge "Retiro en oficina"
- [ ] Pedido red: badge muestra missing_fields + botón Copiar funciona
- [ ] Admin override: checkbox desbloquea botón Confirmar
- [ ] Operadora normal sin override: botón Confirmar disabled con tooltip
- [ ] Cargar pedido cuyo cliente tiene `place_id` → banner "misma dirección anterior" → click "usar esta" → pedido nuevo hereda place_id
- [ ] /admin: ver `GoogleQuotaWidget` con usado/budget visible

- [ ] **Step 4: Smoke EditOrderDialog**

- [ ] Editar pedido, dirección actual prellenada
- [ ] Cambiar dirección con autocomplete → guarda con place_id, lat, lng
- [ ] Si cliente cambia dirección a libre, badge re-valida al guardar

- [ ] **Step 5: Excel upload no rompe**

- [ ] Subir Excel viejo con direcciones libres → todas las filas se cargan, `validation_decision` queda null hasta que se abran

- [ ] **Step 6: Tag de release**

```bash
git commit --allow-empty -m "release: validador direcciones con autocomplete v1"
git tag validador-direcciones-v1
git push origin main --tags
```

---

## Verificación final del plan

Después de las 23 tasks:

1. Run: `npm run build` → limpio
2. Run: `npm run test` → todos los nuevos pass + tests existentes pass
3. Grep checks:
   - `grep -r "claude-haiku-4-5-20251001" src/` → 0 matches en src/ (solo en edge function)
   - `grep -rn "AddressValidationBadge" src/components/CallView.tsx src/components/EditOrderDialog.tsx` → 0 matches
4. Smoke completo (Task 23) pasa
5. GCP Console: alert configurado a $25 (50%) y $40 (80%), hard cap a $50

---

## Anti-patrones a evitar (recordatorio durante implementación)

- Llamar Haiku para CADA pedido (solo cuando Google suspicious + heurística no decide)
- Forzar autocomplete cuando Google no encuentra match rural — usar opción "escribir libre"
- Reescribir AddressValidationBadge — solo reemplazar en surfaces de edición
- Mergear este plan con el del otro Claude — esta spec REEMPLAZA su versión 2026-04-28
- Aplicar migraciones sin verificar que las RPCs `consume_google_quota` y `cleanup_expired_autocomplete_cache` se crearon
