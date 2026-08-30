/**
 * Motor genérico de fichas de novedades para los países que NO son Ecuador.
 *
 * Ecuador tiene su propio módulo (`dropiEcuador/logisticaOficial.ts`) con
 * alias y fichas sintéticas nacidas de incidentes reales; no se toca. Este
 * archivo hace lo mismo que su matcher (contención literal del nombre canónico
 * y, si no, solapamiento de palabras ≥ 0,5 dentro de la MISMA transportadora)
 * sobre un JSON por país con una forma un poco más rica: cada ficha trae su
 * FUENTE y su CONFIANZA, porque estas hojas no salieron del Drive que Dropi le
 * compartió a la tienda sino de una investigación verificada (30-ago-2026):
 * el «Diccionario de Novedades» de Dropi Colombia (copias en Scribd) para
 * Servientrega, Coordinadora y Envía; las hojas de estatus de Dropi para
 * Interrapidísimo y Veloces; y, en Guatemala, los términos publicados por las
 * transportadoras. Un verificador adversarial abrió cada fuente; lo que no
 * pudo respaldar quedó AFUERA del JSON, y cuando solo el significado estaba
 * respaldado la respuesta se dejó vacía (`respuestaPublicada: false`) para que
 * la pantalla diga «la transportadora no publica cómo responder» en vez de
 * inventar una.
 */

export interface FichaRaw {
  novedad: string;
  significado: string;
  responder: string;
  noHacer: string;
  obs: string;
  fuente: string;
  confianza: 'oficial' | 'secundaria';
}
export interface TransportadoraRaw {
  nombre: string;
  retiroEnOficina: string;
  intentosMax: string;
  fichas: FichaRaw[];
}
export interface GuiaPaisRaw {
  pais: string;
  transportadoras: Record<string, TransportadoraRaw>;
  transversal: { fichas: FichaRaw[]; oficina: string } | null;
  fuentes: string[];
}

/** Lo que muestra la pantalla. Compatible campo a campo con `GuiaNovedad` de
 *  Ecuador, más la fuente y si la respuesta está publicada. */
export interface GuiaNovedadPais {
  transportadora: string;
  novedad: string;
  significado: string;
  comoResponder: string;
  queNoHacer: string;
  observaciones: string;
  fuente: string;
  confianza: 'oficial' | 'secundaria';
  respuestaPublicada: boolean;
}

export interface NotasTransportadora {
  nombre: string;
  retiroEnOficina: string;
  intentosMax: string;
}

const strip = (s: string) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const STOP = new Set(['DE', 'DEL', 'LA', 'EL', 'LOS', 'LAS', 'Y', 'O', 'A', 'AL', 'EN', 'NO', 'SE', 'QUE', 'CON', 'POR', 'PARA', 'UN', 'UNA', 'SU', 'ES', 'HAY', 'HA', 'LE', 'LO', 'CLIENTE', 'DESTINATARIO', 'TITULAR', 'INDICA', 'PEDIDO']);
const tokens = (s: string) => strip(s).replace(/[^A-Z0-9 ]/g, ' ').split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
const canon = (s: string) => strip(s).replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

interface Indexada { guia: GuiaNovedadPais; keys: string[]; toks: Set<string> }

export interface MotorPais {
  normalizar: (transportadora: string | null | undefined) => string | null;
  guia: (novedad: string | null | undefined, transportadora?: string | null) => GuiaNovedadPais | null;
  notas: (transportadora: string | null | undefined) => NotasTransportadora | null;
  transversal: () => FichaRaw[];
  documentadas: (transportadora: string) => string[];
}

/**
 * Arma el motor para un país. `normalizar` decide a qué clave del JSON va cada
 * `orders.transportadora` (el texto de Dropi varía: «INTER RAPIDISIMO»,
 * «Envia», «SERVIENTREGA S.A.»).
 */
