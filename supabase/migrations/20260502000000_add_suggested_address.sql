-- Validador de direcciones v2: sugerencia de dirección probable.
-- Cuando Google Places devuelve formattedAddress o Haiku sugiere
-- una corrección, la guardamos aquí para mostrarla en el badge como
-- "¿Quisiste decir: <suggested_address>?" con botón Aplicar.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS suggested_address TEXT NULL;
COMMENT ON COLUMN orders.suggested_address IS
  'Dirección sugerida por Google Places o Haiku cuando la original quedó red/yellow. La operadora puede aplicarla con un click.';
