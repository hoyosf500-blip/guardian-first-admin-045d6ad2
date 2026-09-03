-- ============================================================================
-- `order_status_history.dropi_history_id` deja de ser UNIQUE GLOBAL — paso 3
-- ============================================================================
--
-- ⛔ SOLO DESPUÉS de (1) aplicar 20260904130000 y (2) ver por `?ping=1` que
-- `dropi-refresh-batch` corre la versión 2026-09-04.1. Con la función vieja
-- todavía desplegada (onConflict: "dropi_history_id") y este índice caído, el
-- upsert del historial fallaría entero en cada corrida.
--
-- `DROP INDEX CONCURRENTLY` tampoco corre dentro de una transacción: este
-- archivo va solo en el editor SQL.
-- ============================================================================

SET lock_timeout = '5s';

DROP INDEX CONCURRENTLY IF EXISTS public.uq_osh_dropi_history_id;
