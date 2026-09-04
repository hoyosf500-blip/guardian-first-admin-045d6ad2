-- ============================================================================
-- La bandeja deja de esconder gente: `bandeja_esperando` / `bandeja_sin_respuesta`
-- ============================================================================
--
-- Medido en producción el 4-sep-2026 sobre Ecuador, dos veces y con métodos
-- distintos (paginando por fecha de mensaje y barriendo la tabla por `id`):
--
--   pedidos con mensaje entrante ............ 2.488
--   esperando respuesta, en total ...........   273
--   los que la pantalla mostraba ............    83
--   INVISIBLES ..............................   190   ← de esos, 172 hace +7 días
--   el más viejo ............................    31 días
--
-- La causa es una sola línea del hook: `useInboxEsperando` pedía las 500
-- conversaciones con entrada MÁS RECIENTE (`order chat_entrante_at desc limit
-- 500`) y después ordenaba la lista "quien lleva más esperando, primero". Son
-- dos cosas opuestas — el tope se queda con lo nuevo y la pantalla existe para
-- lo viejo. El corte caía en ~1 día de antigüedad.
--
-- Y esto ya estaba PROHIBIDO por escrito: `src/test/controlDelTurno.test.ts`
-- cita la regla del dueño, textual — *"que los pedidos no se escondan, eso está
-- prohibido; siempre que se muestre el total que hay que trabajar"*. La prueba
-- vigilaba que el BUSCADOR no escondiera; el tope escondía 190 personas.
--
-- No alcanza con subir el tope: con 2.488 conversaciones el problema vuelve en
-- unos meses. El filtro correcto —"el último mensaje del chat es del cliente"—
-- compara DOS COLUMNAS entre sí, y eso PostgREST no lo sabe expresar. De ahí
-- estas dos funciones.
--
-- ⛔ REGLA #0 — cero DDL sobre `orders`. Son funciones nuevas, no tocan la
--    tabla. Y no hacen falta índices: medido contra producción, la consulta
--    equivalente sobre las 2.488 filas responde en 152 ms.
-- ⛔ REGLA #1 — no se reescribe ninguna función desplegada.
-- ⛔ La tienda va POR PARÁMETRO, no por `_resolve_scope_store()`: así no hereda
--    el problema de esperar el scope que sí tiene `novedades_root_cause`.
-- ============================================================================

SET lock_timeout = '5s';

