-- ─────────────────────────────────────────────────────────────────
-- Cerrar la escritura directa a personal_card_movements.
--
-- La política `pcm_ins` (migration 20260523072740) deja INSERTAR a
-- cualquier `authenticated` que sea owner de la tienda del `store_id`
-- que él mismo manda:
--
--   CREATE POLICY pcm_ins ON public.personal_card_movements
--     FOR INSERT TO authenticated WITH CHECK (is_store_owner(store_id));
--
-- Cuando se escribió, "owner de una tienda" era Fabián y nadie más. Desde
-- que existe el alta autoservicio (`create_my_store`), CUALQUIER usuario
-- registrado se vuelve owner de su propia tienda en un clic — y con eso
-- pasa el WITH CHECK. Puede insertar movimientos inventados en la tarjeta
-- PERSONAL del dueño de la plataforma (no los puede leer: el SELECT sigue
-- siendo admin-only), y esos movimientos entran al módulo "Análisis
-- tarjetas" y a la deuda de TC del CFO, sobre la que se calcula la
-- UTILIDAD NETA REAL.
--
-- El camino legítimo NO usa esta política: `parse-bank-pdf-text` escribe
-- vía `upsert_personal_card_movements`, que es SECURITY DEFINER (salta la
-- RLS) y ya exige `has_role(auth.uid(), 'admin')` en su primera línea.
-- Por eso quitarla no rompe la carga del extracto bancario.
--
-- ⚠️ REGLA #1 del proyecto: NO se reescribe ninguna función. Esto es solo
-- un DROP POLICY puntual.
-- ─────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS pcm_ins ON public.personal_card_movements;

-- Sin UPDATE ni DELETE tampoco: la tabla se toca ÚNICAMENTE por los RPC
-- SECURITY DEFINER admin-only. Se dejan explícitos por si alguna corrida
-- anterior los creó.
DROP POLICY IF EXISTS pcm_upd ON public.personal_card_movements;
DROP POLICY IF EXISTS pcm_del ON public.personal_card_movements;
