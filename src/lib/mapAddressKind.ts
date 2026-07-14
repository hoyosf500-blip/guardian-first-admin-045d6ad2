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
  // Bug B: "of <transportadora>" abreviado (of interrapidismo, of servientrega).
  /\bof\s+(inter[\s-]?rapid|servientrega|envia|coordinadora|tcc|domina|veloces)/i,
  // "local NN" + transportadora cerca o "comercial" → punto de retiro comercial.
  /\blocal\s+\d+.*\b(inter|servientrega|envia|coordinadora|tcc|domina|comercial)/i,
  // Centro/pasaje comercial SOLO cuenta como retiro cuando es el DESTINO de
  // recogida, no una simple referencia ("casa cerca del centro comercial,
  // entrega a domicilio"). Para no clasificar mal esos casos se exige que:
  //   (a) el "centro/pasaje comercial" abra la dirección (es el núcleo), o
  //   (b) venga acompañado de una palabra de recogida (reclamo/recojo/retiro/
  //       oficina/local/stand/of) inmediatamente antes o después.
  /^\s*(?:pasaje|centro)\s+comercial\b/i,
  /\b(?:recl(?:amo|ama|amar|amará)|recojo|recoge|retir\w*|oficina|local\s*\d*|stand)\b[^.]{0,30}(?:pasaje|centro)\s+comercial\b/i,
  /\b(?:pasaje|centro)\s+comercial\b[^.]{0,30}\b(?:local|stand|oficina|of)\b/i,
  // "hotel <nombre>" + "of <transportadora>" → casi siempre punto de retiro.
  /hotel\s+\w+\s+of\s+\w+/i,
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
