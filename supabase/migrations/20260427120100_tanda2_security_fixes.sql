-- Tanda 2 — fixes de seguridad altos
-- H1: RLS orders SELECT restringido a admin/operator (no más USING(true))
-- H2: RLS orders UPDATE sin rama "IS NULL" que permitía modificar pedidos del pool
-- H4: get_daily_operator_stats accesible solo a admin (Fix 28)

-- ─────────────────────────────────────────────────────────────────
-- H1: orders SELECT — role check explícito
-- ─────────────────────────────────────────────────────────────────
-- Antes: USING(true) — cualquier usuario autenticado (incluso uno sin
-- rol asignado) podía leer la tabla `orders` completa, exponiendo PII
-- de clientes (nombre, teléfono, dirección, valor) en caso de token
-- comprometido o cuenta de prueba olvidada.
--
-- Ahora: solo admin u operator. has_role() es SECURITY DEFINER y
-- evita el RLS recursivo sobre user_roles.
DROP POLICY IF EXISTS "Users can view orders" ON public.orders;
CREATE POLICY "Users can view orders" ON public.orders
  FOR SELECT TO authenticated
  USING (
    (SELECT public.has_role(auth.uid(), 'admin'))
    OR (SELECT public.has_role(auth.uid(), 'operator'))
  );

-- ─────────────────────────────────────────────────────────────────
-- H2: orders UPDATE — quitar rama IS NULL/IS NULL
-- ─────────────────────────────────────────────────────────────────
-- Antes: la condición `assigned_to IS NULL AND locked_by IS NULL`
-- permitía que cualquier operadora modificara pedidos del pool
-- compartido directamente vía REST/SDK, salteándose `claim_order` y
-- `claim_seg_order`. Una operadora podía marcar como CANCELADO un
-- pedido antes de que otra lo tomara.
--
-- Ahora: el claim debe pasar por las RPCs (SECURITY DEFINER que
-- ponen `assigned_to = auth.uid()` o `locked_by = auth.uid()`
-- atómicamente). Después de ese claim el operador puede modificarlo.
DROP POLICY IF EXISTS "Users can update orders" ON public.orders;
CREATE POLICY "Users can update orders" ON public.orders
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.has_role(auth.uid(), 'admin'))
    OR uploaded_by = auth.uid()
    OR assigned_to = auth.uid()
    OR locked_by = auth.uid()
  );

-- ─────────────────────────────────────────────────────────────────
-- H4: get_daily_operator_stats — restringir a admin (Fix 28)
-- ─────────────────────────────────────────────────────────────────
-- Antes: GRANT EXECUTE TO authenticated permitía que cualquier
-- operadora viera las stats diarias (conf/canc/noresp) de todas sus
-- compañeras — es información de productividad sensible.
--
-- Ahora: la función chequea has_role(auth.uid(),'admin') al inicio.
-- Mantenemos GRANT a authenticated (no a admin solo) para que la
-- RPC pueda ser llamada y devolver un mensaje de "no autorizado"
-- explícito en vez de un error 404 desde el cliente.
CREATE OR REPLACE FUNCTION public.get_daily_operator_stats(p_date DATE)
RETURNS TABLE (
  operator_id UUID,
  display_name TEXT,
  conf        BIGINT,
  canc        BIGINT,
  noresp      BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores pueden consultar stats diarias por operador'
      USING ERRCODE = '42501'; -- insufficient_privilege
  END IF;

  RETURN QUERY
  SELECT
    r.operator_id,
    COALESCE(p.display_name, 'Operador') AS display_name,
    COUNT(*) FILTER (WHERE r.result = 'conf')   AS conf,
    COUNT(*) FILTER (WHERE r.result = 'canc')   AS canc,
    COUNT(*) FILTER (WHERE r.result = 'noresp') AS noresp
  FROM public.order_results r
  LEFT JOIN public.profiles p ON p.user_id = r.operator_id
  WHERE r.result_date = p_date
  GROUP BY r.operator_id, p.display_name;
END;
$$;
