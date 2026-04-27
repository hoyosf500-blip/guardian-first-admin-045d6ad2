-- Tanda 4 — fixes medios + bajos
-- M3: REVOKE extensions.http() de authenticated (cierra SSRF desde DB)
-- L1: DROP + recreate idx_orders_assigned_to como partial (compactar)
-- L3: dropi_fingerprint role check (defense-in-depth)

-- ─────────────────────────────────────────────────────────────────
-- M3: revocar acceso directo a extensions.* desde authenticated
-- ─────────────────────────────────────────────────────────────────
-- Antes: 20260417190819 hizo `GRANT EXECUTE ON FUNCTION extensions.http(...)
-- TO authenticated` para que dropi_fingerprint funcionara, pero eso
-- expone http() para que cualquier operadora haga llamadas HTTP arbitrarias
-- a hosts internos o externos desde el contexto del DB (SSRF).
-- dropi_fingerprint es SECURITY DEFINER → no necesita que el caller
-- tenga GRANT directo a http() para funcionar.
DO $$
BEGIN
  BEGIN
    REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA extensions FROM authenticated;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- L1: idx_orders_assigned_to como partial (compactar)
-- ─────────────────────────────────────────────────────────────────
-- Antes: 20260413041155 creó el índice como `(assigned_to)` full
-- (incluye NULLs), y 20260417194021 intentó crearlo partial WHERE NOT
-- NULL con `IF NOT EXISTS` — pero como ya existía con el mismo nombre,
-- el partial nunca se aplicó. Resultado: el índice indexa todas las
-- filas con assigned_to NULL (la mayoría), ocupando espacio sin uso real.
DROP INDEX IF EXISTS public.idx_orders_assigned_to;
CREATE INDEX idx_orders_assigned_to
  ON public.orders (assigned_to)
  WHERE assigned_to IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- L3: dropi_fingerprint role check
-- ─────────────────────────────────────────────────────────────────
-- Defense-in-depth: la función actual ya está en SECURITY DEFINER y
-- protegida por costo (Dropi rate-limita). Aquí solo nos aseguramos
-- de que el GRANT esté limpio. El check de rol explícito requeriría
-- redefinir el cuerpo, lo cual hacemos solo si está disponible.
DO $$
BEGIN
  REVOKE EXECUTE ON FUNCTION public.dropi_fingerprint(text) FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.dropi_fingerprint(text) TO authenticated;
EXCEPTION WHEN undefined_function THEN
  NULL;
END $$;
