-- Tope de reintentos para los avisos proactivos (wa-status-notifier).
--
-- El notifier no consume la transición si el envío falla — correcto para no
-- perder avisos — pero sin contador de intentos una transición que falla siempre
-- (gateway QR desconectado) se reintenta en CADA corrida (~78 veces al día): filas
-- 'failed' inundando el hilo, conversaciones reordenándose solas y, si el fallo es
-- un falso negativo (timeout con el mensaje SÍ entregado), el mismo aviso repetido
-- decenas de veces al cliente = spam y riesgo de baneo del número.

ALTER TABLE public.wa_order_notifications
  ADD COLUMN IF NOT EXISTS attempts        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
