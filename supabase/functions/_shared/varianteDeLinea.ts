// Variante (talla / color) de una línea de pedido: cómo se nombra, cómo se
// reconoce en el catálogo y cómo se completa cuando una lectura la trae y la
// otra no. PURO: sin Deno, sin red — lo prueba `src/lib/varianteDeLinea.test.ts`.
//
// ── Por qué existe (5-sep-2026) ──────────────────────────────────────────────
// «No está dejando cambiar de transportadora». En pantalla: *"El producto Dropi
// 147152 no tiene stock en bodega (sin ciudad de origen)"* al tocar «Actualizar
// Orden» sobre el shampoo Dexe, variante OSCURO. Leído en el código:
//
//  - COTIZAR (la lista de transportadoras del editor) lee las líneas del pedido
//    con el GET de INTEGRACIONES, que trae `variation_id` (verificado en vivo el
//    6-ago-2026). APLICAR las lee del detalle V2 primero. Si el V2 no trae la
//    variante con el nombre que esperamos, la línea llega sin `variationId`.
//  - Y un producto VARIABLE sin variante, al pedirle la bodega a Dropi con el id
//    del PRODUCTO, recibe `data: []` (probado el 4-sep-2026 con este mismo
//    shampoo): eso se leía como "sin stock" cuando el stock estaba. Dropify
//    creaba la misma variante sin problema.
//
// O sea: la cotización pasa, la asesora elige la transportadora, y al aplicar se
// pierde la variante entre una lectura y la otra. Acá viven las tres piezas que
// lo cierran: la etiqueta de la variante (para reconocerla por nombre cuando no
// hay id), el cruce contra el catálogo y el completado entre lecturas.

/** Lo mínimo que necesita una línea para razonar sobre su variante. */
export interface LineaConVariante {
  dropiId: number;
  variationId?: number | null;
  /** Etiqueta legible de la variante: "38 / NEGRO", "OSCURO". Sin id sirve
   *  para reconocerla en el catálogo. */
  variante?: string | null;
}

/** Una variante del catálogo web (`variations[]` de productlist/v1/show). */
export interface VariacionCatalogo {
  id?: number | string | null;
  sku?: string | null;
  name?: string | null;
  attribute_values?: unknown;
}

/** MAYÚSCULAS, sin tildes, un solo espacio. Misma idea que `normUp` del módulo
 *  de cotización; se repite acá para que este archivo no importe nada. */
export function normalizarEtiqueta(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Etiqueta de una variante a partir del objeto que manda Dropi, sea en la línea
 * del pedido (`orderdetails[].variation`) o en el catálogo (`variations[]`).
 * Dropi expone los valores como `attribute_values: [{value:"38"},{value:"Negro"}]`
 * → "38 / Negro". Es la MISMA regla que usa `dropiOrderMapper.variantLabel` para
 * escribir `productos_detalle.variante`, así lo que se guarda y lo que se busca
 * coinciden. Sin valores, cae al `name` o al `sku`. Vacío si no hay nada.
 */
export function etiquetaVariante(v: unknown): string {
  if (!v || typeof v !== "object") return "";
  const o = v as Record<string, unknown>;
  const attrs = o.attribute_values;
  if (Array.isArray(attrs)) {
    const txt = (attrs as Array<Record<string, unknown>>)
      .map((a) => String(a?.value ?? a?.name ?? "").trim())
      .filter(Boolean)
      .join(" / ");
    if (txt) return txt;
  }
  return String(o.name ?? o.sku ?? "").trim();
}

/** Los valores de una etiqueta como conjunto ordenado: "38 / Negro" y
 *  "NEGRO / 38" son la misma variante aunque cada endpoint ordene los
 *  atributos distinto. */
function llaveDeEtiqueta(etiqueta: string): string {
  return etiqueta
    .split("/")
    .map((p) => normalizarEtiqueta(p))
    .filter(Boolean)
    .sort()
    .join("|");
}

/**
 * Busca en el catálogo la variante que se llama como `etiqueta`. Devuelve su id
 * SOLO si hay exactamente una coincidencia: con dos candidatas ("OSCURO 500ml" y
 * "OSCURO 1L" frente a "OSCURO") elegir una sería mandarle al cliente lo que no
 * pidió, y ante la duda se prefiere no resolver.
 */
export function variacionPorEtiqueta(
  variaciones: VariacionCatalogo[] | null | undefined,
  etiqueta: string | null | undefined,
): number | null {
  const llave = llaveDeEtiqueta(String(etiqueta ?? ""));
  if (!llave || !Array.isArray(variaciones)) return null;
  const candidatas = variaciones.filter((v) => {
    const id = Number(v?.id);
    if (!Number.isFinite(id) || id <= 0) return false;
    return llaveDeEtiqueta(etiquetaVariante(v)) === llave;
  });
  if (candidatas.length !== 1) return null;
  return Number(candidatas[0].id);
}

/** Si el producto tiene UNA sola variante, esa es. Con cero o varias, null. */
export function unicaVariacion(variaciones: VariacionCatalogo[] | null | undefined): number | null {
  if (!Array.isArray(variaciones)) return null;
  const conId = variaciones
    .map((v) => Number(v?.id))
    .filter((n) => Number.isFinite(n) && n > 0);
  return conId.length === 1 ? conId[0] : null;
}

/**
 * Completa las líneas de `base` que vienen SIN variante con lo que traiga
 * `otras` (la misma orden leída por otro endpoint). El cruce es por POSICIÓN
 * cuando las dos lecturas tienen el mismo largo y el mismo producto en ese
 * lugar; si los largos difieren, por producto y solo si en `otras` hay UNA
 * línea de ese producto (dos tallas del mismo zapato llegan con el mismo
 * dropiId: ahí no se adivina). Nunca pisa un `variationId` que ya venía.
 */
export function completarVariantes<T extends LineaConVariante>(
  base: T[],
  otras: LineaConVariante[] | null | undefined,
): T[] {
  if (!Array.isArray(otras) || otras.length === 0) return base;
  const mismoLargo = otras.length === base.length;
  return base.map((linea, i) => {
    if (linea.variationId) return linea;
    let fuente: LineaConVariante | undefined;
    if (mismoLargo && otras[i]?.dropiId === linea.dropiId) {
      fuente = otras[i];
    } else {
      const delProducto = otras.filter((o) => o.dropiId === linea.dropiId);
      if (delProducto.length === 1) fuente = delProducto[0];
    }
    if (!fuente) return linea;
    const variationId = fuente.variationId ?? null;
    const variante = linea.variante || fuente.variante || null;
    if (!variationId && !variante) return linea;
    return { ...linea, ...(variationId ? { variationId } : {}), ...(variante ? { variante } : {}) };
  });
}

/** ¿Alguna línea quedó sin variante? Es la señal para ir a buscar la otra lectura. */
export function faltaAlgunaVariante(lineas: LineaConVariante[]): boolean {
  return lineas.some((l) => !l.variationId);
}
