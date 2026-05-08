-- Remove unused dropi_white_brand_id setting (legacy, not referenced anywhere)
DELETE FROM public.app_settings WHERE key = 'dropi_white_brand_id';