-- ============================================================================
-- La novedad resuelta ya no vuelve a aparecer al día siguiente
-- ============================================================================
--
-- ── El reporte (3-sep-2026) ─────────────────────────────────────────────────
-- El dueño a su supervisor: *"¿es un bug de mi CRM ya que sigue aquí, o lo
-- resolviste ayer y la novedad volvió a aparecer?"*. Roberto: *"Sí me parece
-- que es bug. Algunos se quitan de la columna y pocos no."*
--
-- ── La causa, leída de la función DESPLEGADA ────────────────────────────────
-- `protect_resolved_novedades_bogota` repone el estado local solo si existe un
-- touchpoint `NOVEDAD:%` de ese teléfono con
-- `action_date = (NOW() AT TIME ZONE 'America/Bogota')::date`.
-- O sea: la protección dura UN DÍA CALENDARIO.
--
--   1. Lunes: se resuelve → novedad_sol=true, estado='NOVEDAD SOLUCIONADA'.
--      Protegido todo el lunes.
--   2. Martes: corre el sync. Dropi SIGUE reportando NOVEDAD, porque la
--      transportadora tarda DÍAS en volver a ofrecer el paquete. El trigger
--      busca un touchpoint de hoy=martes, no hay, y suelta.
--   3. La novedad REAPARECE en «Por gestionar» y hay que resolverla de nuevo.
--
-- «Algunos se quitan y pocos no» = las que la transportadora ya re-ofreció
-- salen para siempre; las lentas vuelven al otro día.
--
-- La migración 20260714140000 documenta EXACTAMENTE este síntoma («el pedido
-- REAPARECE en la cola del turno de la tarde») pero solo arregló la zona
-- horaria (CURRENT_DATE → Bogotá). La ventana de UN DÍA quedó intacta, y es la
-- que sigue mordiendo.
--
-- ── El arreglo, y sus dos límites ───────────────────────────────────────────
-- La protección tiene que durar lo que tarda la transportadora, no lo que dura
-- un día. Se abre a 7 días — la misma vara con la que esta operación mide el
-- reloj de una agencia.
--
-- ⛔ PERO UNA NOVEDAD **NUEVA** TIENE QUE VOLVER A APARECER. Si la
-- transportadora registra otra novedad distinta sobre el mismo pedido, eso es
-- trabajo real y esconderlo sería el error caro de este proyecto (esconder
-- trabajo cuesta clientes; mostrar de más solo cuesta un vistazo). Por eso la
-- protección se levanta apenas Dropi manda un texto de novedad DISTINTO y no
-- vacío.
--
-- El «no vacío» no es paranoia: hay un trigger hermano vivo en esta misma
-- tabla, `preservar_novedad_no_vacia`, que existe justamente porque a veces
-- llega la novedad en blanco. Sin ese guard, un sync con el campo vacío se
-- leería como «novedad distinta» y soltaría la protección — reintroduciendo el
-- bug por la puerta de atrás.
--
-- ⛔ REGLA #1 — el cuerpo NO salió del repo. Salió de
-- `pg_get_functiondef('public.protect_resolved_novedades_bogota'::regproc)`
-- pedido el 3-sep-2026, y lo ÚNICO que cambia es la condición de la fecha más
-- el guard de la novedad nueva. Ojo con el nombre: el repo tiene esta función
-- como `protect_resolved_novedades_today`; en la base se llama `..._bogota` y
-- `..._today` NO EXISTE. Se reemplaza la que de verdad está corriendo.
--
-- ⛔ REGLA #0 — esto reemplaza una función y nada más: cero ALTER, cero
-- índices, cero UPDATE masivo sobre `orders`. El trigger
-- `trg_protect_resolved_novedades_bogota` ya existe y ya apunta acá, así que
-- tampoco se toca. Va con `lock_timeout` por disciplina.
-- ============================================================================

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.protect_resolved_novedades_bogota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF (OLD.novedad_sol IS TRUE AND NEW.novedad_sol IS DISTINCT FROM TRUE)
     OR (OLD.estado = 'NOVEDAD SOLUCIONADA' AND NEW.estado IS DISTINCT FROM 'NOVEDAD SOLUCIONADA') THEN
    IF EXISTS (
      SELECT 1 FROM public.touchpoints
      WHERE phone = OLD.phone
        AND action LIKE 'NOVEDAD:%'
        -- Antes: `= hoy`. La transportadora tarda DÍAS en re-ofrecer, así que
        -- una ventana de un día devolvía la novedad a la cola cada mañana.
        AND action_date >= (NOW() AT TIME ZONE 'America/Bogota')::date - INTERVAL '7 days'
    ) THEN
      -- Una novedad DISTINTA y no vacía es trabajo nuevo: se deja pasar para
      -- que vuelva a la cola. Lo vacío NO cuenta como distinto.
      IF NEW.novedad IS NULL
         OR btrim(NEW.novedad) = ''
         OR NEW.novedad IS NOT DISTINCT FROM OLD.novedad THEN
        NEW.novedad_sol := OLD.novedad_sol;
        NEW.estado := OLD.estado;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $function$;

COMMENT ON FUNCTION public.protect_resolved_novedades_bogota() IS
  'Protege la novedad resuelta contra el próximo sync de Dropi durante 7 días '
  '(antes: 1 día calendario, y por eso volvía a la cola cada mañana). Se '
  'levanta apenas Dropi reporta una novedad DISTINTA y no vacía: una novedad '
  'nueva es trabajo real y no se esconde. Ver 20260903200000.';
