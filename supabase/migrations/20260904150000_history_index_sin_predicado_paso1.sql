-- ============================================================================
-- El índice por tienda del historial NO puede ser parcial (paso 1 de 2)
-- ============================================================================
--
-- Qué pasó (3-sep-2026, verificado en producción): `20260904130000` creó
-- `uq_osh_store_history (store_id, dropi_history_id) WHERE dropi_history_id
-- IS NOT NULL`, y `dropi-refresh-batch` / `dropi-refresh-order` upsertean con
-- `onConflict: "store_id,dropi_history_id"`. PostgREST lo traduce a
-- `ON CONFLICT (store_id, dropi_history_id) DO NOTHING` SIN predicado, y
-- Postgres solo infiere un índice parcial como árbitro si el ON CONFLICT trae
-- un WHERE que implique el del índice → 42P10 "no unique or exclusion
-- constraint matching the ON CONFLICT specification". El upsert está dentro
-- de un try/catch con warn: desde el deploy (≈22:30Z) el historial de estados
-- dejó de entrar y nada avisó (última fila con dropi_history_id: 20:56Z).
-- La migración de junio (`20260624130000`) ya lo había dejado escrito:
-- "Índice único NO parcial … permite usar onConflict sin predicado WHERE".
--
-- Los NULL no chocan entre sí en un UNIQUE de Postgres (NULLS DISTINCT, el
-- default), así que las filas del trigger (dropi_history_id NULL) conviven
-- igual que con el índice viejo.
--
-- ⛔ Correr SOLO, fuera de transacción (CONCURRENTLY). Paso 2: cuando este
-- índice exista, `20260904150001` suelta el parcial.
-- ============================================================================

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_osh_store_history_full
  ON public.order_status_history (store_id, dropi_history_id);
