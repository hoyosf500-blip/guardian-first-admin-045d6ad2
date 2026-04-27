// Shared CORS helper for all Lovable edge functions.
// Allowlist preserves Lovable preview, sandbox, production y localhost dev.
// Si el Origin no matchea, devolvemos production como default (no un comodín).

const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/guardian-first-admin\.lovable\.app$/,
  /^https:\/\/[a-z0-9-]+\.lovable\.app$/,        // preview Lovable
  /^https:\/\/[a-z0-9-]+\.lovableproject\.com$/, // sandbox Lovable
  /^http:\/\/localhost:\d+$/,                     // dev local
];

const DEFAULT_ALLOWED = "https://guardian-first-admin.lovable.app";

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGIN_PATTERNS.some(re => re.test(origin));
  return {
    "Access-Control-Allow-Origin": allowed ? origin : DEFAULT_ALLOWED,
    "Vary": "Origin",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-cron-secret, x-relay-secret",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  };
}
