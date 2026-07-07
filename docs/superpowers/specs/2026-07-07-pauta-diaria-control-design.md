# Control diario de pauta por tienda — Diseño

**Fecha:** 2026-07-07
**Estado:** Aprobado por el dueño (Fabian) — implementado con reconciliación (ver abajo).

## ⚠️ RECONCILIACIÓN 2026-07-07 (leer primero)

Al ir a mergear se descubrió que el checkout local estaba **muy desactualizado** vs
`origin/main`. El main REAL **ya tiene** un "Neto Real del mes" (`NetoRealCard` +
`useLogisticaMonthlyCosts`, tabla `logistica_monthly_costs`) que **ya resta pauta**
(`operativo − pauta − admin`), donde hoy la pauta se carga como **un número mensual**.

El diseño original (una segunda resta `Ganancia − Pauta = NETO` en el bloque Wallet REAL)
**duplicaba el descuento** de pauta. Corregido con OK del dueño ("diario alimenta el Neto
Real"):

- **La bitácora diaria (`store_ad_spend_daily`) es la FUENTE de la pauta** del Neto Real.
  `MesActualResumen` suma la pauta diaria del período (`sumAdSpend`) y la pasa a
  `NetoRealCard` (prop `pautaTotal` + `pautaFromDaily`) y al `SimuladorUnitEconomics`.
- **`NetoRealCard`**: la pauta pasa a **read-only** ("de tu Pauta diaria"); ya NO se edita
  ahí. Solo `costos_admin` sigue editable (mensual). Al guardar preserva el `pauta_meta/tiktok`
  mensual guardado sin pisarlo (fallback histórico).
- **Fallback**: si un mes no tiene registros diarios (meses viejos con solo el número
  mensual), usa el valor mensual guardado → los meses históricos no pierden su pauta.
- **NO se agrega** la segunda resta en el bloque Wallet REAL (se descartó del diseño original).

Lo demás del diseño (tabla, RLS, RPCs, hook, diálogo, panel, multi-país, degradación) queda
igual. El panel de bitácora vive en Logística → Resumen tras `MesActualResumen`.

---

## Problema / intención

El dueño quiere una **bitácora diaria** donde cada día registre cuánto gastó en pauta por
canal ("ayer gasté X en TikTok, Y en Facebook") y que ese número **se reste de su ganancia**
para ver el **NETO real** de cada tienda.

Hoy la pauta solo existe en `/cfo` como registro **mensual, global (sin tienda), solo-admin
y solo-Colombia, en pesos** (tabla `monthly_ad_spend`, tarjeta "Pauta del mes"). No sirve
para Ecuador (USD) ni para el control diario ni para que los socios de una tienda lo vean.

## Decisiones tomadas (con el dueño)

1. **Alcance:** por tienda, visible a los **encargados** (owner/supervisor) de esa tienda.
   Los operadores/asesoras NO lo ven (Logística ya es `managerOnly`).
2. **Efecto:** la pauta del período **se resta de la Ganancia Neta** en "Cómo voy" → NETO real.
3. **Granularidad:** **un monto por (tienda, día, canal)**. No por cuenta de anuncios.
   (Si en el futuro quiere por cuenta, se agrega; hoy YAGNI.)
4. **Multi-país:** montos en la **moneda de la tienda** — pesos en CO, dólares en EC.
   La corrección de moneda es a nivel de **captura del dato**: un encargado de EC teclea
   dólares, uno de CO teclea pesos. Para **mostrar** se usa el `formatCOP` universal de la
   app (símbolo `$`, agrupación es-CO, sin decimales), el MISMO que usa el resto de Logística
   y la propia Ganancia Neta — así la pauta queda visualmente alineada con el número del que
   se resta. (Nota: `formatCOP` en `src/lib/utils.ts` NO es country-aware pese a lo que dice
   CLAUDE.md; no existe `setCurrencyCountry`. No se introduce un formateador USD aparte
   porque chocaría con la Ganancia que está al lado.)

Se **descartó** reusar/retrofitear `monthly_ad_spend` (es global/admin/CO-only/pesos;
mezclar diario + `store_id` + USD lo ensuciaría y rompería la tarjeta mensual del CFO).
La tabla mensual del CFO **queda intacta**.

## Arquitectura

### 1. Datos — tabla nueva `store_ad_spend_daily`

```sql
CREATE TABLE public.store_ad_spend_daily (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  spend_date  DATE NOT NULL,
  platform    TEXT NOT NULL CHECK (platform IN ('meta','tiktok','other')),
  amount      NUMERIC NOT NULL DEFAULT 0 CHECK (amount >= 0),  -- moneda de la tienda (COP o USD)
  notas       TEXT,
  created_by  UUID DEFAULT auth.uid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, spend_date, platform)
);
CREATE INDEX store_ad_spend_daily_store_date_idx
  ON public.store_ad_spend_daily (store_id, spend_date DESC);
```

- `amount` en la moneda de la tienda (NO `amount_cop` — EC es USD). Es la diferencia clave
  con la tabla del CFO.
- `UNIQUE (store_id, spend_date, platform)` → un monto por canal por día; el upsert sobreescribe.
- Trigger `updated_at` (mismo patrón que `monthly_ad_spend`).

### 2. RLS — manager-only por tienda

Reutiliza el helper existente `public.is_store_manager(p_store_id uuid)` (owner o supervisor,
migration `20260522010000`). Cuatro políticas (SELECT/INSERT/UPDATE/DELETE) sobre
`is_store_manager(store_id)`.

### 3. RPCs (SECURITY DEFINER, chequean manager)

Espejo del patrón de `monthly_ad_spend`, incluido el gotcha `supabase.rpc.bind(supabase)`:

- `upsert_store_ad_spend_daily(p_store_id, p_spend_date, p_platform, p_amount, p_notas)`
  → chequea `is_store_manager(p_store_id)`, valida platform, upsert
  `ON CONFLICT (store_id, spend_date, platform)`. Devuelve la fila.
- `delete_store_ad_spend_daily(p_id)` → chequea que quien llama es manager de la tienda de
  esa fila; borra; devuelve boolean.

Lectura: `SELECT` directo filtrado por `store_id` + rango de fecha (RLS lo aísla). No hace
falta RPC de lectura.

### 4. Hook `src/hooks/useStoreAdSpend.ts`

- `useStoreAdSpendRange(fromDate, toDate)` — `useQuery` scopeado a `activeStoreId`, trae filas
  del rango ordenadas por fecha desc. **Degradación clave:** si la tabla/RPC no existe todavía
  (migration sin aplicar), captura el error y devuelve `[]` (pauta = 0) en vez de tirar —
  así "Cómo voy" nunca se rompe. `queryKey: ['store-ad-spend', storeId, from, to]`.
- `useUpsertStoreAdSpend()` / `useDeleteStoreAdSpend()` — mutations que invalidan la query.
- Helper puro `sumAdSpend(rows) → { meta, tiktok, other, total }` (con test unitario).

### 5. UI

**a. `src/components/logistics/StoreAdSpendPanel.tsx`** — panel "Pauta diaria".
Se renderiza en `LogisticaTab.tsx` dentro de `<TabsContent value="resumen">`, **justo después
de `<MesActualResumen .../>`** (línea ~372), recibiendo `filters`. Muestra:
- Totales del período por canal (Meta / TikTok / Otros) + total, en moneda de tienda.
- Mini-tabla de últimos días (fecha · canal · monto · nota · editar/borrar).
- Botón "+ Registrar pauta" que abre el diálogo.
- Estados: loading skeleton; error suave "aún no activo" si falta la migration; vacío con CTA.

**b. `src/components/logistics/StoreAdSpendDialog.tsx`** — formulario de carga diaria
(espejo de `CfoAdSpendDialog`): **fecha** (default = *ayer*), **canal** (Meta / TikTok / Otro),
**monto**, **nota** opcional. Upsert. Etiqueta de moneda según país de la tienda activa.

**c. Wiring del NETO en `MesActualResumen.tsx`:**
- Llama `useStoreAdSpendRange(filters.fromDate, filters.toDate)` y calcula
  `pautaTotal` + `netoDespuesPauta = gananciaNeta − pautaTotal`.
- Debajo del tile "Ganancia neta real", muestra tres líneas: `Ganancia neta real`,
  `− Pauta del período`, `= NETO después de pauta`.
- En el bloque "Wallet REAL" agrega una fila cascada `− Pauta (Meta/TikTok)` y un total
  final `NETO real (después de pauta)`.
- Si `pautaTotal === 0` → no muestra la resta; NETO = ganancia (sin ruido).

## Multi-país / privacidad (salen del diseño, sin código extra)

- Moneda por tienda a nivel de captura (EC teclea USD, CO teclea pesos). Display con el
  `formatCOP` universal (símbolo `$` compartido) para alinear visualmente con la Ganancia.
  Los montos se guardan en la moneda de la tienda; no se convierten entre monedas.
- Visibilidad: `is_store_manager` (RLS) + Logística `managerOnly` → solo dueño y supervisores
  de esa tienda. Operadores no acceden a Logística.

## Manejo de errores / degradación

- Migration sin aplicar → hook devuelve `[]`, panel muestra "aún no activo", `MesActualResumen`
  usa pauta = 0 y se ve igual que hoy. **Nada explota** (Lovable no auto-aplica migrations).
- Montos negativos bloqueados por CHECK y por el input.

## Tests

- `src/hooks/useStoreAdSpend.test.ts` — `sumAdSpend` (suma por canal + total, filas vacías,
  categorías mixtas).
- (Opcional/ligero) test del panel: render vacío + con filas.
- SQL: verificación manual vía REST tras aplicar la migration (insert/upsert/select/delete +
  que un no-manager reciba 42501).

## Definición de "listo" (regla del dueño)

1. Código en `main` (Lovable lo jala).
2. Migration aplicada en la DB (Lovable NO auto-aplica) y **verificada con evidencia**.
3. `npm run test` verde + `npx tsc --noEmit -p tsconfig.app.json` limpio.

## Fuera de alcance (por ahora)

- Pauta por cuenta de anuncios (hoy es por canal).
- Conexión con el CFO mensual (son tablas distintas a propósito).
- Conversión de moneda EC↔CO / consolidado multi-tienda.
- Import automático desde Meta/TikTok Ads API.
