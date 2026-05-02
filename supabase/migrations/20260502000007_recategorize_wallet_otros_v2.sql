-- Re-categoriza movimientos viejos en categoria='otro' con patrones nuevos
-- descubiertos en auditoría 2026-05-02 (transferencias, mantenimiento, indemnización).
--
-- Idempotente: solo afecta filas con categoria='otro' que matcheen los patrones.

-- Retiros (transferencia saliente — asumimos cuenta propia)
UPDATE public.dropi_wallet_movements
SET categoria = 'retiro'
WHERE categoria = 'otro'
  AND UPPER(codigo) LIKE '%TRANSFERENCIA%'
  AND UPPER(codigo) LIKE '%AL USUARIO%';

-- Depósitos (transferencia entrante)
UPDATE public.dropi_wallet_movements
SET categoria = 'deposito'
WHERE categoria = 'otro'
  AND UPPER(codigo) LIKE '%TRANSFERENCIA%'
  AND UPPER(codigo) LIKE '%DESDE EL USUARIO%';

-- Mantenimiento mensual de tarjeta virtual
UPDATE public.dropi_wallet_movements
SET categoria = 'mantenimiento_tarjeta'
WHERE categoria = 'otro'
  AND UPPER(codigo) LIKE '%MANTENIMIENTO%'
  AND UPPER(codigo) LIKE '%TARJETA%';

-- Indemnizaciones de Dropi (proveedor no despacha en X horas, etc)
UPDATE public.dropi_wallet_movements
SET categoria = 'indemnizacion'
WHERE categoria = 'otro'
  AND UPPER(codigo) LIKE '%INDEMNIZACION%';
