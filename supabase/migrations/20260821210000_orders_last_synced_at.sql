-- `orders.last_synced_at` — cuándo Guardian miró este pedido por última vez.
--
-- ADITIVA Y MÍNIMA: una columna y un índice. **No toca ninguna función**
-- (⛔ REGLA #1). El estampado lo hace `_shared/marcarLeidos.ts` desde
-- `dropi-cron`, en TypeScript, con un UPDATE aparte.
--
-- ── Qué contesta que hoy no se puede contestar ──────────────────────────────
-- Hasta ahora NO existía ninguna forma de saber cuándo se leyó un pedido.
-- `last_movement_at` contesta otra cosa —cuándo se movió en Dropi— y la
-- tarjeta la usaba como si fuera frescura del dato: un pedido cuya información
-- tiene tres días de atraso se pintaba VERDE si en Dropi se movió hace dos
-- horas.
--
-- Y hay pedidos que ninguna de las tres ventanas de refresco alcanza: el cron
-- mira 3 días por creación y 21 por cambio de estado (28 en Ecuador), el botón
-- 10 días, y la reconciliación nocturna barre un mes por noche. Un pedido con
-- `fecha` nula o mal formada se cae de las tres y no lo vuelve a mirar nadie,
-- nunca. Sin esta columna eso es invisible por definición: no se puede buscar
-- lo que no se registra.
--
-- ── Por qué NO se rellena el histórico ──────────────────────────────────────
-- Se deja en NULL a propósito. Poner `now()` en las 13.000 filas diría "todos
-- se acaban de leer", que es exactamente la mentira que esta columna viene a
-- evitar. NULL significa "nunca lo vi leerse", que es la verdad hasta que el
-- cron pase — y los que sigan en NULL dentro de una semana son, justamente, la
-- lista que estamos buscando.
--
-- ── Costo de escritura ──────────────────────────────────────────────────────
-- `marcarLeidos` re-estampa cada pedido como mucho cada 6 horas
-- (HORAS_ENTRE_MARCAS), no en cada corrida. El cron pasa cada ~20 min por
-- tienda: sin ese umbral serían miles de UPDATE por hora —con su realtime a
-- cada navegador abierto— para responder una pregunta que se mide en días.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

COMMENT ON COLUMN public.orders.last_synced_at IS
  'Última vez que Guardian consultó este pedido en Dropi (haya cambiado o no). '
  'NO es last_movement_at, que es cuándo se movió el pedido. NULL = todavía no '
  'se lo vio leerse: son los pedidos que ninguna ventana de refresco alcanza.';

-- Para "los que nadie miró hace más de N días", que siempre es por tienda.
-- NULLS FIRST porque el NULL es justamente el caso que se busca.
CREATE INDEX IF NOT EXISTS orders_store_last_synced_idx
  ON public.orders (store_id, last_synced_at NULLS FIRST);
