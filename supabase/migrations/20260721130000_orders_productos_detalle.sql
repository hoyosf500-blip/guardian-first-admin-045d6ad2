-- Variantes (talla / color) visibles para la asesora.
--
-- Pedido del dueño (2026-07-21): vende zapatos en Colombia con talla y color, y
-- quiere que a las asesoras "les salga toda la información del pedido". Ecuador
-- va a tener productos con varias variantes más adelante.
--
-- ════ EL PROBLEMA, MEDIDO EN PRODUCCIÓN ════
--
-- `dropiOrderMapper` armaba el nombre así:
--     products.map(p => p.product?.name).join(", ")
-- Leía SOLO el nombre base y TIRABA la variante. Resultado real en CO:
--
--     "Nuevo modelo Sneakers 🧡🧡2801, Nuevo modelo Sneakers 🧡🧡2801"   (cant. 2)
--
-- El mismo nombre repetido: la asesora no puede saber qué tallas pidió el
-- cliente. 10 de los últimos 40 pedidos de Colombia estaban así.
--
-- ════ QUÉ GUARDA ESTA COLUMNA ════
--
-- Un array con UNA ENTRADA POR LÍNEA del pedido:
--
--     [{"nombre":"Sneakers 2801","variante":"38 / Negro","cantidad":1,"precio":89900},
--      {"nombre":"Sneakers 2801","variante":"40 / Blanco","cantidad":1,"precio":89900}]
--
-- variante/cantidad/precio los eligió el dueño explícitamente (se le ofreció
-- también SKU y foto; los descartó por no aportar en la llamada).
--
-- ════ POR QUÉ LAS VARIANTES NO VAN EN `producto` ════
--
-- `orders.producto` lo AGRUPAN logistics_by_product y product_profitability. Si
-- se le metiera la talla, cada talla sería un "producto" distinto y los
-- reportes quedarían pulverizados.
--
-- Al mismo tiempo se corrige un bug de reportes que YA existía: como el nombre
-- se repetía por línea, "Sneakers, Sneakers" era un producto DISTINTO de
-- "Sneakers" — el mismo zapato partido en dos grupos. Ahora `producto` guarda
-- los nombres base SIN REPETIR, así que esos grupos se unifican solos.
--
-- ════ ORDEN DE APLICACIÓN — IMPORTA ════
--
-- Esta migración va ANTES de redesplegar las edge functions. Postgres no ignora
-- una columna inexistente en un upsert: devuelve error y se cae TODO el sync de
-- pedidos. SQL primero, funciones después.
--
-- Los pedidos VIEJOS quedan con la columna en NULL — el dato de variante no
-- está guardado en ningún lado y no se va a inventar. Se llena solo a medida
-- que el sync los vuelve a tocar (y con el botón "Refrescar desde Dropi" para
-- uno puntual). La ficha cae al nombre de producto de siempre cuando es NULL.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS productos_detalle jsonb;

COMMENT ON COLUMN public.orders.productos_detalle IS
  'Detalle por línea del pedido: [{nombre, variante, cantidad, precio}]. La variante sale de attribute_values de Dropi (ej. "38 / Negro"). NULL en pedidos anteriores al 2026-07-21. Las variantes NO van en orders.producto para no fragmentar los reportes que agrupan por producto.';
