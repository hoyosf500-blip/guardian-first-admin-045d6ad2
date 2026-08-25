ALTER ROLE authenticated SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE anon          SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE authenticated SET statement_timeout = '30s';
ALTER ROLE anon          SET statement_timeout = '15s';