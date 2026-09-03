-- Paso 2 de `20260904150000`: con el índice completo ya creado, el parcial
-- sobra (y nadie puede usarlo desde PostgREST). Correr SOLO, fuera de
-- transacción. Verificar después:
--
--   SELECT indexname, indexdef FROM pg_indexes
--   WHERE tablename = 'order_status_history' AND indexname LIKE 'uq_osh%';
--
-- Tiene que quedar solo `uq_osh_store_history_full`, sin WHERE.

DROP INDEX CONCURRENTLY IF EXISTS public.uq_osh_store_history;
