import {
  guiaOficialNovedad as guiaEC,
  plantillaSolucion as plantillaEC,
  type GuiaNovedad,
  type PlantillaSolucion,
} from '@/lib/dropiEcuador/logisticaOficial';
import {
  motorPais, normalizarCO, normalizarGT,
  type GuiaNovedadPais, type GuiaPaisRaw, type NotasTransportadora, type FichaRaw,
} from './fichas';
import coRaw from '@/lib/dropiColombia/novedadesOficiales.json';
import gtRaw from '@/lib/dropiGuatemala/novedadesOficiales.json';

/**
 * Novedades por PAÍS — el enchufe que faltaba (30-ago-2026).
 *
 * Pedido del dueño: *"hazlo también con las novedades: colocalo en todos los
 * dueños y países, que mis tiendas de Colombia puedan resolverlas también"*.
 *
 * Hasta hoy la ficha oficial (qué significa la novedad, cómo responder en el
 * panel de Dropi, qué NO hacer) y el borrador de solución existían SOLO para
 * Ecuador, y `NovedadView` los escondía con `esEC`. El envío de la solución a
 * Dropi (`dropi-resolve-incidence`) ya era multi-país: el host sale de
 * `dropiHostFor(country_code)` en `_shared/dropiStoreConfig.ts`. Lo que estaba
 * atado a Ecuador era la GUÍA, no el botón.
 *
 * Reglas de este módulo:
 * - **Nunca «la más parecida».** Un país sin ficha para esa novedad devuelve
 *   `null` y la pantalla lo dice. Mostrarle a una asesora colombiana la ficha
 *   de Servientrega ECUADOR (plazos, agencias, intentos distintos) sería
 *   inventar. Cada país busca SOLO en sus propias hojas.
 * - **La plantilla de solución siempre existe**, en el formato que Dropi acepta
 *   en ese país: Ecuador «Me he comunicado con el cliente al número … y me
 *   indica que …»; Colombia «OFRECER A LA DIRECCIÓN … BARRIO …» / «CLIENTE
 *   DESEA RECIBIR EL PAQUETE» (los ejemplos del Diccionario de Novedades de
 *   Dropi CO — el formato ecuatoriano no aparece en ninguna fuente colombiana).
 * - **Cada ficha dice de dónde salió.** Ecuador: el Drive oficial que Dropi le
 *   compartió a la tienda. Colombia/Guatemala: investigación verificada fuente
 *   por fuente (ver `fichas.ts`); lo no respaldado no está en el JSON.
 */

export type PaisNovedades = 'EC' | 'CO' | 'GT';
export type GuiaNovedadCualquiera = GuiaNovedad | GuiaNovedadPais;

interface ProveedorPais {
  guia: (novedad: string | null | undefined, transportadora?: string | null) => GuiaNovedadCualquiera | null;
  plantilla: (
    guia: GuiaNovedadCualquiera | null,
    pedido: { phone?: string | null; nombre?: string | null; direccion?: string | null },
    transportadora?: string | null,
  ) => PlantillaSolucion;
  notas: (transportadora: string | null | undefined) => NotasTransportadora | null;
  transversal: () => FichaRaw[];
  /** De dónde salen las fichas, para decirlo en pantalla. '' = sin hojas. */
  fuente: string;
}

const motorCO = motorPais(coRaw as GuiaPaisRaw, normalizarCO);
const motorGT = motorPais(gtRaw as GuiaPaisRaw, normalizarGT);

/** Interrapidísimo acepta ~120 caracteres de solución (cartelera de
 *  Efficommerce, fuente secundaria): quedarse por debajo no cuesta nada;
 *  pasarse puede cortar el texto en el panel. */
const LIMITE_CO: Record<string, number> = { INTERRAPIDISIMO: 120 };

function plantillaCO(
  pedido: { phone?: string | null; nombre?: string | null; direccion?: string | null },
  transportadora?: string | null,
): PlantillaSolucion {
  const car = normalizarCO(transportadora);
  const maximo = (car && LIMITE_CO[car]) || 500;
  const tel = (pedido.phone ?? '').trim() || '____';
  const nombre = (pedido.nombre ?? '').trim() || '____';
  const dir = (pedido.direccion ?? '').trim() || '____';
  let texto = maximo <= 120
    ? `OFRECER A LA DIRECCIÓN ${dir} BARRIO ____. Recibe el ____. Tel ${tel}.`
    : `OFRECER A LA DIRECCIÓN ${dir} BARRIO ____, CIUDAD ____. Cliente ${nombre} confirma que recibe el ____ (día y franja). Tel ${tel}.`;
  if (texto.length > maximo) texto = texto.slice(0, maximo);
  return { texto, maximo, origen: 'generica' };
}

