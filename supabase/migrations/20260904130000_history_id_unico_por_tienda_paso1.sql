-- ============================================================================
-- `order_status_history.dropi_history_id` deja de ser UNIQUE GLOBAL — paso 1
-- ============================================================================
--
-- Auditoría del 4-sep-2026. `20260624130000` creó
--
--   CREATE UNIQUE INDEX uq_osh_dropi_history_id ON order_status_history (dropi_history_id);
--
-- bajo la premisa "cada entrada de Dropi trae un id global único". Esa premisa
-- ya se demostró falsa para `external_id` (20260820140000): Colombia, Ecuador
-- y Guatemala son PLATAFORMAS distintas (api.dropi.co / .ec / .com.gt), cada
-- una con su propia secuencia, y sus rangos se solapan. Los `history[].id` son
-- de la misma familia. Con el índice global y `ignoreDuplicates: true` en el
-- upsert, la entrada de historial de Ecuador con el mismo id que una de
-- Colombia se DESCARTA EN SILENCIO (sin error; `historyIngested` hasta la
-- cuenta como ingerida): la línea de tiempo del pedido ecuatoriano sale con
-- estados faltantes y nadie se entera.
--
-- ── El mismo orden que 20260820140000, en TRES pasos ────────────────────────
--   1. (este archivo) crear el índice nuevo por (store_id, dropi_history_id).
--   2. desplegar `dropi-refresh-batch` y `dropi-refresh-order`, que pasan a
--      `onConflict: "store_id,dropi_history_id"` (PostgREST exige que exista un
--      índice único con esas columnas: por eso el índice va ANTES del deploy).
--   3. (20260904130001) soltar el índice viejo. Recién después del deploy: con
--      la función vieja apuntando a `dropi_history_id` y el índice ya caído,
--      el upsert entero fallaría.
--
-- ⛔ REGLA #0 — `CREATE INDEX CONCURRENTLY` no bloquea lecturas ni escrituras,
-- y NO puede correr dentro de una transacción: en el editor SQL, este archivo
-- va SOLO (un statement), no junto con otros. `order_status_history` la
-- escribe el cron sin parar; el lock_timeout es la red por si igual se traba.
-- ============================================================================

SET lock_timeout = '5s';

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_osh_store_history
  ON public.order_status_history (store_id, dropi_history_id)
  WHERE dropi_history_id IS NOT NULL;
