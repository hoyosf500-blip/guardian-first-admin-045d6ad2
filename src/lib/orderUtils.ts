import { COL_MAP, CARRIER_TRACK } from './constants';

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
  novedadSol: boolean;
  result?: string;
  reason?: string;
  dbId?: string;
  assignedTo?: string;
}

export function calcDias(dateStr: string): number {
  if (!dateStr || dateStr === 'undefined') return 0;
  try {
    let d: Date;
    if (dateStr.includes('/')) {
      const parts = dateStr.split(/[\s/]+/);
      if (parts[2] && parts[2].length === 4) {
        d = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
      } else {
        d = new Date(dateStr);
      }
    } else {
      d = new Date(dateStr);
    }
    if (isNaN(d.getTime())) return 0;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  } catch {
    return 0;
  }
}

export function cleanPhone(p: string): string {
  return p.replace(/[^0-9]/g, '');
}

export function formatPhone(p: string): string {
  if (p.length === 10) return p.replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3');
  return p;
}

export function isPendiente(estado: string): boolean {
  const s = estado.toUpperCase();
  return s === 'PENDIENTE CONFIRMACION' || s === 'PENDIENTE' || s === 'TELEMERCADEO' || s === 'EN PROCESAMIENTO';
}

export function isDespachado(estado: string): boolean {
  const s = estado.toUpperCase();
  return ['GUIA_GENERADA', 'PREPARADO PARA TRANSPORTADORA', 'EN BODEGA TRANSPORTADORA',
    'EN REPARTO', 'EN TERMINAL DESTINO', 'EN DISTRIBUCION', 'EN REEXPEDICION', 'REENVÍO', 'REENVIO'
  ].includes(s) || s.includes('DESPACHAD');
}

export function isNovedad(estado: string): boolean {
  const s = estado.toUpperCase();
  return s === 'NOVEDAD' || s === 'INTENTO DE ENTREGA';
}

export function isOficina(estado: string): boolean {
  const s = estado.toUpperCase();
  return s === 'RECLAME EN OFICINA' || s.includes('RECLAME');
}

export function getTrackingUrl(carrier: string, guia: string): string | null {
  const key = (carrier || '').toUpperCase().trim();
  for (const name of Object.keys(CARRIER_TRACK)) {
    if (key.includes(name)) {
      const url = CARRIER_TRACK[name];
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
      novedadSol: novedadSolVal === 'si' || novedadSolVal === 'sí',
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
