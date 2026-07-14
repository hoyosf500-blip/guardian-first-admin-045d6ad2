-- release_all_my_locks: libera TODOS los locks de pedidos del usuario actual.
--
-- BUG (auditoría 2026-07-14): al hacer LOGOUT (signOut) los locks del usuario
-- NO se liberaban → quedaban huérfanos (locked_by = ese user) hasta que el cron
-- `release-stale-locks` los limpiara a los 15 min. Durante esa ventana el filtro
-- `isLockedByOther` (LOCK_TTL_MS = 15 min) ESCONDE esos pedidos de TODA la cola
-- del equipo → un cliente invisible para todas las asesoras ~15 min por cada
-- lock huérfano. El release por-pedido (release_order) y el beforeunload solo
-- cubren el pedido actual y el cierre de pestaña (poco fiable, fetch async).
--
-- Fix: el cliente llama esta RPC en signOut ANTES de auth.signOut() (con la
-- sesión aún válida). Libera SOLO los locks propios (WHERE locked_by=auth.uid()),
-- cross-store (si cierra sesión, suelta todo). El cron de 15 min queda como
-- backstop para el cierre abrupto de pestaña.

CREATE OR REPLACE FUNCTION public.release_all_my_locks()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN 0;
  END IF;
  UPDATE public.orders
    SET locked_by = NULL, locked_at = NULL
    WHERE locked_by = auth.uid();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.release_all_my_locks() TO authenticated;
