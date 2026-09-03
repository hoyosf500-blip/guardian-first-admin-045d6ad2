-- ============================================================================
-- BITÁCORA DE ACCIONES SOBRE UN PEDIDO
--
-- Qué problema resuelve (pedido del dueño, 3-sep-2026):
--   «Ayer en Novedades la operadora me dijo que lo había tocado, pero no sé si
--    me miente. Cada acción que el asesor haga en un pedido necesito saberlo.»
--
-- Hoy `touchpoints` ya guarda las GESTIONES (quién, cuándo, qué), y eso alcanza
-- para responder "¿lo tocó?". Lo que NO se puede responder es lo otro:
--
--   1. Lo que NO se hizo. Abrir una novedad, mirarla y pasar a la siguiente con
--      la flecha no deja rastro. En Novedades es lo más común: se recorren
--      veinte y se gestionan tres. Hoy «no la vio» y «la vio y la saltó» se ven
--      exactamente igual, y son dos conversaciones distintas con la asesora.
--   2. El tiempo. Ni cuánto estuvo en el pedido, ni cuánto tardó desde que lo
--      abrió hasta que lo marcó. Dos segundos y cuatro minutos cuentan igual.
--   3. CUÁL pedido. `touchpoints` se guarda por TELÉFONO. Un cliente con dos
--      pedidos mezcla las gestiones de los dos, así que no se puede afirmar
--      "esta gestión fue sobre ESTE pedido".
--
-- Esta tabla es para eso. NO reemplaza a `touchpoints`: aquella es la gestión
-- que cuenta para la productividad y los contadores del día; esta es la
-- bitácora de lo que pasó en pantalla, incluido lo que no terminó en gestión.
-- Cada gestión escribe en las dos, y acá va CON el número de pedido — que es lo
-- que le faltaba al hueco 3.
--
-- ⛔ NO es DDL sobre una tabla caliente. `orders`, `order_results` y
-- `touchpoints` no se tocan: esto es un CREATE TABLE nuevo, que no toma ningún
-- lock que le importe a nadie (REGLA #0). El `lock_timeout` va igual, por si
-- esta migración se aplica junto con otras en la misma sesión.
-- ============================================================================

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.order_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  operator_id  uuid NOT NULL REFERENCES auth.users(id),

  -- El pedido. `external_id` y no el uuid de la fila porque es lo que la
  -- pantalla tiene en la mano y lo que el dueño reconoce ("el 6637528").
  -- ⚠️ Desde `20260820140000_external_id_unico_por_tienda.sql` el número de
  -- pedido es único POR TIENDA, así que SIEMPRE se lee junto con `store_id`.
  -- Nullable: hay eventos de pantalla que no son sobre un pedido concreto.
  external_id  text,
  -- Se guarda además el teléfono para poder cruzar con `touchpoints`, que se
  -- guarda por teléfono y no por pedido.
  phone        text,

  -- Qué pasó. Vocabulario cerrado a propósito: un texto libre acá se convierte
  -- en veinte formas de escribir lo mismo y ninguna consulta vuelve a servir.
  -- Ver `src/lib/eventosPedido.ts`, que es la ÚNICA fuente de estos nombres.
  evento       text NOT NULL,

  -- El detalle que cambia según el evento: qué botón, qué valor quedó, si Dropi
  -- lo aceptó. Va en jsonb para que agregar un evento nuevo no necesite otra
  -- migración sobre una tabla que para entonces ya va a tener millones de filas.
  detalle      jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Cuánto estuvo el pedido en pantalla, en milisegundos. Solo lo trae el
  -- evento de cierre. ⛔ NULL significa "no se pudo medir" (se cerró la pestaña
  -- de golpe), NO "cero". Un cero afirmado sobre algo que no se midió es
  -- exactamente el error que este proyecto ya pagó varias veces.
  ms_en_pantalla integer,

  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Índices ────────────────────────────────────────────────────────────────
-- Las tres preguntas que esta tabla existe para contestar:
--   «¿qué hizo Fulana ayer?»            → (store, operador, fecha)
--   «¿quién tocó ESTE pedido?»          → (store, pedido, fecha)
--   «¿qué pasó en la tienda hoy?»       → (store, fecha)
-- Van CONCURRENTLY-libres porque la tabla nace vacía: no hay nada que bloquear.
CREATE INDEX IF NOT EXISTS order_events_tienda_fecha_idx
  ON public.order_events (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS order_events_operador_idx
  ON public.order_events (store_id, operator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS order_events_pedido_idx
  ON public.order_events (store_id, external_id, created_at DESC)
  WHERE external_id IS NOT NULL;

-- ── Permisos ───────────────────────────────────────────────────────────────
ALTER TABLE public.order_events ENABLE ROW LEVEL SECURITY;

-- Decisión del dueño (3-sep-2026): **la asesora ve el suyo, el dueño ve el de
-- todas.** Que ella pueda mirar su propio registro es lo que convierte esto en
-- una prueba en vez de una acusación: ante un desacuerdo, señala su bitácora.
CREATE POLICY order_events_select_scope ON public.order_events
  FOR SELECT TO authenticated
  USING (
    operator_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')
    OR public.is_store_manager(store_id)
  );

-- Solo se puede escribir en nombre propio y dentro de una tienda de la que se
-- es miembro. Sin el `operator_id = auth.uid()`, cualquiera podría fabricarle
-- actividad a otra persona — y entonces la bitácora no probaría nada.
CREATE POLICY order_events_insert_propia ON public.order_events
  FOR INSERT TO authenticated
  WITH CHECK (operator_id = auth.uid() AND public.is_store_member(store_id));

-- ⛔ Sin UPDATE y sin DELETE, a propósito y para todos los roles. Una bitácora
-- que se puede editar o borrar no sirve para lo que se creó. Si alguna vez hay
-- que purgar filas viejas, se hace con una función `SECURITY DEFINER` que deje
-- su propio rastro, no aflojando esta política.

COMMENT ON TABLE public.order_events IS
  'Bitácora de lo que la asesora hace en pantalla sobre un pedido: lo abrió, cuánto estuvo, lo saltó sin gestionar, qué marcó. Complementa touchpoints (que guarda la GESTIÓN, por teléfono); acá va CON el número de pedido. Solo INSERT: no se edita ni se borra. Vocabulario de `evento` en src/lib/eventosPedido.ts.';

COMMENT ON COLUMN public.order_events.ms_en_pantalla IS
  'Milisegundos que el pedido estuvo abierto. NULL = no se pudo medir (se cerró la pestaña de golpe), nunca cero.';