export function motorPais(raw: GuiaPaisRaw, normalizar: MotorPais['normalizar']): MotorPais {
  const indice = new Map<string, Indexada[]>();
  for (const [clave, t] of Object.entries(raw.transportadoras)) {
    const lista: Indexada[] = [];
    for (const f of t.fichas) {
      if (!f.novedad) continue;
      // «RECLAME EN OFICINA / PARA RECLAMAR EN OFICINA» → dos nombres canónicos;
      // «TITULAR SE NEGÓ A RECIBIR - No desea…» → lo de antes del guion.
      const keys = f.novedad.split(' / ').map((k) => canon(k.split(' - ')[0])).filter((k) => k.length >= 4);
      lista.push({
        guia: {
          transportadora: clave,
          novedad: f.novedad,
          significado: f.significado,
          comoResponder: f.responder,
          queNoHacer: f.noHacer,
          observaciones: f.obs,
          fuente: f.fuente,
          confianza: f.confianza,
          respuestaPublicada: f.responder.trim().length > 0,
        },
        keys,
        toks: new Set(tokens(f.novedad)),
      });
    }
    indice.set(clave, lista);
  }

  const guia: MotorPais['guia'] = (novedad, transportadora) => {
    const texto = canon(novedad ?? '');
    const car = normalizar(transportadora);
    // Sin transportadora reconocida NO se busca en todas: en Colombia cinco
    // transportadoras comparten nombres de novedad («DIRECCIÓN ERRADA») con
    // plazos e instrucciones distintas. Adivinar sería inventar.
    if (!car || texto.length < 3) return null;
    const cands = indice.get(car) ?? [];
    if (!cands.length) return null;
    const literal = cands
      .map((c) => ({ c, key: c.keys.find((k) => k.length >= 6 && (texto.includes(k) || k.includes(texto))) }))
      .filter((x) => x.key);
    if (literal.length) {
      literal.sort((a, b) => (b.key as string).length - (a.key as string).length);
      return literal[0].c.guia;
    }
    const tt = new Set(tokens(texto));
    if (!tt.size) return null;
    let best: Indexada | null = null;
    let bestScore = 0;
    for (const c of cands) {
      let inter = 0;
      for (const w of tt) if (c.toks.has(w)) inter++;
      const union = tt.size + c.toks.size - inter;
      const score = union ? inter / union : 0;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best && bestScore >= 0.5 ? best.guia : null;
  };

  return {
    normalizar,
    guia,
    notas: (transportadora) => {
      const car = normalizar(transportadora);
      const t = car ? raw.transportadoras[car] : undefined;
      if (!t) return null;
      return { nombre: t.nombre, retiroEnOficina: t.retiroEnOficina, intentosMax: t.intentosMax };
    },
    transversal: () => raw.transversal?.fichas ?? [],
    documentadas: (transportadora) => {
      const car = normalizar(transportadora);
      return car ? (raw.transportadoras[car]?.fichas ?? []).map((f) => f.novedad) : [];
    },
  };
}

export function normalizarCO(t: string | null | undefined): string | null {
  const s = strip(t ?? '');
  if (!s) return null;
  if (s.includes('INTER')) return 'INTERRAPIDISIMO';
  if (s.includes('SERVI')) return 'SERVIENTREGA';
  if (s.includes('COORD')) return 'COORDINADORA';
  if (s.includes('ENVIA') || s.includes('COLVANES')) return 'ENVIA';
  if (s.includes('VELOC')) return 'VELOCES';
  if (s.includes('TCC')) return 'TCC';
  if (s.includes('DOMINA')) return 'DOMINA';
  return null;
}

export function normalizarGT(t: string | null | undefined): string | null {
  const s = strip(t ?? '');
  if (!s) return null;
  if (s.includes('FORZA')) return 'FORZA';
  if (s.includes('CARGO')) return 'CARGO EXPRESO';
  if (s.includes('GUATEX')) return 'GUATEX';
  return null;
}
