-- La señal de confirmación de ImporChat, aterrizada en Guardian.
--
-- ADITIVA: crea una tabla nueva y agrega columnas NULLABLE a `orders`.
-- **No toca ninguna función viva** (⛔ REGLA #1). `upsert_orders_from_dropi` no
-- conoce estas columnas y por lo tanto no las pisa: las escribe únicamente la
-- edge function `importchat-sync`, con un UPDATE dirigido.
--
-- ── Por qué ────────────────────────────────────────────────────────────────
-- Agosto-2026 EC, 765 pedidos resueltos, 213 cancelados (27,8%). De los 636 que
-- recibieron la plantilla de confirmación por WhatsApp:
--
--   apretó "CONFIRMAR PEDIDO" ...... 402 → 10,4% cancela
--   NO lo apretó ................... 220 → 57,7% cancela   ($3.928)
--
-- z = −12,63, aguanta en los 4 productos por separado, y la mediana entre que
-- sale la plantilla y que aprietan es de 0,0 h: se sabe en el primer minuto.
--
-- Mientras tanto la antigüedad del pedido —que es como se ordena la cola hoy—
-- no distingue nada dentro del primer día: <2 h 19,3%, 2-6 h 18,4%, 6-24 h
-- 20,1%. Esta migración existe para poder ordenar por lo que sí predice.

-- ── 1. Credenciales de ImporChat por tienda ────────────────────────────────
-- Mismo molde que `store_dropi_config`: el token es secreto y lo lee la edge
-- function con service role. El cliente NUNCA lo selecciona.
CREATE TABLE IF NOT EXISTS public.store_importchat_config (
  store_id          uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  id_configuracion  integer     NOT NULL,
  api_base          text        NOT NULL DEFAULT 'https://chat.imporfactory.app/api/v1/',
  session_token     text,
  -- El JWT de ImporChat dura 7 días exactos (medido 2026-08-22: iat→exp = 7,0).
  -- Se guarda el vencimiento para que el badge de salud pueda avisar ANTES de
  -- que se caiga, en vez de que la señal se apague en silencio.
  token_expira_at   timestamptz,
  habilitado        boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.store_importchat_config ENABLE ROW LEVEL SECURITY;

-- Sin políticas de SELECT/INSERT/UPDATE: nadie llega por PostgREST. La edge
-- function usa service role (que salta RLS) y la configuración se carga por
-- SQL. Es deliberado — un token de sesión no tiene por qué viajar al browser.
REVOKE ALL ON TABLE public.store_importchat_config FROM anon, authenticated;

-- ── 2. La señal, sobre el pedido ───────────────────────────────────────────
-- Todas NULLABLE y sin DEFAULT a propósito. En esta operación un cero jamás
-- puede hacerse pasar por una medición: un pedido cuya conversación todavía no
-- se leyó NO es un pedido tranquilo, y si estas columnas nacieran en `false`
-- se leería exactamente así.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS confirmo_boton_at        timestamptz,
  ADD COLUMN IF NOT EXISTS chat_cliente_escribio_at timestamptz,
  ADD COLUMN IF NOT EXISTS chat_mudo                boolean,
  ADD COLUMN IF NOT EXISTS chat_riesgo              text,
  ADD COLUMN IF NOT EXISTS chat_leido_at            timestamptz,
  -- La hora REAL en que el cliente hizo el pedido, en UTC.
  -- Guardian no la tenía en ninguna columna: `created_at` es la hora en que el
  -- cron INSERTÓ la fila (mediana +5,15 h por la zona horaria, pero p75 +9,35 h
  -- y cola hasta +120 h) y `fecha` es solo fecha. Por eso el análisis de
  -- franjas horarias venía saliendo corrido. Ver CLAUDE.md.
  ADD COLUMN IF NOT EXISTS pedido_creado_at         timestamptz;

-- `chat_riesgo` es un vocabulario cerrado y espeja `NivelRiesgo` de
-- `_shared/senalConfirmacion.ts`. Si alguien agrega un nivel allá y no acá, el
-- UPDATE falla ruidosamente en vez de guardar basura.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_chat_riesgo_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_chat_riesgo_check
      CHECK (chat_riesgo IS NULL
             OR chat_riesgo IN ('sin_dato','confirmado','tibio','frio','mudo'));
  END IF;
END $$;

-- Índice para la cola: los que hay que llamar primero son los que NO apretaron.
-- Parcial sobre los pendientes, que es la única población que se trabaja.
CREATE INDEX IF NOT EXISTS orders_chat_riesgo_pendientes_idx
  ON public.orders (store_id, chat_riesgo)
  WHERE estado = 'PENDIENTE CONFIRMACION';

COMMENT ON COLUMN public.orders.confirmo_boton_at IS
  'Cuándo el cliente apretó "CONFIRMAR PEDIDO" en el WhatsApp de ImporChat. NULL = no lo apretó O todavía no se leyó la conversación; distinguilos con chat_leido_at.';
COMMENT ON COLUMN public.orders.chat_leido_at IS
  'Cuándo importchat-sync leyó esta conversación. NULL = nunca se leyó: las demás columnas de chat no significan nada todavía.';
COMMENT ON COLUMN public.orders.pedido_creado_at IS
  'Hora REAL en que el cliente hizo el pedido (UTC). NO confundir con created_at, que es la hora en que el cron trajo la fila.';
