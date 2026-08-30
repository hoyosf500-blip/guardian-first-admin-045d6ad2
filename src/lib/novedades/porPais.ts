import {
  guiaOficialNovedad as guiaEC,
  plantillaSolucion as plantillaEC,
  type GuiaNovedad,
  type PlantillaSolucion,
} from '@/lib/dropiEcuador/logisticaOficial';

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
 *   inventar.
 * - **La plantilla de solución siempre existe.** Es el formato que Dropi acepta
 *   en cualquier país («Me he comunicado con el cliente al número … y me indica
 *   que …»); sin ficha oficial sale como `origen: 'generica'`, con el teléfono
 *   del pedido puesto y huecos `____` para lo que acordó la asesora.
 * - Cada país es un módulo aparte con los DATOS de sus transportadoras. Agregar
 *   uno es registrar su `guia` acá, no tocar la pantalla.
 */

export type PaisNovedades = 'EC' | 'CO' | 'GT';

interface ProveedorPais {
  /** Ficha oficial para esa novedad/transportadora, o null si no hay. */
  guia: (novedad: string | null | undefined, transportadora?: string | null) => GuiaNovedad | null;
  /** Borrador de solución (rellena la ficha si la hay; genérico si no). */
  plantilla: (
    guia: GuiaNovedad | null,
    pedido: { phone?: string | null; nombre?: string | null; direccion?: string | null },
    transportadora?: string | null,
  ) => PlantillaSolucion;
  /** De dónde salen las fichas, para decirlo en pantalla. */
  fuente: string;
}

/** Plantilla genérica para países sin hojas oficiales cargadas: el formato
 *  que Dropi acepta, con el teléfono real y huecos para la asesora. */
function plantillaGenerica(
  pedido: { phone?: string | null; nombre?: string | null; direccion?: string | null },
): PlantillaSolucion {
  const tel = (pedido.phone ?? '').trim() || '____';
  return {
    texto: `Me he comunicado con el cliente al numero ${tel} y me indica que ____ (día y hora en que recibe, quién recibe, dirección con referencia). No mayor a 24 horas.`,
    maximo: 500,
    origen: 'generica',
  };
}

const PROVEEDORES: Record<PaisNovedades, ProveedorPais> = {
  EC: {
    guia: guiaEC,
    plantilla: plantillaEC,
    fuente: 'Hojas «Estados y Novedades» de Dropi Ecuador (Drive oficial, ago-2026)',
  },
  // Colombia y Guatemala: todavía sin fichas oficiales cargadas. La plantilla
  // genérica sí sale (es el formato de Dropi) y el envío a Dropi funciona; la
  // pantalla dice con todas las letras que no hay ficha para esa novedad.
  CO: { guia: () => null, plantilla: (_g, pedido) => plantillaGenerica(pedido), fuente: '' },
  GT: { guia: () => null, plantilla: (_g, pedido) => plantillaGenerica(pedido), fuente: '' },
};

export function paisNovedades(countryCode: string | null | undefined): PaisNovedades {
  const c = String(countryCode || 'CO').toUpperCase();
  return c === 'EC' || c === 'GT' ? c : 'CO';
}

export function guiaNovedadPorPais(
  countryCode: string | null | undefined,
  novedad: string | null | undefined,
  transportadora?: string | null,
): GuiaNovedad | null {
  return PROVEEDORES[paisNovedades(countryCode)].guia(novedad, transportadora);
}

export function plantillaSolucionPorPais(
  countryCode: string | null | undefined,
  guia: GuiaNovedad | null,
  pedido: { phone?: string | null; nombre?: string | null; direccion?: string | null },
  transportadora?: string | null,
): PlantillaSolucion {
  return PROVEEDORES[paisNovedades(countryCode)].plantilla(guia, pedido, transportadora);
}

/** Si el país tiene hojas oficiales cargadas (para decir «sin ficha para esta
 *  novedad» vs «este país todavía no tiene guía cargada»). */
export function paisTieneGuia(countryCode: string | null | undefined): boolean {
  return PROVEEDORES[paisNovedades(countryCode)].fuente !== '';
}

export function fuenteGuia(countryCode: string | null | undefined): string {
  return PROVEEDORES[paisNovedades(countryCode)].fuente;
}
