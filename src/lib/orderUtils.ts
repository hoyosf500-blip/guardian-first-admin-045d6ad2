import { COL_MAP, CARRIER_TRACK, CARRIER_TRACK_EC } from './constants';

/** Safely extract an error message from an unknown catch value */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Error desconocido';
}

export interface OrderData {
  idx: number;
  id: string;
  externalId: string;
  nombre: string;
  phone: string;
  ciudad: string;
  producto: string;
  estado: string;
  fecha: string;
  fechaConf: string;
  dias: number;
  diasConf: number;
  valor: number;
  flete: number;
  costoProd: number;
  costoDev: number;
  cantidad: number;
  direccion: string;
  novedad: string;
  guia: string;
  transportadora: string;
  tags: string;
  departamento: string;
  tienda: string;
  email: string;
  novedadSol: boolean;
  result?: string;
  reason?: string;
  dbId?: string;
  assignedTo?: string;
  retryCount?: number; // How many previous noresp attempts today
  lockedBy?: string | null;
  lockedAt?: string | null;
  barrio: string;
  complemento: string;
  documentoDestinatario: string;
  googlePlaceId: string;
  lat: number | null;
  lng: number | null;
  validationDecision: 'green' | 'yellow' | 'red' | 'pickup_office' | null;
  addressKind: 'urban' | 'rural' | 'pickup_office' | 'unknown' | null;
  missingFields: string[];
  suggestedCustomerMessage: string;
  suggestedAddress: string | null;
  addressParsed: Record<string, unknown> | null;
  /** Último movimiento real en Dropi (updated_at). Lo usan las Listas SLA para
   *  medir días hábiles SIN MOVIMIENTO. Opcional/null hasta que la columna esté
   *  viva (ver nota HOTFIX en orderColumns.ts) → cae al fallback de creación. */
  lastMovementAt?: string | null;
  /** Fecha de creación de la fila en la DB (created_at). Opcional/null. */
  createdAt?: string | null;
}

/** Shape of a raw DB row from the orders table (all fields nullable) */
export interface DbOrderRow {
  id?: string | null;
  external_id?: string | null;
  assigned_to?: string | null;
  nombre?: string | null;
  phone?: string | null;
  ciudad?: string | null;
  departamento?: string | null;
  direccion?: string | null;
  producto?: string | null;
  estado?: string | null;
  fecha?: string | null;
  fecha_conf?: string | null;
  dias?: number | null;
  dias_conf?: number | null;
  valor?: number | null;
  flete?: number | null;
  costo_prod?: number | null;
  costo_dev?: number | null;
  cantidad?: number | null;
  novedad?: string | null;
  guia?: string | null;
  transportadora?: string | null;
  tags?: string | null;
  tienda?: string | null;
  email?: string | null;
  novedad_sol?: boolean | null;
  locked_by?: string | null;
  locked_at?: string | null;
  // Validador de direcciones — agregado por migración 20260501000000
  barrio?: string | null;
  complemento?: string | null;
  documento_destinatario?: string | null;
  google_place_id?: string | null;
  lat?: number | null;
  lng?: number | null;
  validation_decision?: 'green' | 'yellow' | 'red' | 'pickup_office' | null;
  address_kind?: 'urban' | 'rural' | 'pickup_office' | 'unknown' | null;
  missing_fields?: string[] | null;
  suggested_customer_message?: string | null;
  suggested_address?: string | null;
  address_parsed?: Record<string, unknown> | null;
  // Último movimiento en Dropi — migración 20260526120000. Opcional: el SELECT
  // no lo trae hasta que la migración esté aplicada (ver orderColumns.ts).
  last_movement_at?: string | null;
  // Fecha de creación del pedido en Guardian. YA está en ORDER_COLUMNS y en el
  // SELECT('*'), así que llega siempre. La usa la cola de Confirmar para
  // priorizar por hora de compra (Hallazgo 8).
  created_at?: string | null;
}