function plantillaGT(
  pedido: { phone?: string | null; nombre?: string | null; direccion?: string | null },
): PlantillaSolucion {
  const tel = (pedido.phone ?? '').trim() || '____';
  const nombre = (pedido.nombre ?? '').trim() || '____';
  const dir = (pedido.direccion ?? '').trim() || '____';
  return {
    texto: `Cliente ${nombre} (${tel}) confirma recibir el ____ en ${dir} (referencia: ____).`,
    maximo: 500,
    origen: 'generica',
  };
}

const PROVEEDORES: Record<PaisNovedades, ProveedorPais> = {
  EC: {
    guia: guiaEC,
    // La ficha que llega acá la produjo `guiaEC` (transportadora EC-tipada):
    // se le devuelve tal cual al módulo ecuatoriano.
    plantilla: (g, pedido, transportadora) => plantillaEC(g as GuiaNovedad | null, pedido, transportadora),
    notas: () => null,
    transversal: () => [],
    fuente: 'Hojas «Estados y Novedades» de Dropi Ecuador (Drive oficial, ago-2026)',
  },
  CO: {
    guia: motorCO.guia,
    plantilla: (_g, pedido, transportadora) => plantillaCO(pedido, transportadora),
    notas: motorCO.notas,
    transversal: motorCO.transversal,
    fuente: 'Diccionario de Novedades de Dropi Colombia (Servientrega, Coordinadora, Envía) y hojas de estatus de Dropi (Interrapidísimo, Veloces), verificados fuente por fuente el 30-ago-2026',
  },
  GT: {
    guia: motorGT.guia,
    plantilla: (_g, pedido) => plantillaGT(pedido),
    notas: motorGT.notas,
    transversal: motorGT.transversal,
    fuente: 'Términos y estados publicados por Forza Delivery, Cargo Expreso y Guatex (no existe guía pública de Dropi Guatemala), verificados el 30-ago-2026',
  },
};

export function paisNovedades(countryCode: string | null | undefined): PaisNovedades {
  const c = String(countryCode || 'CO').toUpperCase();
  return c === 'EC' || c === 'GT' ? c : 'CO';
}

export function guiaNovedadPorPais(
  countryCode: string | null | undefined,
  novedad: string | null | undefined,
  transportadora?: string | null,
): GuiaNovedadCualquiera | null {
  return PROVEEDORES[paisNovedades(countryCode)].guia(novedad, transportadora);
}

export function plantillaSolucionPorPais(
  countryCode: string | null | undefined,
  guia: GuiaNovedadCualquiera | null,
  pedido: { phone?: string | null; nombre?: string | null; direccion?: string | null },
  transportadora?: string | null,
): PlantillaSolucion {
  return PROVEEDORES[paisNovedades(countryCode)].plantilla(guia, pedido, transportadora);
}

/** Lo que se sabe de la transportadora en ese país (oficina, intentos), con
 *  fuente detrás. null cuando no hay nada respaldado. */
export function notasTransportadoraPorPais(
  countryCode: string | null | undefined,
  transportadora: string | null | undefined,
): NotasTransportadora | null {
  return PROVEEDORES[paisNovedades(countryCode)].notas(transportadora);
}

/** Reglas transversales de Dropi para ese país (Colombia: mecánica del panel,
 *  los 12 tips de Dropi, plazos por transportadora). Vacío si no hay. */
export function reglasTransversalesPorPais(countryCode: string | null | undefined): FichaRaw[] {
  return PROVEEDORES[paisNovedades(countryCode)].transversal();
}

/** Si el país tiene hojas cargadas (para decir «sin ficha para esta
 *  novedad» vs «este país todavía no tiene guía cargada»). */
export function paisTieneGuia(countryCode: string | null | undefined): boolean {
  return PROVEEDORES[paisNovedades(countryCode)].fuente !== '';
}

export function fuenteGuia(countryCode: string | null | undefined): string {
  return PROVEEDORES[paisNovedades(countryCode)].fuente;
}

/** La fuente puntual de una ficha (las de Ecuador no la traen: es el Drive). */
export function fuenteDeFicha(g: GuiaNovedadCualquiera | null): string | null {
  return g && 'fuente' in g && g.fuente ? g.fuente : null;
}

/** Si la ficha trae cómo responder o solo el significado. */
export function respuestaPublicada(g: GuiaNovedadCualquiera | null): boolean {
  if (!g) return false;
  return 'respuestaPublicada' in g ? g.respuestaPublicada : g.comoResponder.trim().length > 0;
}
