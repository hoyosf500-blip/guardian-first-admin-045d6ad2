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

/**
 * ⛔ `generica` y `sin_clasificar` SON DISTINTOS (30-ago-2026).
 *
 * Antes había un solo bucket, rotulado «Sin info / genérica» con el subtítulo
 * *"el carrier no dice el motivo"*. Medido contra el diccionario oficial de
 * Colombia: 51 de 66 novedades caían ahí — o sea que un hueco en NUESTRAS
 * reglas se pintaba como una acusación a la transportadora, y el dueño leía
 * que «la transportadora no informa» y que no hay nada que corregir del lado
 * propio. Justo al revés.
 *
 *  - `generica`       = el carrier de verdad no dijo nada («-», «NOVEDAD»,
 *                       «SIN INFORMACION»). Culpa suya, dato imposible.
 *  - `sin_clasificar` = el carrier SÍ dijo algo y Guardian no supo leerlo.
 *                       Es una regla que falta acá, no un problema de nadie más.
 */
export type Culpa = 'datos_nuestros' | 'cliente' | 'transportadora' | 'generica' | 'sin_clasificar' | 'no_es_novedad';

export interface NovedadClass {
  /** Subtipo fino, ej. 'direccion_errada'.
   *  Dos catch-alls DISTINTOS, y tienen que serlo: `sin_texto` (el carrier no
   *  escribió nada) y `otro` (escribió algo y no lo supimos leer). Con el mismo
   *  valor, la tabla «Motivos más frecuentes» mostraba DOS filas idénticas
   *  llamadas «Sin clasificar» — visto en producción el 30-ago (120 y 8). */
  categoria: string;
  culpa: Culpa;
  /** true cuando el texto no aporta info útil (vago/ruido) o no clasificó. */
  esGenerica: boolean;
}

export const CULPA_LABEL: Record<Culpa, string> = {
  datos_nuestros: 'Datos nuestros',
  cliente: 'Cliente',
  transportadora: 'Transportadora',
  generica: 'El carrier no dijo el motivo',
  sin_clasificar: 'Todavía no clasificado',
  no_es_novedad: 'No es una novedad',
};

/** El subtítulo honesto de cada bucket. `sin_clasificar` NO acusa a nadie: dice
 *  lo que es, un hueco nuestro que se cierra agregando la regla. */
export const CULPA_HINT: Record<Culpa, string> = {
  datos_nuestros: 'la dirección o el teléfono que cargamos',
  cliente: 'el cliente no recibió o no pagó',
  transportadora: 'zona, demora o daño del envío',
  generica: 'el texto del carrier viene vacío o sin contenido',
  sin_clasificar: 'el carrier sí dijo algo y todavía no sabemos leerlo — falta la regla, no es culpa de nadie',
  no_es_novedad: 'es un estado normal del envío (en ruta, entregado): no hay nada que resolver',
};

/** Orden estable para gráficos (de lo más accionable internamente a lo menos). */
export const CULPA_ORDER: Culpa[] = ['datos_nuestros', 'cliente', 'transportadora', 'generica', 'sin_clasificar', 'no_es_novedad'];

/** Los buckets que SÍ son novedades. `no_es_novedad` queda fuera del
 *  denominador: contar un «EN RUTA» como novedad distorsiona toda la tasa. */