/** Convert a raw DB row into an OrderData object */
export function dbToOrderData(o: DbOrderRow, idx: number): OrderData {
  return {
    idx, id: String(idx), externalId: o.external_id || '', dbId: o.id || undefined, assignedTo: o.assigned_to || undefined,
    nombre: o.nombre || '', phone: o.phone || '', ciudad: o.ciudad || '',
    producto: o.producto || '', estado: o.estado || '', fecha: o.fecha || '',
    fechaConf: o.fecha_conf || '', dias: o.dias || 0, diasConf: o.dias_conf || 0,
    valor: Number(o.valor) || 0, flete: Number(o.flete) || 0,
    costoProd: Number(o.costo_prod) || 0, costoDev: Number(o.costo_dev) || 0,
    cantidad: o.cantidad || 1, direccion: o.direccion || '',
    novedad: o.novedad || '', guia: o.guia || '',
    transportadora: o.transportadora || '', tags: o.tags || '',
    departamento: o.departamento || '', tienda: o.tienda || '',
    email: o.email || '',
    novedadSol: o.novedad_sol || false,
    lockedBy: o.locked_by ?? null,
    lockedAt: o.locked_at ?? null,
    barrio: o.barrio || '',
    complemento: o.complemento || '',
    documentoDestinatario: o.documento_destinatario || '',
    googlePlaceId: o.google_place_id || '',
    lat: typeof o.lat === 'number' ? o.lat : null,
    lng: typeof o.lng === 'number' ? o.lng : null,
    validationDecision: o.validation_decision ?? null,
    addressKind: o.address_kind ?? null,
    missingFields: Array.isArray(o.missing_fields) ? o.missing_fields : [],
    suggestedCustomerMessage: o.suggested_customer_message || '',
    suggestedAddress: o.suggested_address ?? null,
    addressParsed: (o.address_parsed as Record<string, unknown>) ?? null,
    lastMovementAt: o.last_movement_at ?? null,
    createdAt: o.created_at ?? null,
  };
}

/** Parse a date string and return the Date object (UTC), or null */
export function parseDate(dateStr: string): Date | null {
  if (!dateStr || dateStr === 'undefined') return null;
  try {
    let d: Date | null = null;

    // DD/MM/YYYY or DD-MM-YYYY
    const dmy = dateStr.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
    if (dmy) {
      let yearNum = parseInt(dmy[3]);
      if (yearNum < 100) yearNum += 2000;
      const monthNum = parseInt(dmy[2]);
      const dayNum = parseInt(dmy[1]);
      if (monthNum >= 1 && monthNum <= 12 && dayNum >= 1 && dayNum <= 31) {
        d = new Date(Date.UTC(yearNum, monthNum - 1, dayNum));
      }
    }

    // YYYY-MM-DD (ISO)
    if (!d) {
      const iso = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) {
        d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
      }
    }

    // Fallback
    if (!d) {
      d = new Date(dateStr);
    }

    if (!d || isNaN(d.getTime())) return null;
    return d;
  } catch {
    return null;
  }
}

