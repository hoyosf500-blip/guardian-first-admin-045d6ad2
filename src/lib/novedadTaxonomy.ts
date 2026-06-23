/**
 * Taxonomía de novedades: clasifica el TEXTO LIBRE del carrier (`orders.novedad`)
 * en una categoría fina + una "culpa" (a quién es atribuible) + si es genérica.
 *
 * Mismo patrón que `mapCategoria` (dropi-wallet-sync): normalizar (sin acentos,
 * mayúsculas) → tabla de reglas declarativa ordenada (la primera que matchea
 * gana) → catch-all genérico. 100% puro y determinista → testeable aislado.
 *
 * IMPORTANTE: este set de reglas es un PUNTO DE PARTIDA con vocabulario COD
 * conocido. Hay que afinarlo con el texto REAL de producción (Módulo 0: query
 * `SELECT novedad, COUNT(*) FROM orders GROUP BY novedad ORDER BY 2 DESC`) hasta
 * que el catch-all no-genérico baje del ~10%. Los tokens van SIN acentos porque
 * `norm()` los elimina.
 */

import { stripAccents } from './novedadGestion';

export type Culpa = 'datos_nuestros' | 'cliente' | 'transportadora' | 'generica';

export interface NovedadClass {
  /** Subtipo fino, ej. 'direccion_errada'. 'otro' cuando cae al catch-all. */
  categoria: string;
  culpa: Culpa;
  /** true cuando el texto no aporta info útil (vago/ruido) o no clasificó. */
  esGenerica: boolean;
}

export const CULPA_LABEL: Record<Culpa, string> = {
  datos_nuestros: 'Datos nuestros',
  cliente: 'Cliente',
  transportadora: 'Transportadora',
  generica: 'Sin info / genérica',
};

/** Orden estable para gráficos (de lo más accionable internamente a lo menos). */
export const CULPA_ORDER: Culpa[] = ['datos_nuestros', 'cliente', 'transportadora', 'generica'];

interface Rule {
  categoria: string;
  culpa: Culpa;
  /** Al menos uno de estos tokens (ya normalizados) presente. */
  any?: string[];
  /** Todos estos tokens presentes (combinable con `any`). */
  all?: string[];
}

/**
 * Ruido conocido: textos del carrier sin información útil. Se tratan como
 * genéricos (problema de calidad de dato del carrier, NO regla faltante).
 * En forma normalizada (mayúsculas, sin acentos).
 */
const GENERIC_NOISE = new Set<string>([
  '', '-', '--', '.', 'NA', 'N/A', 'NINGUNA', 'NINGUNO',
  'NOVEDAD', 'SIN NOVEDAD', 'NOVEDAD GENERADA', 'GESTION', 'GESTIONANDO',
  'EN GESTION', 'PENDIENTE', 'OTRO', 'OTROS', 'SIN INFORMACION',
]);

/**
 * Reglas ordenadas. `datos_nuestros` va primero porque es lo más accionable
 * internamente (si una novedad tiene señal de dirección/teléfono mal cargado,
 * priorizamos esa atribución).
 */