export const CULPA_ORDER_REAL: Culpa[] = ['datos_nuestros', 'cliente', 'transportadora', 'generica', 'sin_clasificar'];

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
  // ═══════════════════════════════════════════════════════════════════════
  // PRIMERO: lo que NO es una novedad (30-ago-2026).
  //
  // En Guatemala no existe diccionario de novedades de Dropi, así que el campo
  // trae el ESTADO del envío que publica la transportadora: 20 de las 23
  // fichas GT son «SOLICITADO», «EN RUTA», «ENTREGADO», «RECOLECTADO»…
  // Contarlas como novedades infla el denominador de toda la pantalla, y
  // mandarlas al bucket genérico las convertía en una acusación al carrier por
  // hacer bien su trabajo.
  //
  // Va PRIMERO para que un estado no matchee por casualidad una regla de abajo
  // («DEVOLUCION EN PROCESO» sí es novedad; «DEVOLUCION ENTREGADA» no).
  // ═══════════════════════════════════════════════════════════════════════
  { categoria: 'estado_de_flujo', culpa: 'no_es_novedad', any: [
    'SOLICITADO', 'ARRIBO A LAS INSTALACIONES', 'EN INVENTARIO', 'EN RUTA',
    'PROGRAMADO PARA ENTREGA', 'GUIA REVERTIDA', 'PENDIENTE DE RECOLECTAR',
    'RECOLECTADO', 'RUTA BODEGA DESTINO', 'RUTA ENTREGA FINAL',
    'EN AGENCIA SIN RECOGER', 'DEVOLUCION ENTREGADA', 'ENTREGADO LIQUIDADO',
    'ENTREGADO EN EXPRESS CENTER', 'COD PAGADO', 'EN PUNTO DROOP',
  ] },
  { categoria: 'estado_de_flujo', culpa: 'no_es_novedad', all: ['ENTREGADO'] },
  { categoria: 'estado_de_flujo', culpa: 'no_es_novedad', all: ['DEVUELTO'] },

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
    'PUNTO CERRADO', 'BODEGA CERRADA', 'CERRADO SEGUNDA VEZ', 'CERRADO PRIMERA VEZ',
  ] },

  // ═══════════════════════════════════════════════════════════════════════
  // NOMBRES CANÓNICOS DE COLOMBIA (30-ago-2026)
  //
  // Las reglas de arriba se escribieron con vocabulario COD genérico y se
  // probaron con texto de ECUADOR — el encabezado de este archivo lo declara
  // "PUNTO DE PARTIDA" pendiente de afinar. Nadie lo afinó al abrir Colombia:
  // medido contra `dropiColombia/novedadesOficiales.json`, 51 de sus 66
  // novedades caían en el catch-all.
  //
  // Estas salen de la lista OFICIAL, tal cual la escribe cada transportadora.
  // Van DESPUÉS de las genéricas a propósito: una que ya matchea arriba no
  // cambia de categoría (el histórico no se reclasifica solo).
  //
  // ⛔ Las de dirección usan `all[]` (tokens sueltos), no la frase pegada:
  // «DIRECCIÓN DESTINATARIO NO EXISTE» NO contiene «DIRECCION NO EXISTE», y esa
  // palabra intercalada era la que rompía el match. Es el defecto de fondo, no
  // solo la falta de entradas.
  // ═══════════════════════════════════════════════════════════════════════

  // ───────── datos_nuestros ─────────
  // Nadie conoce al cliente en esa dirección = la dirección que cargamos está mal.
  { categoria: 'destinatario_desconocido', culpa: 'datos_nuestros', any: [
    'NO LO CONOCEN', 'NO CONOCEN AL DESTINATARIO', 'NO CONOCEN DESTINATARIO',
    'NO CONOCEN EL DESTINATARIO', 'DESTINATARIO DESCONOCIDO',
  ] },
  { categoria: 'cliente_se_mudo', culpa: 'datos_nuestros', any: [
    'SE TRASLADO', 'SE MUDO', 'YA NO VIVE', 'CAMBIO DE DOMICILIO',
  ] },
  { categoria: 'direccion_errada', culpa: 'datos_nuestros', all: ['DIRECCION', 'NO EXISTE'] },
  { categoria: 'direccion_errada', culpa: 'datos_nuestros', all: ['NO SE LOCALIZA', 'DIRECCION'] },
  { categoria: 'direccion_errada', culpa: 'datos_nuestros', all: ['DIRECCION', 'OTRA CIUDAD'] },
  { categoria: 'direccion_incompleta', culpa: 'datos_nuestros', all: ['DIRECCION', 'INCOMPLETA'] },
  { categoria: 'direccion_incompleta', culpa: 'datos_nuestros', all: ['SIN DIRECCION'] },
  { categoria: 'direccion_incompleta', culpa: 'datos_nuestros', any: [
    'DATOS ADICIONALES A LA DIRECCION',
  ] },
  // El paquete salió mal de nuestro lado (o del proveedor), no del carrier.
  { categoria: 'error_de_despacho', culpa: 'datos_nuestros', any: [
    'NO COINCIDE LA MERCANCIA', 'NO COINCIDE MERCANCIA',
    'RETENCION POR ORDEN DEL REMITENTE',
  ] },

  // ───────── cliente ─────────
  { categoria: 'rechaza', culpa: 'cliente', any: [
    'SE NEGO A RECIBIR', 'SE NIEGA A RECIBIR', 'SE REHUSA A RECIBIR',
    'NO SOLICITADA', 'NO SOLICITADO', 'PEDIDO REPETIDO', 'PEDIDO CANCELADO',
    'POR SOLICITUD DEL CLIENTE',
  ] },
  // Miedo, no rechazo — el protocolo del bot lo trata distinto: es rescatable.
  { categoria: 'desconfia', culpa: 'cliente', any: [
    'DESCONFIANZA', 'DESCONFIA', 'NO CONFIA', 'CREE QUE ES ESTAFA',
  ] },
  { categoria: 'sin_dinero', culpa: 'cliente', any: [
    'NO CANCELA', 'NO TIENE EL DINERO', 'NO PAGA EL VALOR',
  ] },
  { categoria: 'ausente_reprograma', culpa: 'cliente', any: [
    'NO HAY QUIEN RECIBA', 'FIJA FECHA Y HORA',
  ] },
  { categoria: 'cita_previa', culpa: 'cliente', any: [
    'CITA PREVIA', 'CITA PROGRAMADA', 'AGENDAR CITA', 'SOLICITAR CITA',
  ] },
  { categoria: 'exige_inventario', culpa: 'cliente', any: [
    'SOLICITA INVENTARIO', 'EXIGE INVENTARIO', 'UNIDADES SELLADAS',
  ] },
  { categoria: 'cambio_direccion', culpa: 'cliente', any: [
    'SOLICITA OTRA DIRECCION', 'ENTREGADA EN OTRA DIRECCION',
    'ENTREGADO EN OTRA DIRECCION',
  ] },
  { categoria: 'no_retira', culpa: 'cliente', any: [
    'NO RECLAMO EN OFICINA', 'NO RETIRO', 'NO PASO A RECLAMAR',
  ] },

  // ───────── transportadora ─────────
  { categoria: 'sin_cobertura', culpa: 'transportadora', all: ['NO SE CUBRE'] },
  { categoria: 'intento_fallido', culpa: 'transportadora', any: [
    'SE VISITA, NO SE LOGRA ENTREGA', 'NO SE LOGRA ENTREGA', 'INTENTO DE ENTREGA',
  ] },
  { categoria: 'en_oficina', culpa: 'transportadora', any: [
    'RECLAMAR EN PUNTO DROOP', 'RECLAME EN OFICINA', 'PARA RECLAMAR EN OFICINA',
    'RECLAMO EN OFICINA', 'ENTREGA EN OFICINA',
  ] },
  { categoria: 'rezonificar', culpa: 'transportadora', any: [
    'REZONIFICAR', 'REDIRECCIONADO', 'REEXPEDICION',
  ] },
  { categoria: 'retenido', culpa: 'transportadora', any: [
    'RETENIDA POR LA ADUANA', 'RETENIDO POR ADUANA', 'DIAN',
  ] },
  { categoria: 'devolucion_en_curso', culpa: 'transportadora', any: [
    'DEVOLUCION EN PROCESO', 'DECLARADO PARA DEVOLUCION',
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
  // El carrier NO dijo nada: culpa suya, y el dato no existe.
  if (!n || n.length < 4 || GENERIC_NOISE.has(n)) {
    return { categoria: 'sin_texto', culpa: 'generica', esGenerica: true };
  }
  for (const r of RULES) {
    if (ruleMatches(n, r)) {
      return { categoria: r.categoria, culpa: r.culpa, esGenerica: false };
    }
  }
  // ⛔ El carrier SÍ escribió algo y no lo supimos leer. NO es `generica`:
  // meterlo en el mismo bucket convertía un hueco de reglas en una acusación a
  // la transportadora, y era el bucket dominante en Colombia.
  // Este número es el KPI del módulo: baja agregando reglas, no ignorándolo.
  return { categoria: 'otro', culpa: 'sin_clasificar', esGenerica: true };
}