/** Calendar days since a date string */
export function calcDias(dateStr: string): number {
  const d = parseDate(dateStr);
  if (!d) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

/**
 * ¿La fecha del pedido cae dentro de los últimos `days` días (calendario)?
 * Es la ventana por defecto de Seguimiento ("últimos 45 días"): al pasar de mes,
 * los pedidos del mes anterior que SIGUEN en ruta no se "quedan atrás" (antes el
 * default era el 1° del mes en curso → al cambiar de mes desaparecían de la vista).
 * Una fecha sin parsear devuelve `true` (no escondemos por las dudas: mejor mostrar
 * de más que perder un pedido vivo por un formato de fecha raro).
 */
export function isWithinLastDays(
  fecha: string | null | undefined,
  days: number,
  nowMs: number = Date.now(),
): boolean {
  const d = parseDate(fecha || '');
  if (!d) return true;
  return d.getTime() >= nowMs - days * 86400000;
}

/** Offset de Bogotá/Ecuador respecto a UTC (ambos UTC-5, sin DST), en ms. */
const BOGOTA_OFFSET_MS = 5 * 3600 * 1000;

/**
 * ¿Este pedido fue CERRADO (Resuelto/Devolución) por el equipo y por lo tanto NO
 * debe volver a aparecer en Seguimiento? "Si ya se entregó o se devolvió, no
 * vuelve a salir" — el panel solo debe tener pedidos accionables.
 *
 * `closerMs` = timestamp (ms) del último cierre registrado para el TELÉFONO del
 * pedido (team-wide; ver useSegClosedPhones). Como los touchpoints matchean por
 * phone (no por order_id), exigimos que el cierre sea POSTERIOR a la creación del
 * pedido: así un pedido NUEVO de un cliente que ya tuvo un cierre viejo NO se
 * esconde por error.
 *
 * Sutilezas de zona horaria: `parseDate(o.fecha)` da MEDIANOCHE UTC, pero pedidos
 * y cierres ocurren en hora local (CO y EC son UTC-5). Alineamos a medianoche
 * LOCAL (+5h) para no esconder un pedido creado en la mañana por un cierre de la
 * NOCHE anterior del mismo teléfono. Sin `closerMs` → no está cerrado. Fecha sin
 * parsear → NO escondemos (preferimos mostrar un pedido que quizá siga vivo antes
 * que ocultarlo para siempre por un formato de fecha raro; consistente con
 * isWithinLastDays).
 */
export function isClosedOutByCloser(
  fecha: string | null | undefined,
  closerMs: number | undefined,
): boolean {
  if (closerMs === undefined) return false;
  const created = parseDate(fecha || '');
  if (!created) return false;
  return closerMs >= created.getTime() + BOGOTA_OFFSET_MS;
}

/**
 * Colombian public holidays (Ley Emiliani + fixed).
 * Returns holidays for a given year as "YYYY-MM-DD" strings.
 */
function getColombianHolidays(year: number): Set<string> {
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  // Easter calculation (Anonymous Gregorian algorithm)
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = new Date(Date.UTC(year, month, day));

  const addDays = (base: Date, n: number) => {
    const d = new Date(base.getTime());
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  };

  // Move to next Monday (Ley Emiliani)
  const nextMonday = (d: Date) => {
    const dow = d.getUTCDay();
    if (dow === 1) return d;
    const diff = dow === 0 ? 1 : (8 - dow);
    return addDays(d, diff);
  };

  const holidays = new Set<string>();

  // Fixed holidays
  holidays.add(`${year}-01-01`); // Año Nuevo
  holidays.add(`${year}-05-01`); // Día del Trabajo
  holidays.add(`${year}-07-20`); // Grito de Independencia
  holidays.add(`${year}-08-07`); // Batalla de Boyacá
  holidays.add(`${year}-12-08`); // Inmaculada Concepción
  holidays.add(`${year}-12-25`); // Navidad

  // Ley Emiliani (moved to Monday)
  holidays.add(fmt(nextMonday(new Date(Date.UTC(year, 0, 6)))));   // Reyes Magos
  holidays.add(fmt(nextMonday(new Date(Date.UTC(year, 2, 19)))));  // San José
  holidays.add(fmt(nextMonday(new Date(Date.UTC(year, 5, 29)))));  // San Pedro y San Pablo
  holidays.add(fmt(nextMonday(new Date(Date.UTC(year, 7, 15)))));  // Asunción
  holidays.add(fmt(nextMonday(new Date(Date.UTC(year, 9, 12)))));  // Día de la Raza
  holidays.add(fmt(nextMonday(new Date(Date.UTC(year, 10, 1)))));  // Todos los Santos
  holidays.add(fmt(nextMonday(new Date(Date.UTC(year, 10, 11))))); // Independencia de Cartagena

  // Easter-based
  holidays.add(fmt(addDays(easter, -3)));  // Jueves Santo
  holidays.add(fmt(addDays(easter, -2)));  // Viernes Santo
  holidays.add(fmt(nextMonday(addDays(easter, 43))));  // Ascensión
  holidays.add(fmt(nextMonday(addDays(easter, 64))));  // Corpus Christi
  holidays.add(fmt(nextMonday(addDays(easter, 71))));  // Sagrado Corazón

  return holidays;
}

/** Business days (Mon-Fri, excluding Colombian holidays) between a date and today. */
export function calcBusinessDays(dateStr: string): number {
  const start = parseDate(dateStr);
  if (!start) return 0;

  const now = new Date();
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

  if (start >= today) return 0;

  // Collect holidays for relevant years
  const startYear = start.getUTCFullYear();
  const endYear = today.getUTCFullYear();
  const allHolidays = new Set<string>();
  for (let y = startYear; y <= endYear; y++) {
    getColombianHolidays(y).forEach((h) => allHolidays.add(h));
  }

  const pad = (n: number) => String(n).padStart(2, '0');

  let count = 0;
  const current = new Date(start.getTime());
  current.setUTCDate(current.getUTCDate() + 1);

  while (current <= today) {
    const dow = current.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const key = `${current.getUTCFullYear()}-${pad(current.getUTCMonth() + 1)}-${pad(current.getUTCDate())}`;
      if (!allHolidays.has(key)) {
        count++;
      }
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return count;
}

export function cleanPhone(p: string): string {
  return p.replace(/[^0-9]/g, '');
}

export function formatPhone(p: string): string {
  if (p.length === 10) return p.replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3');
  return p;
}

/**
 * Normaliza un teléfono colombiano a su forma canónica (10 dígitos arrancando
 * con 3, sin código de país). Acepta variaciones comunes que el cliente puede
 * tipear:
 *   "3229372886"           → "3229372886"  (canónico)
 *   "573229372886"         → "3229372886"  (con prefijo 57)
 *   "+57 322 937 2886"     → "3229372886"  (espacios y +)
 *   "57 (322) 937-2886"    → "3229372886"  (paréntesis y guion)
 * Devuelve null si no encaja en ninguna de las dos formas válidas:
 * 10 dígitos arrancando con 3, o 12 dígitos arrancando con "57" + 3.
 *
 * Reportado 2026-05-05: cliente Cristian Mendez escribió "573229372886" en
 * Shopify y `validarTelefono` lo rechazaba (length !== 10), bloqueando la
 * confirmación. Antes esto vivía como regex inline en CallView.tsx; ahora
 * está acá para reuso (CallView gate + EditOrderDialog).
 */
export function normalizeColombianPhone(phone: string): string | null {
  const clean = (phone || '').replace(/\D/g, '');
  if (clean.length === 10 && clean.startsWith('3')) return clean;
  if (clean.length === 12 && clean.startsWith('57') && clean[2] === '3') {
    return clean.slice(2);
  }
  return null;
}

/** Devuelve true si el teléfono se puede normalizar a un móvil COL válido. */
export function isValidColombianPhone(phone: string): boolean {
  return normalizeColombianPhone(phone) !== null;
}

/**
 * Normaliza un móvil ecuatoriano a su forma canónica de 9 dígitos arrancando
 * en 9 (sin trunk 0 ni código de país). Acepta:
 *   "983364222"        → "983364222"  (canónico, como lo guarda Dropi EC)
 *   "0983364222"       → "983364222"  (con trunk 0)
 *   "593983364222"     → "983364222"  (código país)
 *   "+593 98 336 4222" → "983364222"  (con + y espacios)
 * Devuelve null si no encaja.
 */
export function normalizeEcuadorianPhone(phone: string): string | null {
  let d = (phone || '').replace(/\D/g, '');
  if (d.startsWith('593')) d = d.slice(3);
  if (d.length === 10 && d.startsWith('0')) d = d.slice(1);
  return d.length === 9 && d.startsWith('9') ? d : null;
}

/** Validez de móvil ecuatoriano. */
export function isValidEcuadorianPhone(phone: string): boolean {
  return normalizeEcuadorianPhone(phone) !== null;
}

/** Normaliza según el país de la tienda (default CO). */
export function normalizePhoneForCountry(phone: string, countryCode?: string | null): string | null {
  return (countryCode || 'CO').toUpperCase() === 'EC'
    ? normalizeEcuadorianPhone(phone)
    : normalizeColombianPhone(phone);
}

/** Validez de móvil según el país de la tienda (default CO). */
export function isValidPhoneForCountry(phone: string, countryCode?: string | null): boolean {
  return normalizePhoneForCountry(phone, countryCode) !== null;
}

/** Normalize a phone for wa.me/ links (country code prefix exactly once).
 *  countryCode de la tienda activa: 'EC' usa 593, default 'CO' usa 57. */
export function getWhatsAppPhone(phone: string, countryCode?: string | null): string {
  if ((countryCode || 'CO').toUpperCase() === 'EC') {
    const n = normalizeEcuadorianPhone(phone);
    if (n) return `593${n}`;
    const d = phone.replace(/[^0-9]/g, '');
    if (d.startsWith('593')) return d;
    return `593${d.replace(/^0/, '')}`;
  }
  const digits = phone.replace(/[^0-9]/g, '');
  // 10-digit Colombian mobile (3xx xxx xxxx) → always prepend 57.
  if (digits.length === 10) return `57${digits}`;
  // 12-digit already has country code (57 + 10 digits) → use as-is.
  if (digits.length === 12 && digits.startsWith('57')) return digits;
  // Anything else: strip a leading 57 if present and re-prepend to normalize.
  if (digits.startsWith('57') && digits.length > 10) return digits;
  return `57${digits}`;
}

export function isPendiente(estado: string): boolean {
  const s = estado.toUpperCase();
  return s === 'PENDIENTE CONFIRMACION';
}

export function isDespachado(estado: string): boolean {
  const s = estado.toUpperCase();
  return ['GUIA_GENERADA', 'PREPARADO PARA TRANSPORTADORA', 'EN BODEGA TRANSPORTADORA',
    'EN REPARTO', 'EN TERMINAL DESTINO', 'EN DISTRIBUCION', 'EN REEXPEDICION', 'REENVÍO', 'REENVIO',
    'ADMITIDA', 'EN DESPACHO', 'ENTREGADO A TRANSPORTADORA', 'EN TRANSPORTE', 'TELEMERCADEO'
  ].includes(s) || s.includes('DESPACHAD');
}

export function isConfirmado(estado: string): boolean {
  const s = estado.toUpperCase();
  return ['PENDIENTE', 'ALISTAMIENTO', 'GUIA GENERADA', 'EN PROCESAMIENTO', 'EN BODEGA DROPI', 'RECOGIDO POR DROPI'].includes(s);
}

export function isNovedad(estado: string): boolean {
  const s = estado.toUpperCase();
  return s === 'NOVEDAD' || s === 'INTENTO DE ENTREGA';
}

export function isOficina(estado: string): boolean {
  const s = estado.toUpperCase();
  return s === 'RECLAME EN OFICINA' || s.includes('RECLAME');
}

export function isDevolucion(estado: string): boolean {
  const s = estado.toUpperCase();
  return s === 'DEVOLUCION' || s.includes('DEVOL');
}

// País de la tienda activa, para resolver el mapa de rastreo correcto sin tener
// que pasar el país en cada call-site. Lo setea StoreContext al cambiar de
// tienda (patrón de estado a nivel módulo, igual que los overrides del
// validador de direcciones). Default 'CO'.
let _activeTrackingCountry = 'CO';
export function setTrackingCountry(cc?: string | null): void {
  _activeTrackingCountry = (cc || 'CO').toUpperCase();
}

export function getTrackingUrl(carrier: string, guia: string, countryCode?: string): string | null {
  const key = (carrier || '').toUpperCase().trim();
  const cc = (countryCode || _activeTrackingCountry).toUpperCase();
  // Para Ecuador, las entradas EC pisan a las CO con el mismo nombre (ej.
  // SERVIENTREGA tiene URL distinta por país). Para el resto (default/CO) se usa
  // solo el mapa colombiano — comportamiento histórico intacto.
  const map = cc === 'EC' ? { ...CARRIER_TRACK, ...CARRIER_TRACK_EC } : CARRIER_TRACK;
  for (const name of Object.keys(map)) {
    if (key.includes(name)) {
      const url = map[name];
      return url.endsWith('=') ? url + guia : url;
    }
  }
  return null;
}

export function normalizeColumns(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (!rows.length) return rows;
  const srcKeys = Object.keys(rows[0]);
  const map: Record<string, string> = {};
  for (const [std, alts] of Object.entries(COL_MAP)) {
    if (srcKeys.includes(std)) { map[std] = std; continue; }
    const found = alts.find(a => srcKeys.includes(a));
    if (found) map[std] = found;
  }
  return rows.map(r => {
    const nr = { ...r };
    for (const [std, src] of Object.entries(map)) {
      if (src !== std) nr[std] = r[src];
    }
    return nr;
  });
}

export function parseExcelToOrders(rows: Record<string, unknown>[]): OrderData[] {
  const normalized = normalizeColumns(rows);
  if (!normalized.length) return [];
  const headers = Object.keys(normalized[0]);
  const map: Record<string, string> = {};
  for (const key of Object.keys(COL_MAP)) {
    if (headers.includes(key)) { map[key] = key; continue; }
    for (const alt of COL_MAP[key]) {
      if (headers.includes(alt.trim())) { map[key] = alt; break; }
    }
  }
  if (!map.NOMBRE && !map.TELEFONO) return [];

  return normalized.map((r, idx) => {
    const estado = String(r[map.ESTADO] || r['ESTATUS'] || r['ESTADO'] || '').trim().toUpperCase();
    const phone = cleanPhone(String(r[map.TELEFONO] || ''));
    const novedadSolVal = String(r[map.NOVEDAD_SOL] || '').toLowerCase();
    return {
      idx,
      id: String(idx),
      externalId: String(r[map.ID] || idx),
      nombre: String(r[map.NOMBRE] || 'Sin nombre'),
      phone,
      ciudad: String(r[map.CIUDAD] || ''),
      producto: String(r[map.PRODUCTO] || ''),
      estado,
      fecha: String(r[map.FECHA] || ''),
      fechaConf: String(r[map.FECHA_CONF] || ''),
      dias: calcDias(String(r[map.FECHA] || '')),
      diasConf: calcDias(String(r[map.FECHA_CONF] || '')),
      valor: parseFloat(String(r[map.VALOR] || '0').replace(/[^0-9.]/g, '')) || 0,
      flete: parseFloat(String(r[map.FLETE] || '0').replace(/[^0-9.]/g, '')) || 0,
      costoProd: parseFloat(String(r[map.COSTO_PROD] || '0').replace(/[^0-9.]/g, '')) || 0,
      costoDev: parseFloat(String(r[map.COSTO_DEV] || '0').replace(/[^0-9.]/g, '')) || 0,
      cantidad: parseInt(String(r[map.CANTIDAD])) || 1,
      direccion: String(r[map.DIRECCION] || ''),
      novedad: String(r[map.NOVEDAD] || ''),
      guia: String(r[map.GUIA] || ''),
      transportadora: String(r[map.TRANSPORTADORA] || ''),
      tags: String(r[map.TAGS] || ''),
      departamento: String(r[map.DEPARTAMENTO] || ''),
      tienda: String(r[map.TIENDA] || ''),
      email: '',
      novedadSol: novedadSolVal === 'si' || novedadSolVal === 'sí',
      barrio: '',
      complemento: '',
      documentoDestinatario: '',
      googlePlaceId: '',
      lat: null,
      lng: null,
      validationDecision: null,
      addressKind: null,
      missingFields: [],
      suggestedCustomerMessage: '',
      suggestedAddress: null,
      addressParsed: null,
    };
  });
}

export function formatDateES(dateStr: string): string {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('es-CO', {
    weekday: 'long', day: 'numeric', month: 'long'
  });
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.substring(0, n) + '…' : s;
}
