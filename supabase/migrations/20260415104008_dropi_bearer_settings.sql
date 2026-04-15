-- Seed keys for the Dropi Bearer auth flow (login email/password → token).
-- These rows are created empty (or with sensible defaults) so that the admin UI
-- and the dropi-update-order Edge Function can read/write them via upsert.
-- RLS is already admin-only (see migration 20260413053946_*.sql).
-- Idempotent: ON CONFLICT DO NOTHING lets this re-run safely.

INSERT INTO public.app_settings (key, value) VALUES ('dropi_email', '') ON CONFLICT (key) DO NOTHING;
INSERT INTO public.app_settings (key, value) VALUES ('dropi_password', '') ON CONFLICT (key) DO NOTHING;
INSERT INTO public.app_settings (key, value) VALUES ('dropi_white_brand_id', 'df3e6b0bb66ceaadca4f84cbc371fd66e04d20fe51fc414da8d1b84d31d178de') ON CONFLICT (key) DO NOTHING;
INSERT INTO public.app_settings (key, value) VALUES ('dropi_token', '') ON CONFLICT (key) DO NOTHING;
INSERT INTO public.app_settings (key, value) VALUES ('dropi_token_at', '') ON CONFLICT (key) DO NOTHING;
INSERT INTO public.app_settings (key, value) VALUES ('dropi_token_ttl_min', '25') ON CONFLICT (key) DO NOTHING;
INSERT INTO public.app_settings (key, value) VALUES ('dropi_env', 'prod') ON CONFLICT (key) DO NOTHING;
