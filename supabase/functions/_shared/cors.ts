// Shared CORS helper for all Lovable edge functions.
// Allowlist preserves Lovable preview, sandbox, production y localhost dev.
// Si el Origin no matchea, devolvemos production como default (no un comodín).

// M2: Antes había wildcards `*.lovable.app` y `*.lovableproject.com`
// que confiaban en CUALQUIER proyecto de la plataforma Lovable. Una
// app maliciosa en otro subdominio podía hacer requests cross-origin
// con credenciales del usuario. Ahora solo el dominio prod específico
// + localhost para dev local. Si necesitas previews, agrega su URL
// exacta aquí.
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/guardian-first-admin\.lovable\.app$/,
  /^https:\/\/guardian-first-admin\.lovableproject\.com$/,
  // Lovable preview URLs: `preview--<project>.lovable.app` y
  // `id-preview--<project>.lovable.app`. Solo permitimos previews
  // del MISMO proyecto (no `*.lovable.app` general).
  /^https:\/\/(id-)?preview--guardian-first-admin\.lovable\.app$/,
  /^https:\/\/[a-z0-9-]+--guardian-first-admin\.lovable\.app$/,
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
