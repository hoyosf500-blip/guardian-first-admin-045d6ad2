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
  if (maximo > 120) {
    return {
      texto: `OFRECER A LA DIRECCIÓN ${dir} BARRIO ____, CIUDAD ____. Cliente ${nombre} confirma que recibe el ____ (día y franja). Tel ${tel}.`,
      maximo,
      origen: 'generica',
    };
  }
  // ⛔ LA PLANTILLA CORTA SE CONSTRUYE CORTA, NO CORTADA (30-ago-2026).
  //
  // Antes se armaba el texto completo y se hacía `slice(0, maximo)`. Con una
  // dirección larga (las de Bogotá lo son) el corte caía a mitad de palabra y
  // se llevaba puesto justo lo que la transportadora necesita:
  //   «OFRECER A LA DIRECCION CALLE 45 A SUR # 72 F - 31 BARRIO KENNEDY
  //    CENTRAL TORRE 3 APTO 402 BARRIO ____. Recibe el ____. T»
  // sin teléfono y sin poder completar el barrio: el contador marcaba 120/120 y
  // el textarea ya no dejaba escribir. Eso es lo que leía Interrapidísimo.
  //
  // Ahora se reservan primero las partes que NO se pueden perder (los dos
  // huecos que la asesora completa y el teléfono) y la dirección entra con lo
  // que sobre, recortada en un límite de PALABRA y con «…» para que se vea que
  // está abreviada.
  const cabeza = 'OFRECER A LA DIRECCIÓN ';
  const cola = ` BARRIO ____. Recibe el ____. Tel ${tel}.`;
  const espacioDir = maximo - cabeza.length - cola.length;
  let dirCorta = dir;
  if (espacioDir > 0 && dir.length > espacioDir) {
    const cortado = dir.slice(0, espacioDir - 1);
    const ultimoEspacio = cortado.lastIndexOf(' ');
    dirCorta = (ultimoEspacio > espacioDir / 2 ? cortado.slice(0, ultimoEspacio) : cortado).trimEnd() + '…';
  } else if (espacioDir <= 0) {
    // Caso patológico (un tope tan chico que ni el esqueleto entra): se prefiere
    // entregar lo esencial sin dirección antes que un texto cortado a la mitad.
    return { texto: cola.trim(), maximo, origen: 'generica' };
  }
  return { texto: `${cabeza}${dirCorta}${cola}`, maximo, origen: 'generica' };
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
  if (esEstadoDeFlujo(g)) return false;
  return 'respuestaPublicada' in g ? g.respuestaPublicada : g.comoResponder.trim().length > 0;
}

/**
 * ¿La ficha dice literalmente que NO hay nada que responder?
 *
 * En Guatemala, 8 de las 23 fichas son ESTADOS DE FLUJO ("Solicitado", "En
 * ruta", "Arribo a instalaciones"), no novedades: su `responder` empieza con
 * "NO NECESITA RESPUESTA". Como `respuestaPublicada` solo miraba si el texto
 * estaba vacío, esas fichas caían en la rama VERDE de la pantalla y la asesora
 * leía, en verde y bajo el título "Cómo responder en el panel de Dropi":
 * *"NO NECESITA RESPUESTA (estado de flujo, no novedad)"* — y cerraba el
 * pedido sin gestionar, creyendo que era Dropi quien lo decía.
 *
 * Un "no hay nada que hacer" NO es una instrucción de respuesta: va en su
 * propia rama, en tono de advertencia, para que se lea como lo que es.
 */
export function esEstadoDeFlujo(g: GuiaNovedadCualquiera | null): boolean {
  if (!g) return false;
  return /^\s*NO NECESITA RESPUESTA/i.test(g.comoResponder || '');
}

/**
 * ¿La ficha viene del diccionario OFICIAL de Dropi, o de una fuente secundaria?
 *
 * El encabezado de la caja decía "Guía oficial de Dropi" para los tres países.
 * En Guatemala eso es falso y el propio registro lo dice: la fuente son los
 * términos publicados por Forza, Cargo Expreso y Guatex — *"no existe guía
 * pública de Dropi Guatemala"* — y 20 de las 23 fichas están marcadas
 * `confianza: 'secundaria'`. El campo se tipaba, se copiaba y se testeaba,
 * pero no se renderizaba en ninguna pantalla.
 */
export function confianzaDeFicha(g: GuiaNovedadCualquiera | null): 'oficial' | 'secundaria' {
  if (g && 'confianza' in g && g.confianza) return g.confianza;
  // Las fichas de Ecuador no traen el campo: salen del Drive oficial de Dropi.
  return 'oficial';
}
