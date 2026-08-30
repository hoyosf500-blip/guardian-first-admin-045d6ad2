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
// Lo que Dropi escribe en `orders.novedad` NO siempre es el nombre de la causal de
// la hoja: para Servientrega EC trae el MOVIMIENTO («DEVUELTO DE DISTRIBUCION»,
// «ENVIO CON NOVEDAD», «NO RECLAMO EN OFICINA») y para LAAR viene vacío.
// Medido el 30-ago-2026 sobre las 119 novedades vivas de la tienda EC: 16 de 18
// de Servientrega y las 101 de LAAR no matcheaban ninguna ficha. Estos alias
// las cubren: o apuntan a la ficha oficial correcta, o dan una ficha sintética
// escrita con lo que la hoja de esa transportadora sí dice (intentos máximos,
// «solo volver a ofrecer = no efectiva», 5 días en agencia).
interface AliasNovedad { transportadora: TransportadoraEC; match: RegExp; fichaOficial?: string; sintetica?: Omit<GuiaNovedad, 'transportadora'> }
const ALIAS_NOVEDAD: AliasNovedad[] = [
  { transportadora: 'SERVIENTREGA', match: /NO RECLAM[OA] EN OFICINA|NO RETIRA/, fichaOficial: 'PARA RETIRO EN AGENCIA SERVIENTREGA' },
  { transportadora: 'SERVIENTREGA', match: /DEVOLUCION AL REMITENTE|DEVUELTO AL REMITENTE/, sintetica: {
    novedad: 'DEVOLUCION AL REMITENTE',
    significado: 'Servientrega ya inició la devolución del paquete a la bodega: la incidencia no admite solución.',
    comoResponder: 'No hay solución que enviar. Registrá la gestión acá y escribile al cliente por WhatsApp para saber qué pasó y ofrecerle recompra cuando el paquete vuelva.',
    queNoHacer: 'Prometerle al cliente que «lo vuelven a intentar»: el paquete ya va de regreso.',
    observaciones: 'Servientrega intenta máximo 2 veces; después de la segunda devuelve sola.',
  } },
  { transportadora: 'SERVIENTREGA', match: /DEVUELTO DE|DEVOLUCION DE DISTRIBUCION|ENVIO CON NOVEDAD/, sintetica: {
    novedad: 'DEVUELTO DE DISTRIBUCION / ENVIO CON NOVEDAD',
    significado: 'El motorizado salió a entregar y regresó con el paquete. Dropi trae solo el movimiento, NO la causal (no estaba, dirección, no quiso, sin dinero…).',
    comoResponder: 'Primero hablá con el cliente para saber qué pasó y recién ahí respondé con el formato de ESA causal: «Me he comunicado con el cliente al número ____ y me indica que ____ (día y hora en que recibe, quién recibe, dirección con referencia). No mayor a 24 horas». Si el cliente ya no quiere el pedido: Devolución.',
    queNoHacer: 'Responder «volver a ofrecer» sin haber hablado con el cliente: Servientrega lo toma como solución no efectiva y devuelve.',
    observaciones: 'Servientrega intenta máximo 2 veces. Si el problema es la zona, ofrecé retiro en la agencia más cercana.',
  } },
  { transportadora: 'LAARCOURIER', match: /^$/, sintetica: {
    novedad: 'NOVEDAD SIN MOTIVO (LAAR no lo reporta a Dropi)',
    significado: 'LAAR puso el pedido en NOVEDAD pero no le pasó a Dropi ni el motivo ni una incidencia abierta: en el panel de Dropi no aparece nada que solucionar.',
    comoResponder: 'Mirá el motivo en el rastreo de LAAR (guía LC…) y llamá al cliente. En Dropi no hay incidencia que responder: la gestión se registra acá, y el reintento o la devolución se ven después en el estado. Si el cliente no puede recibir, LAAR permite retiro en su oficina hasta 5 días.',
    queNoHacer: 'Dar por perdido el pedido o esperar a que Dropi avise: no va a avisar.',
    observaciones: 'LAAR intenta máximo 3 veces. Solución no mayor a 24 horas desde que se habla con el cliente.',
  } },
];

