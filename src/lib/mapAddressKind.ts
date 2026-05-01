// src/lib/mapAddressKind.ts
const PICKUP_PATTERNS = [
  /oficina[\s_-]*(inter[\s-]?rapidisimo|envia|coordinadora|tcc|domina|veloces|servientrega)/i,
  /\bsucursal\b/i,
  /cliente[\s_-]*retira/i,
  /\bpunto[\s_-]*(dropi|drop)\b/i,
  /retiro[\s_-]*en[\s_-]*oficina/i,
  /recl(?:amo|ama|amar|amará)[\s_-]+en[\s_-]+oficina/i,
  /recl(?:amo|ama|amar)[\s_-]+oficina/i,
  /oficina[\s_-]+(servientrega|envia|coordinadora|inter[\s-]?rapid|tcc|domina)/i,
  /lo[\s_-]+(recojo|recoge)[\s_-]+(yo|en)/i,
  /yo[\s_-]+lo[\s_-]+recojo/i,
  /paso[\s_-]+a[\s_-]+recogerlo/i,
];

const RURAL_PATTERNS = [
  /\bmanzana\b/i, /\bmz\b/i, /\bmza\b/i, /\blote\b/i, /\blt\b/i,
  /\bfinca\b/i, /\bvereda\b/i, /\bcorregimiento\b/i, /\bkm\b/i,
  /kilometro/i, /\bsector\b/i,
];

const URBAN_PATTERNS = [
  /\b(?:cll?|calle|cl)\d*\b/i,
  /\b(?:cra|carrera|kr|kar)\d*\b/i,
  /\b(?:av|avenida)\d*\b/i,
  /\b(?:dg|diagonal)\d*\b/i,
  /\b(?:tv|transversal)\d*\b/i,
  /\b(?:cdla|ciudadela)\d*\b/i,
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
