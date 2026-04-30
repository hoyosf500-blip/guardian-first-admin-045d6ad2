// supabase/functions/dropi-validate-address/_addressKind.ts
// Port intencional de src/lib/mapAddressKind.ts. Mantener sincronizado.

const PICKUP_PATTERNS = [
  /oficina[\s_-]*(inter[\s-]?rapidisimo|envia|coordinadora|tcc|domina|veloces|servientrega)/i,
  /\bsucursal\b/i,
  /cliente[\s_-]*retira/i,
  /\bpunto[\s_-]*(dropi|drop)\b/i,
  /retiro[\s_-]*en[\s_-]*oficina/i,
];

const RURAL_PATTERNS = [
  /\bmanzana\b/i, /\bmz\b/i, /\bmza\b/i, /\blote\b/i, /\blt\b/i,
  /\bfinca\b/i, /\bvereda\b/i, /\bcorregimiento\b/i, /\bkm\b/i,
  /kilometro/i, /\bsector\b/i,
];

const URBAN_PATTERNS = [
  /\bcalle\b/i, /\bcl\b/i, /\bcll\b/i, /\bcarrera\b/i, /\bcra\b/i,
  /\bkr\b/i, /\bavenida\b/i, /\bav\b/i, /\bdiagonal\b/i, /\bdg\b/i,
  /\btransversal\b/i, /\btv\b/i, /\bcdla\b/i,
];

function normalize(input: string): string {
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function mapAddressKind(direccion: string): 'urban' | 'rural' | 'pickup_office' | 'unknown' {
  if (!direccion || !direccion.trim()) return 'unknown';
  const n = normalize(direccion);
  if (PICKUP_PATTERNS.some((re) => re.test(n))) return 'pickup_office';
  if (RURAL_PATTERNS.some((re) => re.test(n))) return 'rural';
  if (URBAN_PATTERNS.some((re) => re.test(n))) return 'urban';
  return 'unknown';
}