-- Los que ESCRIBIERON y nadie contestó: el último mensaje del chat es suyo.
-- Ordenados por quien lleva más esperando (ASC), que es lo que la pantalla
-- promete. `total_general` viaja en cada fila (window function) para que la
-- bandeja pueda decir "mostrando 200 de 273" en vez de callar el recorte.
CREATE OR REPLACE FUNCTION public.bandeja_esperando(
  p_store_id uuid,
  p_limite   integer DEFAULT 400
)
RETURNS TABLE (
  id                uuid,
  external_id       text,
  nombre            text,
  phone             text,
  estado            text,
  ciudad            text,
  direccion         text,
  producto          text,
  valor             numeric,
  guia              text,
  transportadora    text,
  last_movement_at  timestamptz,
  chat_entrante_at  timestamptz,
  chat_saliente_at  timestamptz,
  chat_leido_at     timestamptz,
  locked_by         uuid,
  locked_at         timestamptz,
  total_general     bigint,
  total_con_chat    bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH esperando AS (
    SELECT o.*
    FROM public.orders o
    WHERE o.store_id = p_store_id
      AND o.chat_entrante_at IS NOT NULL
      -- El cliente habló último. `coalesce` con -infinity cubre al que escribió
      -- y nunca recibió respuesta: también está esperando.
      AND o.chat_entrante_at > coalesce(o.chat_saliente_at, '-infinity'::timestamptz)
      -- Un entregado o un cancelado no es una mano levantada.
      --
      -- ⛔ REEMPLAZADA es la trampa cara, y la lista de acá era la ÚNICA del
      -- proyecto que se la había perdido (medido en producción el 4-sep-2026).
      -- Al editar un pedido, Dropi lo RECREA y deja el viejo en REEMPLAZADA
      -- (soft-delete), pero el sync copia los sellos de chat a las DOS filas.
      -- La vieja no la trabaja nadie, así que queda "esperando" para siempre:
      -- 193 de 281 en la cola de Ecuador y 385 de 776 en la de deuda. Y como
      -- son las más viejas, se sientan ARRIBA DE TODO — justo donde la pantalla
      -- pone lo más urgente. En las 12 que revisé una por una, el gemelo vivo
      -- del mismo teléfono ya estaba ENTREGADO: no había nada que contestar.
      -- El resto del código ya la trata como muerta (segLists.ts:135,
      -- estadoBuckets.ts:131, useDataLoader.ts:237, DashboardTab.tsx:382).
      --
      -- DEVOLUCION se queda ADENTRO a propósito: un paquete que vuelve sigue
      -- siendo una conversación abierta (el cliente pide reenvío o reclama), y
      -- hoy la pantalla ya los muestra. Sacarlos sería una decisión de negocio,
      -- no un arreglo de este bug.
      AND upper(btrim(coalesce(o.estado, ''))) NOT IN
          ('ENTREGADO', 'ENTREGADO A DESTINO', 'CANCELADO', 'REEMPLAZADA',
           'INDEMNIZADA', 'ARCHIVADO GHOST', 'ARCHIVADO_GHOST')
      -- Las variantes que Dropi inventa por transportadora ('CANCELADO POR
      -- TRANSPORTADORA'). Hoy no hay ninguna en la cola: va como defensa, es el
      -- mismo espejo que ya hace TERMINALES_PATTERNS en segLists.ts.
      AND upper(btrim(coalesce(o.estado, ''))) NOT LIKE '%CANCEL%'
      -- Membresía: la RLS de `orders` ya scopea, pero un `p_store_id` ajeno
      -- devolvería vacío en silencio y eso se lee como "no hay nadie".
      AND EXISTS (
        SELECT 1 FROM public.store_members sm
        WHERE sm.store_id = p_store_id AND sm.user_id = auth.uid()
      )
  )
  SELECT
    e.id, e.external_id, e.nombre, e.phone, e.estado, e.ciudad, e.direccion,
    e.producto, e.valor, e.guia, e.transportadora, e.last_movement_at,
    e.chat_entrante_at, e.chat_saliente_at, e.chat_leido_at,
    e.locked_by, e.locked_at,
    count(*) OVER () AS total_general,
    -- ⛔ "Cero esperando" y "esta tienda no tiene dato de chat" son cosas
    -- DISTINTAS y se veían iguales. La primera merece el cartel de "todos
    -- atendidos"; la segunda es el incidente de Colombia —39 clientes esperando
    -- en Chatea Pro mientras la pantalla celebraba— y tiene que decir que no se
    -- pudo medir. Este conteo es lo único que las separa.
    (SELECT count(*) FROM public.orders c
      WHERE c.store_id = p_store_id AND c.chat_entrante_at IS NOT NULL) AS total_con_chat
  FROM esperando e
  ORDER BY e.chat_entrante_at ASC
  LIMIT greatest(1, least(coalesce(p_limite, 400), 2000));
$$;

-- Les escribimos y no contestaron: falta el 2º intento. Misma forma, otro
-- reloj (`chat_saliente_at`) y su propia ventana.
CREATE OR REPLACE FUNCTION public.bandeja_sin_respuesta(
  p_store_id uuid,
  p_limite   integer DEFAULT 400,
  p_horas    integer DEFAULT 6,
  p_dias     integer DEFAULT 7
)
RETURNS TABLE (
  id                uuid,
  external_id       text,
  nombre            text,
  phone             text,
  estado            text,
  ciudad            text,
  direccion         text,
  producto          text,
  valor             numeric,
  guia              text,
  transportadora    text,
  last_movement_at  timestamptz,
  chat_entrante_at  timestamptz,
  chat_saliente_at  timestamptz,
  chat_leido_at     timestamptz,
  locked_by         uuid,
  locked_at         timestamptz,
  total_general     bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH deuda AS (
    SELECT o.*
    FROM public.orders o
    WHERE o.store_id = p_store_id
      AND o.chat_saliente_at IS NOT NULL
      -- La última palabra es NUESTRA (o el cliente nunca escribió).
      AND coalesce(o.chat_entrante_at, '-infinity'::timestamptz) <= o.chat_saliente_at
      -- Ya pasó el umbral: un mensaje de hace diez minutos no es un descuido.
      AND o.chat_saliente_at <= now() - make_interval(hours => greatest(0, coalesce(p_horas, 6)))
      -- Y no es historia: más de una semana ya no es "falta el 2º intento".
      AND o.chat_saliente_at >= now() - make_interval(days => greatest(1, coalesce(p_dias, 7)))
      -- Misma lista que arriba, y por el mismo motivo: acá los REEMPLAZADA eran
      -- 385 de 776. Si las dos listas se separan, la deuda vuelve a inflarse.
      AND upper(btrim(coalesce(o.estado, ''))) NOT IN
          ('ENTREGADO', 'ENTREGADO A DESTINO', 'CANCELADO', 'REEMPLAZADA',
           'INDEMNIZADA', 'ARCHIVADO GHOST', 'ARCHIVADO_GHOST')
      AND upper(btrim(coalesce(o.estado, ''))) NOT LIKE '%CANCEL%'
      AND EXISTS (
        SELECT 1 FROM public.store_members sm
        WHERE sm.store_id = p_store_id AND sm.user_id = auth.uid()
      )
  )
  SELECT
    d.id, d.external_id, d.nombre, d.phone, d.estado, d.ciudad, d.direccion,
    d.producto, d.valor, d.guia, d.transportadora, d.last_movement_at,
    d.chat_entrante_at, d.chat_saliente_at, d.chat_leido_at,
    d.locked_by, d.locked_at,
    count(*) OVER () AS total_general
  FROM deuda d
  ORDER BY d.chat_saliente_at ASC
  LIMIT greatest(1, least(coalesce(p_limite, 400), 2000));
$$;

GRANT EXECUTE ON FUNCTION public.bandeja_esperando(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bandeja_sin_respuesta(uuid, integer, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.bandeja_esperando(uuid, integer) IS
  'Clientes que escribieron y nadie les contestó, del más viejo al más nuevo. total_general = la cola completa, sin recortar: la bandeja lo muestra para no volver a esconder gente detrás de un tope.';
COMMENT ON FUNCTION public.bandeja_sin_respuesta(uuid, integer, integer, integer) IS
  'Clientes a los que les escribimos y no contestaron (falta el 2º intento), del más viejo al más nuevo, con el total sin recortar.';
