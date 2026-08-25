-- BLINDAJE ANTI-CAÍDA DE LA BASE (2026-08-25)
--
-- Qué pasó: una transacción quedó abierta reteniendo un ShareLock sobre `orders`,
-- y como NADA la cortaba, todas las lecturas se encolaron detrás y la base entera
-- se congeló ~20 min (hasta el login se caía). El equipo de Ecuador quedó sin CRM.
-- Se destrabó reiniciando el backend (Lovable). Esto evita que se repita.
--
-- Dos topes automáticos a nivel de rol. Aplican a sesiones NUEVAS (post-deploy).
-- NO se toca `service_role`: los edge functions / crons hacen trabajo largo
-- legítimo (sync, XLSX) y ya se autolimitan por dentro (AbortController/budget).

-- 1) TRANSACCIÓN OCIOSA ABIERTA → se corta. Es la CAUSA RAÍZ exacta de hoy: una
--    transacción que abrió, tomó un lock y se quedó colgada sin cerrar. Ahora, si
--    una sesión deja una transacción abierta sin hacer nada, Postgres la mata y
--    suelta el lock. Es súper seguro: una transacción normal cierra en milisegundos.
ALTER ROLE authenticated SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE anon          SET idle_in_transaction_session_timeout = '30s';

-- 2) CONSULTA ETERNA → se cancela sola. Si una consulta no termina en el tope, se
--    corta (la pantalla lo maneja como error puntual y la base SIGUE VIVA para los
--    demás), en vez de colgarse el minuto completo del gateway y tapar el pool de
--    conexiones. Valor GENEROSO: una consulta normal de la app tarda <2 s; un
--    reporte de 30 s ya es un problema aparte.
ALTER ROLE authenticated SET statement_timeout = '30s';
ALTER ROLE anon          SET statement_timeout = '15s';

-- Nota para migraciones FUTURAS que toquen tablas calientes (orders, order_results,
-- touchpoints): poner `SET lock_timeout = '5s';` al inicio y usar
-- `CREATE INDEX CONCURRENTLY` — así el DDL FALLA RÁPIDO en vez de encolar a todo el
-- mundo detrás. Ver la regla en CLAUDE.md.
