/**
 * Datos OFICIALES de Dropi Ecuador sobre las transportadoras, del Drive que Dropi
 * comparte con los dropshippers («Información de Transportadoras Ecuador»,
 * volcado el 29-ago-2026). Tres cosas que el equipo hacía de memoria o a mano:
 *
 *  1. Qué agencias de Servientrega existen y cuáles están HABILITADAS para
 *     retiro (592 de 673 — 81 no reciben retiros aunque figuren como agencia).
 *  2. Qué sectores NO tienen cobertura a domicilio (692 sectores de 118
 *     ciudades: Bastión Popular, Monte Sinaí, el Guasmo entero…) y a qué agencia
 *     manda Servientrega el paquete en cada caso. Medido sobre 11.450 pedidos
 *     de esta tienda: una dirección en uno de esos sectores entrega 6-7 puntos
 *     menos que el resto en los dos años (52% vs 59% en 2025; 62% vs 68% en
 *     2026), y Servientrega la manda a la agencia de todas formas — ofrecerla
 *     ANTES evita la devolución.
 *  3. Qué significa cada novedad de cada transportadora y cómo pide Dropi que
 *     se responda en su panel («Estados y Novedades», una hoja por carrier).
 *
 * Todo es puro y sin red. Los JSON son un volcado literal de las hojas: si
 * Dropi actualiza el Drive se regeneran, no se editan a mano.
 */

import agenciasRaw from './agenciasServientrega.json';
import sectoresRaw from './sectoresSinCoberturaServientrega.json';
import novedadesRaw from './novedadesOficiales.json';

export type TransportadoraEC = 'SERVIENTREGA' | 'LAARCOURIER' | 'GINTRACOM' | 'VELOCES' | 'URBANO';

/** Lo que dice la hoja «Información Transportadoras Ecuador» sobre reclamo en oficina. */
export const RETIRO_EN_OFICINA: Record<TransportadoraEC, { permite: boolean; diasMaximo: number | null; nota: string }> = {
  SERVIENTREGA: { permite: true, diasMaximo: 7, nota: 'Solo oficinas autorizadas para Dropi. Una vez en oficina no hay cambio de punto ni salida a ruta.' },
  LAARCOURIER: { permite: true, diasMaximo: 5, nota: 'Solo oficinas autorizadas para Dropi. Una vez en oficina no hay cambio de punto ni salida a ruta.' },
  URBANO: { permite: true, diasMaximo: 7, nota: 'Si hubo un primer intento de entrega, la guía queda en oficina máximo 4 días.' },
  GINTRACOM: { permite: false, diasMaximo: null, nota: 'No maneja reclamo en oficina (medido en esta tienda: 2 entregados de 72 retiros en 2026).' },
  VELOCES: { permite: false, diasMaximo: null, nota: 'No maneja reclamo en oficina.' },
};

/** Intentos de entrega máximos por transportadora (misma hoja). */
export const INTENTOS_ENTREGA_MAX: Record<TransportadoraEC, number> = {
  LAARCOURIER: 3, SERVIENTREGA: 2, GINTRACOM: 3, VELOCES: 3, URBANO: 2,
};

