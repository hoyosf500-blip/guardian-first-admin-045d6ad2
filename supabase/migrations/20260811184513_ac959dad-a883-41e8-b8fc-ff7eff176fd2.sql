-- Defensa en profundidad: el rol `anon` (llave pública del navegador) NO debe
-- tener privilegios de tabla. Hoy las políticas RLS ya lo bloquean, pero los
-- GRANT heredados le daban DELETE técnico sobre todo el esquema: una sola
-- política mal escrita en el futuro y se pierde la base.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t.relname);
  END LOOP;
END $$;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- Tablas futuras: nacen cerradas para el visitante.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;

-- Única excepción viva: previsualizar una invitación sin haber iniciado sesión.
GRANT EXECUTE ON FUNCTION public.get_store_invite(text) TO anon;