export function guiaOficialNovedad(novedad: string | null | undefined, transportadora?: string | null): GuiaNovedad | null {
  const texto = strip(novedad ?? '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const car = normalizarTransportadora(transportadora);
  for (const a of ALIAS_NOVEDAD) {
    if (car !== a.transportadora || !a.match.test(texto)) continue;
    if (a.sintetica) return { transportadora: a.transportadora, ...a.sintetica };
    const oficial = GUIAS.find((g) => g.transportadora === a.transportadora && strip(g.novedad).startsWith(strip(a.fichaOficial ?? '')));
    if (oficial) { const { toks: _t, key: _k, ...g } = oficial; return g; }
  }
  // ⛔ SIN TRANSPORTADORA RECONOCIDA NO SE ADIVINA (30-ago-2026).
  //
  // Antes esto era `car ? GUIAS.filter(...) : GUIAS`: sin transportadora se
  // buscaba en las CINCO hojas y ganaba el mejor puntaje. Resultado medido: una
  // novedad de un pedido que no va con Veloces mostraba «Guía oficial de Dropi —
  // VELOCES — "NO CONTESTA"», con las instrucciones, los plazos y la plantilla
  // de Veloces. La asesora respondía a Dropi con el formato equivocado.
  //
  // Es exactamente lo que el motor de CO/GT prohíbe a propósito
  // (`novedades/fichas.ts`: "Adivinar sería inventar"), con su prueba guardiana.
  // Ecuador quedó con la regla vieja y sin esa prueba.
  //
  // Devolver null es la respuesta honesta: la pantalla dice que no sabe qué
  // transportadora lleva el pedido, que es la verdad.
  if (!car || texto.length < 3) return null;
  const cands = GUIAS.filter((g) => g.transportadora === car);
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

// ───────────── Cobertura MEDIDA con los pedidos de la tienda ─────────────
//
// «Cada operación es diferente y ese Drive de Dropi es viejo» (dueño,
// 29-ago-2026). Auditado contra 11.450 pedidos de una tienda EC: de los 692
// sectores «sin cobertura» de la hoja, Servientrega entrega igual en la mayoría
// (45% en esos sectores contra 62% global — peor, pero lejos de «no llega») y
// LAAR entrega 70% en los mismos sectores. Solo 12 se confirmaron como «no
// llega» con los envíos reales. Conclusión: lo que dice Dropi es un AVISO; lo
// que manda es lo que ESTA tienda midió con sus propios pedidos. Acá va lo puro;
// el hook `useCoberturaMedida` trae las filas de la tienda activa.

export interface FilaEnvio {
  estado: string | null;
  transportadora: string | null;
  direccion: string | null;
}

export type VeredictoCobertura = 'no_llega' | 'regular' | 'entregamos' | 'sin_dato';

export interface CoberturaMedida {
  entregados: number;
  devueltos: number;
  /** entregados + devueltos: los que ya terminaron. Cancelados y en ruta no cuentan. */
  terminales: number;
  /** entregados / terminales, o null sin terminales. */
  tasa: number | null;
  /** Con menos de 3 terminales no se afirma nada: `sin_dato` (un 0 de 1 no es «no llega»). */
  veredicto: VeredictoCobertura;
  porTransportadora: Array<{ transportadora: string; entregados: number; devueltos: number }>;
  /** Transportadora con la que SÍ se entrega ahí (≥2 terminales y ≥60%), o null. */
  mejorAlternativa: string | null;
}

/** Dirección que en realidad es un retiro en agencia: no mide cobertura a domicilio. */
const ES_RETIRO = /RETIR[OA]\s*CS|CLIENTE RETIRA|RETIRA\s*:|(?:OFICINA|AGENCIA) DE SERVI/i;

/**
 * Patrones ILIKE para pescar candidatos en la base: las dos palabras más largas
 * del sector con cada vocal (y la N, por la Ñ) reemplazada por `_` — así
 * «BASTION» y «BASTIÓN» caen los dos (20 de 31 direcciones de Bastión Popular
 * llevan tilde y Postgres no la ignora). Trae de más a propósito: el filtro fino
 * lo hace `medirCobertura` con `sectorSinCobertura` sobre lo que vuelve.
 */
export function patronesIlikeSector(sector: string): string[] {
  const toks = tokensSector(sector)
    .filter((t) => /^[A-Z]{3,}$/.test(t))
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);
  return toks.map((t) => '%' + t.replace(/[AEIOUN]/g, '_') + '%');
}

/**
 * Qué pasó de verdad con los envíos de la tienda a ese sector. Puro: recibe las
 * filas (ya acotadas por ciudad y por patrón) y se queda solo con las que
 * `sectorSinCobertura` confirma como ESE sector, a domicilio, y terminadas.
 */
export function medirCobertura(filas: FilaEnvio[], ciudad: string, sector: string): CoberturaMedida {
  const objetivo = strip(sector);
  const porT = new Map<string, { entregados: number; devueltos: number }>();
  let entregados = 0;
  let devueltos = 0;
  for (const f of filas) {
    if (!f.direccion || ES_RETIRO.test(f.direccion)) continue;
    const z = sectorSinCobertura(f.direccion, ciudad);
    if (!z || strip(z.sector) !== objetivo) continue;
    const est = strip(f.estado ?? '');
    const r = est === 'ENTREGADO' ? 'e' : est.startsWith('DEVOLUCION') ? 'd' : null;
    if (!r) continue;
    const t = normalizarTransportadora(f.transportadora) ?? (strip(f.transportadora ?? '') || 'SIN TRANSPORTADORA');
    const c = porT.get(t) ?? { entregados: 0, devueltos: 0 };
    if (r === 'e') { c.entregados++; entregados++; } else { c.devueltos++; devueltos++; }
    porT.set(t, c);
  }
  const terminales = entregados + devueltos;
  const tasa = terminales ? entregados / terminales : null;
  const veredicto: VeredictoCobertura =
    terminales < 3 ? 'sin_dato' : (tasa as number) >= 0.6 ? 'entregamos' : (tasa as number) >= 0.45 ? 'regular' : 'no_llega';
  const porTransportadora = [...porT.entries()]
    .map(([transportadora, c]) => ({ transportadora, ...c }))
    .sort((a, b) => (b.entregados + b.devueltos) - (a.entregados + a.devueltos));
  const rate = (c: { entregados: number; devueltos: number }) => c.entregados / (c.entregados + c.devueltos);
  const candidatas = porTransportadora
    .filter((c) => c.entregados + c.devueltos >= 2 && rate(c) >= 0.6)
    .sort((a, b) => rate(b) - rate(a));
  return {
    entregados, devueltos, terminales, tasa, veredicto, porTransportadora,
    mejorAlternativa: candidatas[0]?.transportadora ?? null,
  };
}

// ───────────── Plantilla de solución según la guía oficial ─────────────
//
// Dropi pide que la solución de una novedad diga QUÉ acordó la tienda con el
// cliente (número, día, quién recibe, dirección con referencia); «solo VOLVER A
// OFRECER» cuenta como solución no efectiva. Las hojas «Estados y Novedades»
// traen un ejemplo por novedad con asteriscos donde va el dato. Esto convierte
// ese ejemplo en un borrador con el teléfono del pedido puesto y huecos `____`
// para lo que solo la asesora sabe. Gintracom limita la solución a 50
// caracteres: ahí el borrador es corto por diseño.

export interface PlantillaSolucion {
  texto: string;
  /** Tope de caracteres que acepta la transportadora (Gintracom 50; el resto sin tope práctico). */
  maximo: number;
  /** De dónde salió: la ficha oficial de esa novedad o el genérico de la transportadora. */
  origen: 'oficial' | 'generica';
}

const NOVEDAD_LIMITE: Partial<Record<TransportadoraEC, number>> = { GINTRACOM: 50 };

export function plantillaSolucion(
  guia: GuiaNovedad | null,
  pedido: { phone?: string | null; nombre?: string | null; direccion?: string | null },
  transportadora?: string | null,
): PlantillaSolucion {
  const t = guia?.transportadora ?? normalizarTransportadora(transportadora) ?? null;
  const maximo = (t && NOVEDAD_LIMITE[t]) || 500;
  const tel = (pedido.phone ?? '').trim() || '____';
  const nombre = (pedido.nombre ?? '').trim() || '____';
  const responder = (guia?.comoResponder ?? '').replace(/\s+/g, ' ').trim();
  // Ejemplo literal («Me he comunicado con el cliente al numero ****…»): se rellena.
  if (guia && /^me he comunicado/i.test(responder)) {
    let texto = responder
      .replace(/\((?:no mayor|una vez|se reconfirma|confirmando|agregar|direccion)[^)]*\)/gi, '') // notas para la asesora, no para la transportadora
      .replace(/\*{3,}/, tel)          // el primer grupo de asteriscos es el teléfono del pedido
      .replace(/preguntar por \*+/i, `preguntar por ${nombre}`)
      .replace(/\*{3,}/g, '____')
      .replace(/x{3,}/gi, '____')
      .replace(/…+|\.\.\./g, '____')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.])/g, '$1')
      .trim();
    if (texto.length > maximo) texto = texto.slice(0, maximo);
    return { texto, maximo, origen: 'oficial' };
  }
  // Instrucción (Gintracom: «Ingresar nueva fecha… máximo 50 caracteres»): borrador corto.
  if (t === 'GINTRACOM') {
    return { texto: `Cliente confirma recibir el ____ en ${pedido.direccion ? 'la dirección' : '____'}`.slice(0, maximo), maximo, origen: guia ? 'oficial' : 'generica' };
  }
  const texto = `Me he comunicado con el cliente al numero ${tel} y me indica que ____ (día y hora en que recibe, quién recibe, dirección con referencia). No mayor a 24 horas.`;
  return { texto, maximo, origen: guia ? 'oficial' : 'generica' };
}
