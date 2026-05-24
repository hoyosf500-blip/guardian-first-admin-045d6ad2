-- Apagar la AUTO-ASIGNACIÓN de pedidos a operadoras.
--
-- Contexto: el trigger BEFORE INSERT `trg_assign_order_to_operator`
-- (función `assign_order_to_operator`, migrations 20260417194021 +
-- 20260523120000) estampaba `assigned_to` en CADA pedido nuevo, repartiéndolo
-- por hash determinístico entre los `store_members` con role='operator' de la
-- tienda. Resultado: todo pedido quedaba "dueño de alguien" aunque esa persona
-- nunca lo trabajara, y la UI de Seguimiento bloqueaba a las demás operadoras
-- ("Atendido por X — no puedes ejecutar acciones").
--
-- Nuevo modelo: la propiedad surge de la GESTIÓN REAL (touchpoints: quién llamó
-- / mandó WhatsApp / etc.), no de una asignación automática. Los pedidos entran
-- SIN dueño ("Disponibles") y cualquier operadora puede gestionarlos. La UI ya
-- no lee `assigned_to` para decidir propiedad (ver CrmTable.tsx).
--
-- Se deja la FUNCIÓN como vestigio inofensivo (por si alguna lectura la
-- referencia); solo se quita el TRIGGER para que deje de escribir assigned_to.

DROP TRIGGER IF EXISTS trg_assign_order_to_operator ON public.orders;

-- Backfill: limpiar las asignaciones ya mal-estampadas en pedidos ACTIVOS
-- (no terminales). Seguro y reversible: solo borra ruteo que ya era incorrecto;
-- la UI no usa assigned_to para propiedad. Los pedidos terminales se dejan como
-- registro histórico.
UPDATE public.orders
SET assigned_to = NULL
WHERE assigned_to IS NOT NULL
  AND estado NOT IN (
    'ENTREGADO', 'CANCELADO', 'RECHAZADO',
    'DEVOLUCION', 'DEVOLUCION EN TRANSITO'
  );

-- NOTA: las RPC claim_seg_order/release_seg_order y el cron
-- `release-stale-seg-assignments` quedan vestigiales (operan sobre assigned_to,
-- que ya no se usa en Seguimiento). Se dejan en su lugar — fuera de alcance.