const strip = (s: string): string =>
  (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Ciudad comparable: sin acentos, sin paréntesis («SALINAS (SANTA ELENA)» → «SALINAS»). */
const ciudadBase = (s: string): string => strip(s).replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();

export function normalizarTransportadora(t: string | null | undefined): TransportadoraEC | null {
  const s = strip(t ?? '');
  if (!s) return null;
  if (s.includes('SERVI')) return 'SERVIENTREGA';
  if (s.includes('LAAR')) return 'LAARCOURIER';
  if (s.includes('GINTRA')) return 'GINTRACOM';
  if (s.includes('VELOC')) return 'VELOCES';
  if (s.includes('URBANO')) return 'URBANO';
  return null;
}

// ───────────────────────── Agencias Servientrega ─────────────────────────

interface AgenciaRaw { c: string; p: string; cs: string; t: string; d: string; lv: string; sa: string }

export interface AgenciaServientrega {
  ciudad: string;
  provincia: string;
  /** Código del CS tal cual en Dropi, ej. «GUAYAQUIL_PARQUE CALIFORNIA». */
  cs: string;
  /** Nombre corto (lo que va después del «_»). */
  nombre: string;
  /** DIRECTO (propia de Servientrega) · CRESS · CONCESION. */
  tipo: string;
  direccion: string;
  horarioLunesViernes: string;
  /** Vacío, «NO LABORA» o «-» = cerrado el fin de semana. */
  horarioFinDeSemana: string;
}

const AGENCIAS: AgenciaServientrega[] = (agenciasRaw as AgenciaRaw[]).map((a) => ({
  ciudad: a.c,
  provincia: a.p,
  cs: a.cs,
  nombre: a.cs.split('_').slice(1).join(' ').trim() || a.cs,
  tipo: a.t,
  direccion: a.d,
  horarioLunesViernes: a.lv,
  horarioFinDeSemana: a.sa,
}));

const AGENCIAS_POR_CIUDAD = new Map<string, AgenciaServientrega[]>();
for (const a of AGENCIAS) {
  const k = ciudadBase(a.ciudad);
  const arr = AGENCIAS_POR_CIUDAD.get(k) ?? [];
  arr.push(a);
  AGENCIAS_POR_CIUDAD.set(k, arr);
}
const AGENCIA_POR_CS = new Map<string, AgenciaServientrega>(AGENCIAS.map((a) => [strip(a.cs), a]));

/** Agencias de Servientrega HABILITADAS para retiro en esa ciudad ([] si no hay o no se conoce). */
export function agenciasServientrega(ciudad: string | null | undefined): AgenciaServientrega[] {
  if (!ciudad) return [];
  return AGENCIAS_POR_CIUDAD.get(ciudadBase(ciudad)) ?? [];
}

export function abreSabado(a: AgenciaServientrega): boolean {
  const s = strip(a.horarioFinDeSemana);
  return Boolean(s) && !/NO LABORA|^-$|N\/A/.test(s);
}

// ───────────────────── Sectores sin cobertura a domicilio ─────────────────────

interface SectorRaw { c: string; s: string; a: string; b: string }

export interface SectorSinCobertura {
  ciudad: string;
  /** El sector tal cual lo escribe Servientrega. */
  sector: string;
  /** Agencia a la que Servientrega manda el paquete (nombre corto), o null si la hoja no la trae. */
  agencia: string | null;
  /** Ficha completa de esa agencia si está en la lista de habilitadas. */
  agenciaDetalle: AgenciaServientrega | null;
  agenciaAlternativa: string | null;
}

const STOP_SECTOR = new Set([
  'PARROQUIA', 'PAROQUIA', 'COOP', 'COOP.', 'COOPERATIVA', 'COOPERATIVAS', 'CDLA', 'CDLA.', 'CIUDADELA',
  'BARRIO', 'SECTOR', 'SECTORES', 'TODOS', 'TODAS', 'LOS', 'LAS', 'BLOQUE', 'BLOQUES', 'DESDE', 'HASTA',
  'DE', 'DEL', 'LA', 'EL', 'Y', 'EN', 'A', 'AL', 'CALLE', 'AV', 'AV.', 'VIA', 'ETAPA', 'ETAPAS', 'EXCEPCION',
]);

const tokensSector = (s: string): string[] =>
  strip(s)
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(' ')
    .filter((w) => w && !STOP_SECTOR.has(w) && (w.length >= 3 || /^\d+$/.test(w)));

const SECTORES_POR_CIUDAD = new Map<string, Array<SectorRaw & { toks: string[] }>>();
for (const z of sectoresRaw as SectorRaw[]) {
  const toks = tokensSector(z.s);
  // Sin una palabra real no se puede afirmar nada: una de 4+ letras, o dos de
  // 3+ («LUZ DEL DIA» → LUZ + DIA). Un sector que sea solo un número queda fuera.
  const alfa = toks.filter((t) => /^[A-Z]{3,}$/.test(t));
  if (!(alfa.some((t) => t.length >= 4) || alfa.length >= 2)) continue;
  const k = ciudadBase(z.c);
  const arr = SECTORES_POR_CIUDAD.get(k) ?? [];
  arr.push({ ...z, toks });
  SECTORES_POR_CIUDAD.set(k, arr);
}

const nombreAgencia = (cs: string): string | null => {
  const s = (cs ?? '').trim();
  if (!s) return null;
  return s.split('_').slice(1).join(' ').trim() || s;
};

/**
 * ¿La dirección nombra un sector donde Servientrega NO entra a domicilio?
 *
 * Exige TODAS las palabras significativas del sector, como palabras enteras, en
 * la dirección. Es deliberadamente estricto: un falso positivo manda a la
 * agencia a alguien que sí recibía en casa. Con varios candidatos gana el más
 * específico (más palabras).
 */
export function sectorSinCobertura(direccion: string | null | undefined, ciudad: string | null | undefined): SectorSinCobertura | null {
  if (!direccion || !ciudad) return null;
  const zs = SECTORES_POR_CIUDAD.get(ciudadBase(ciudad));
  if (!zs?.length) return null;
  const d = ' ' + strip(direccion).replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ') + ' ';
  let best: (SectorRaw & { toks: string[] }) | null = null;
  for (const z of zs) {
    if (!z.toks.every((t) => d.includes(' ' + t + ' '))) continue;
    if (!best || z.toks.length > best.toks.length) best = z;
  }
  if (!best) return null;
  const agencia = nombreAgencia(best.a);
  return {
    ciudad: best.c,
    sector: best.s,
    agencia,
    agenciaDetalle: AGENCIA_POR_CS.get(strip(best.a)) ?? null,
    agenciaAlternativa: nombreAgencia(best.b),
  };
}

// ───────────────────── Guía oficial de novedades por transportadora ─────────────────────

interface NovedadRaw { novedad: string; significado: string; responder: string; noHacer: string; obs: string }

export interface GuiaNovedad {
  transportadora: TransportadoraEC;
  /** El nombre de la novedad en la hoja de Dropi. */
  novedad: string;
  significado: string;
  comoResponder: string;
  queNoHacer: string;
  observaciones: string;
}

const STOP_NOV = new Set(['DE', 'DEL', 'LA', 'EL', 'LOS', 'LAS', 'Y', 'O', 'A', 'AL', 'EN', 'NO', 'SE', 'QUE', 'CON', 'POR', 'PARA', 'UN', 'UNA', 'SU', 'ES', 'HAY', 'HA', 'LE', 'LO', 'CLIENTE', 'DESTINATARIO', 'TITULAR', 'INDICA', 'PEDIDO']);
const tokensNov = (s: string): string[] =>
  strip(s)
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 3 && !STOP_NOV.has(w));

