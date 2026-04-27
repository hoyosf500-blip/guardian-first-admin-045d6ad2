GRANT EXECUTE ON FUNCTION public.dropi_fingerprint(text) TO authenticated;
GRANT USAGE ON SCHEMA extensions TO authenticated;
GRANT EXECUTE ON FUNCTION extensions.http(extensions.http_request) TO authenticated;
GRANT EXECUTE ON FUNCTION extensions.http_header(varchar, varchar) TO authenticated;