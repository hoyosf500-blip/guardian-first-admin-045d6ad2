-- Restore brand_name + dropi_store_url for seed-data owner instance only.
-- Idempotent: only updates if value is empty.
DO $$
DECLARE is_owner BOOLEAN;
BEGIN
  SELECT (value = 'true') INTO is_owner FROM public.app_settings
    WHERE key = 'is_seed_data_owner';
  IF COALESCE(is_owner, FALSE) THEN
    INSERT INTO public.app_settings (key, value)
      VALUES ('brand_name', 'daxy')
      ON CONFLICT (key) DO UPDATE
        SET value = 'daxy', updated_at = now()
        WHERE COALESCE(public.app_settings.value, '') = '';
    INSERT INTO public.app_settings (key, value)
      VALUES ('dropi_store_url', 'https://rushmira.com/')
      ON CONFLICT (key) DO UPDATE
        SET value = 'https://rushmira.com/', updated_at = now()
        WHERE COALESCE(public.app_settings.value, '') = '';
  END IF;
END $$;