const GUIAS: Array<GuiaNovedad & { toks: Set<string>; key: string }> = [];
for (const [car, items] of Object.entries(novedadesRaw as Record<string, NovedadRaw[]>)) {
  const t = normalizarTransportadora(car);
  if (!t) continue;
  for (const n of items) {
    if (!n.novedad) continue;
    // La hoja mete varias causales en un mismo nombre («TITULAR SE NEGO A RECIBIR - No desea…»):
    // el nombre canónico es lo que va antes del primer guion.
    const key = strip(n.novedad.split(' - ')[0]).replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    GUIAS.push({
      transportadora: t,
      novedad: n.novedad,
      significado: n.significado,
      comoResponder: n.responder,
      queNoHacer: n.noHacer,
      observaciones: n.obs,
      toks: new Set(tokensNov(n.novedad)),
      key,
    });
  }
}

/**
 * La ficha oficial de Dropi para el texto de novedad que trae el pedido.
 * Primero por contención literal del nombre canónico; si no, por solapamiento
 * de palabras (Jaccard ≥ 0,5) dentro de la MISMA transportadora. Sin
 * transportadora reconocible busca en todas. null cuando no hay una ficha
 * clara — nunca se devuelve «la más parecida» a cualquier costo.
 */
export function guiaOficialNovedad(novedad: string | null | undefined, transportadora?: string | null): GuiaNovedad | null {
  const texto = strip(novedad ?? '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (texto.length < 3) return null;
  const car = normalizarTransportadora(transportadora);
  const cands = car ? GUIAS.filter((g) => g.transportadora === car) : GUIAS;
  if (!cands.length) return null;

  const literal = cands.filter((g) => g.key.length >= 6 && (texto.includes(g.key) || g.key.includes(texto)));
  if (literal.length) {
    literal.sort((a, b) => b.key.length - a.key.length);
    const { toks: _t, key: _k, ...g } = literal[0];
    return g;
  }

  const tt = new Set(tokensNov(texto));
  if (!tt.size) return null;
  let best: (typeof cands)[number] | null = null;
  let bestScore = 0;
  for (const g of cands) {
    let inter = 0;
    for (const w of tt) if (g.toks.has(w)) inter++;
    const union = tt.size + g.toks.size - inter;
    const score = union ? inter / union : 0;
    if (score > bestScore) { bestScore = score; best = g; }
  }
  if (!best || bestScore < 0.5) return null;
  const { toks: _t, key: _k, ...g } = best;
  return g;
}

/** Todas las novedades documentadas por Dropi para una transportadora (para listar/testear). */
export function novedadesDocumentadas(transportadora: string): string[] {
  const car = normalizarTransportadora(transportadora);
  if (!car) return [];
  return GUIAS.filter((g) => g.transportadora === car).map((g) => g.novedad);
}