const RULES: Rule[] = [
  // ───────── datos_nuestros (lo corregible por nosotros) ─────────
  { categoria: 'direccion_errada', culpa: 'datos_nuestros', any: [
    'DIRECCION ERRADA', 'DIRECCION INCORRECTA', 'DIRECCION EQUIVOCADA',
    'DIRECCION NO EXISTE', 'NO EXISTE LA DIRECCION', 'DIRECCION NO CORRESPONDE',
    'MAL LA DIRECCION', 'DIRECCION MALA', 'DIRECCION ERRONEA',
  ] },
  { categoria: 'direccion_incompleta', culpa: 'datos_nuestros', any: [
    'DIRECCION INCOMPLETA', 'DIRECCION INSUFICIENTE', 'FALTA NOMENCLATURA',
    'SIN NOMENCLATURA', 'COMPLETAR DIRECCION', 'COMPLEMENTAR DIRECCION',
    'FALTA DIRECCION', 'FALTA COMPLEMENTO', 'FALTA INFORMACION DIRECCION',
  ] },
  { categoria: 'telefono_malo', culpa: 'datos_nuestros', any: [
    'TELEFONO ERRADO', 'TELEFONO EQUIVOCADO', 'TELEFONO ERRONEO', 'TELEFONO APAGADO',
    'NUMERO EQUIVOCADO', 'NUMERO ERRADO', 'NUMERO ERRONEO', 'NUMERO NO EXISTE',
    'TELEFONO NO EXISTE', 'TELEFONO FUERA', 'FUERA DE SERVICIO', 'NUMERO FUERA DE SERVICIO',
  ] },

  // ───────── cliente ─────────
  { categoria: 'no_responde', culpa: 'cliente', any: [
    'NO CONTESTA', 'NO CONTESTAN', 'NO RESPONDE', 'NO ATIENDE', 'BUZON',
    'NO CONTACTO', 'NO HUBO CONTACTO', 'NO SE LOGRA CONTACTO', 'ILOCALIZABLE',
    'NO SE LOGRO CONTACTAR', 'IMPOSIBLE CONTACTAR',
  ] },
  { categoria: 'rechaza', culpa: 'cliente', any: [
    'RECHAZA', 'RECHAZO', 'RECHAZADO POR CLIENTE', 'NO QUIERE', 'YA NO QUIERE',
    'YA NO LO QUIERE', 'CANCELA EL PEDIDO', 'CLIENTE CANCELA', 'NO DESEA', 'DESISTE',
    'NO LO PIDIO', 'NO REALIZO EL PEDIDO',
  ] },
  { categoria: 'sin_dinero', culpa: 'cliente', any: [
    'NO TIENE DINERO', 'SIN DINERO', 'NO TIENE EFECTIVO', 'SIN EFECTIVO',
    'SIN PLATA', 'NO TIENE PLATA', 'NO TIENE CON QUE PAGAR', 'NO TIENE PARA PAGAR',
    'NO TIENE COMPLETO', 'SIN FONDOS',
  ] },
  { categoria: 'ausente_reprograma', culpa: 'cliente', any: [
    'NO SE ENCONTRABA', 'NO ESTABA', 'AUSENTE', 'NADIE EN CASA', 'NO HABIA NADIE',
    'REPROGRAMA', 'REPROGRAMAR', 'REAGENDA', 'REAGENDAR', 'NUEVA FECHA',
    'VOLVER A INTENTAR', 'REINTENTAR', 'OTRO DIA', 'NO RECIBE HOY', 'SOLICITA OTRA FECHA',
  ] },

  // ───────── transportadora ─────────
  { categoria: 'sin_cobertura', culpa: 'transportadora', any: [
    'ZONA SIN COBERTURA', 'SIN COBERTURA', 'NO HAY COBERTURA', 'FUERA DE COBERTURA',
    'ZONA ROJA', 'ZONA PELIGROSA', 'ORDEN PUBLICO', 'ZONA DE DIFICIL ACCESO',
    'DIFICIL ACCESO', 'POBLACION SIN COBERTURA', 'NO SE CUBRE LA ZONA',
  ] },
  { categoria: 'demora', culpa: 'transportadora', any: [
    'DEMORA', 'DEMORADO', 'RETRASO', 'RETRASADO', 'REZAGAD', 'EN BODEGA',
    'PENDIENTE DE DESPACHO', 'NO SE DESPACHO', 'REPROGRAMADO POR TRANSPORT',
    'DEMORA EN RUTA', 'NO SALIO A REPARTO',
  ] },
  { categoria: 'danado', culpa: 'transportadora', any: [
    'DANAD', 'AVERIAD', 'ROTO', 'MAL ESTADO', 'DETERIORAD', 'PAQUETE DANADO',
    'PRODUCTO DANADO',
  ] },
  { categoria: 'perdido', culpa: 'transportadora', any: [
    'EXTRAVIAD', 'PERDID', 'NO APARECE EL PAQUETE', 'PAQUETE PERDIDO', 'SINIESTRO',
  ] },
  { categoria: 'oficina_cerrada', culpa: 'transportadora', any: [
    'OFICINA CERRADA', 'LOCAL CERRADO', 'ESTABLECIMIENTO CERRADO', 'NEGOCIO CERRADO',
    'PUNTO CERRADO', 'BODEGA CERRADA',
  ] },
];

function norm(text: string): string {
  return stripAccents(text).toUpperCase().replace(/\s+/g, ' ').trim();
}

function ruleMatches(n: string, r: Rule): boolean {
  if (r.all && !r.all.every((t) => n.includes(t))) return false;
  if (r.any && !r.any.some((t) => n.includes(t))) return false;
  return !!(r.all || r.any);
}

/**
 * Clasifica el texto de una novedad. Vacío/ruido/no-clasificable → genérica.
 */
export function classifyNovedad(text: string | null | undefined): NovedadClass {
  const n = norm(text || '');
  if (!n || n.length < 4 || GENERIC_NOISE.has(n)) {
    return { categoria: 'otro', culpa: 'generica', esGenerica: true };
  }
  for (const r of RULES) {
    if (ruleMatches(n, r)) {
      return { categoria: r.categoria, culpa: r.culpa, esGenerica: false };
    }
  }
  return { categoria: 'otro', culpa: 'generica', esGenerica: true };
}
