/**
 * Por qué una venta de Shopify no llegó a Dropi, en un idioma que la asesora
 * entiende — y en UN SOLO lugar.
 *
 * Vive en `_shared` a propósito: lo necesitan la PANTALLA (para agrupar las
 * ventas trabadas por motivo) y el ROBOT (para no martillar 96 veces por día la
 * misma causa). Si hubiera dos definiciones de "el motivo", el cartel y el robot
 * dirían cosas distintas sobre la misma venta, que es exactamente cómo nacen los
 * números que se contradicen en pantalla.
 *
 * ⛔ Los patrones NO se inventaron: salen de medir `shopify_pushed_orders` de
 * Ecuador del 28-ago al 4-sep-2026 — 480 ventas intentadas, 85 que nunca
 * llegaron. La distribución medida fue:
 *
 *   40  producto Dropi 147152 sin stock en bodega   ← UN solo producto
 *   23  Dropi no lista la ciudad (sin cobertura COD)
 *   11  la ciudad no tiene habilitado el método de envío
 *    8  el producto es variable y falta la variación
 *    2  ciudad/departamento no coinciden
 *    1  ninguna transportadora cotizó
 *
 * La `clave` lleva el DISCRIMINANTE (producto o ciudad) porque de eso depende
 * todo: dos ventas del mismo producto sin stock son el mismo problema y se
 * cuentan juntas; dos ciudades distintas sin cobertura son dos problemas y
 * pausar una no puede pausar la otra.
 */

export type FamiliaCausa =
  | "sin_stock"
  | "sin_cobertura"
  | "sin_metodo_envio"
  | "variable_sin_variacion"
  | "ciudad_no_coincide"
  | "sin_cotizacion"
  | "sin_vinculo"
  | "duplicado"
  | "sin_verificar"
  | "otro";

export interface Causa {
  familia: FamiliaCausa;
  /** Agrupa. Lleva el discriminante: `sin_stock:147152`, `sin_cobertura:RIO VERDE`. */
  clave: string;
  /** Lo que lee la asesora. Sin prefijos técnicos ni códigos HTTP. */
  etiqueta: string;
  /** Una línea accionable: qué hay que hacer para destrabarla. */
  comoSeArregla: string;
  /** true = reintentar solo NO sirve; hay que tocar Dropi o llamar al cliente. */
  loArreglaElDueno: boolean;
  /** Por qué camino murió. Convierte cualquier reporte futuro en diagnóstico. */
  via: "integraciones" | "web" | "guardian";
}

/** Pela los prefijos técnicos y de paso dice por qué camino vino el rechazo. */
function pelar(bruto: string): { texto: string; via: Causa["via"] } {
  let t = bruto.trim();
  let via: Causa["via"] = "guardian";
  const fallback = /^Fallback web \[\d+\]:\s*/.exec(t);
  if (fallback) {
    via = "web";
    t = t.slice(fallback[0].length);
  } else if (/^Dropi \[\d+\]:/.test(t)) {
    via = "integraciones";
    t = t.replace(/^Dropi \[\d+\]:\s*/, "");
  }
  // El panel web envuelve otra vez: "Dropi (panel web) rechazó el pedido [200]: …"
  t = t.replace(/^Dropi \(panel web\) rechaz[oó] el pedido \[\d+\]:\s*/, "");
  // Dropi numera algunos errores: "3. La ciudad no tiene…" / "3: La ciudad no…"
  t = t.replace(/^\d+[.:]\s*/, "");
  return { texto: t.trim(), via };
}

const NORMALIZAR_CLAVE = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase().trim();

export function causaDeFalla(bruto: string | null | undefined): Causa {
  if (!bruto || !bruto.trim()) {
    return {
      familia: "sin_verificar",
      clave: "sin_verificar",
      etiqueta: "Quedó sin confirmar",
      comoSeArregla: "Hay que mirar en Dropi si la orden existe antes de reintentar.",
      loArreglaElDueno: false,
      via: "guardian",
    };
  }

  const { texto, via } = pelar(bruto);
  const base = { via } as const;

  // 1. Producto sin stock en bodega. El discriminante es el id del producto:
  //    un solo producto puede frenar decenas de ventas (147152 frenó 40).
  const stock = /no tiene stock en bodega/i.exec(texto);
  if (stock) {
    const id = /producto Dropi (\d+)/i.exec(texto)?.[1] ?? "?";
    return {
      ...base,
      familia: "sin_stock",
      clave: `sin_stock:${id}`,
      etiqueta: `El producto ${id} no tiene stock en bodega`,
      comoSeArregla: "Se arregla en Dropi: reponer stock o vincular la variante correcta. Reintentar solo no sirve.",
      loArreglaElDueno: true,
    };
  }

  // 2. Dropi no cubre la ciudad con contraentrega.
  const cobertura = /no lista "([^"]+)"|sin cobertura COD/i.exec(texto);
  if (cobertura) {
    const ciudad = cobertura[1] ?? "";
    return {
      ...base,
      familia: "sin_cobertura",
      clave: `sin_cobertura:${NORMALIZAR_CLAVE(ciudad) || "?"}`,
      etiqueta: ciudad
        ? `Dropi no cubre ${ciudad} con contraentrega`
        : "Dropi no cubre esa ciudad con contraentrega",
      comoSeArregla: "No hay cómo despacharla: llamar al cliente y ofrecerle una dirección con cobertura.",
      loArreglaElDueno: true,
    };
  }

  // 3. La ciudad existe pero no tiene habilitado el método de envío. El mensaje
  //    trae la ruta completa: "CON RECAUDO - SAN CRISTOBAL-GALAPAGOS-SERVIENTREGA-[]-"
  if (/no tiene habilitado el m[^ ]+ de env[^ ]*o/i.test(texto)) {
    const cola = /:\s*([^:]+)$/.exec(texto)?.[1] ?? "";
    const ciudad = cola.split("-").map((s) => s.trim()).filter(Boolean)[1] ?? "";
    return {
      ...base,
      familia: "sin_metodo_envio",
      clave: `sin_metodo:${NORMALIZAR_CLAVE(ciudad) || "?"}`,
      etiqueta: ciudad
        ? `${ciudad} no tiene habilitado el envío contra entrega`
        : "La ciudad no tiene habilitado el envío contra entrega",
      comoSeArregla: "La transportadora no llega ahí con recaudo: llamar al cliente y ofrecerle otra dirección.",
      loArreglaElDueno: true,
    };
  }

  // 4. Producto variable sin variación. Era un bug NUESTRO (el cuerpo que crea
  //    no llevaba `variation_id`, arreglado el 4-sep-2026); si vuelve a
  //    aparecer, es que el vínculo del producto no tiene variante.
  const variable = /El producto (.+?) es variable/i.exec(texto);
  if (variable || /debe indicar una variaci/i.test(texto)) {
    const prod = variable?.[1]?.trim() ?? "";
    return {
      ...base,
      familia: "variable_sin_variacion",
      clave: `variable:${NORMALIZAR_CLAVE(prod) || "?"}`,
      etiqueta: prod ? `Falta decirle a Dropi qué variante es (${prod})` : "Falta decirle a Dropi qué variante es",
      comoSeArregla: "Vincular el producto de Shopify con su variante de Dropi en Admin → Productos.",
      loArreglaElDueno: true,
    };
  }

  // 5. Ciudad y departamento no coinciden en el catálogo de Dropi.
  if (/ciudad no existe en el departamento/i.test(texto)) {
    const ciudad = /CIUDAD:\s*([^-]+)/i.exec(texto)?.[1]?.trim() ?? "";
    return {
      ...base,
      familia: "ciudad_no_coincide",
      clave: `ciudad_no_coincide:${NORMALIZAR_CLAVE(ciudad) || "?"}`,
      etiqueta: ciudad ? `${ciudad} no coincide con su provincia` : "La ciudad no coincide con su provincia",
      comoSeArregla: "Corregir la ciudad o la provincia en la ficha del pedido y volver a subirla.",
      loArreglaElDueno: false,
    };
  }

  // 6. Ninguna transportadora cotizó.
  if (/Ninguna transportadora cotiz|No se ha podido cotizar/i.test(texto)) {
    return {
      ...base,
      familia: "sin_cotizacion",
      clave: "sin_cotizacion",
      etiqueta: "Ninguna transportadora cotizó el envío",
      comoSeArregla: "Puede ser pasajero. Si insiste, revisar la ciudad con el cliente.",
      loArreglaElDueno: false,
    };
  }

  // 7. Producto sin vincular a Dropi.
  if (/upsert_shopify_product_dropi_map|no expone el v[ií]nculo|sin v[ií]nculo/i.test(texto)) {
    return {
      ...base,
      familia: "sin_vinculo",
      clave: "sin_vinculo",
      etiqueta: "Producto sin vincular a Dropi",
      comoSeArregla: "Vincularlo desde el panel y reintentar.",
      loArreglaElDueno: true,
    };
  }

  // 8. El candado anti-duplicado cediendo. NO es una falla: es el sistema
  //    haciendo su trabajo, y contarla como venta trabada sería mentir.
  if (/duplicate_phone|ced[ií] ante la venta|Ya hay un pedido en Dropi con este tel/i.test(texto)) {
    return {
      ...base,
      familia: "duplicado",
      clave: "duplicado",
      etiqueta: "Se frenó porque el cliente ya tiene un pedido en Dropi",
      comoSeArregla: "Si es una recompra real, subirla con «No es duplicado».",
      loArreglaElDueno: false,
    };
  }

  // 9. Indeterminado: NO se sabe si la orden quedó creada. Nunca se reintenta
  //    solo — se mira en Dropi primero, o se crea una guía doble.
  if (/needs_verify|no s[eé] si la orden qued|indeterminado|sin id parseable|guard_failed/i.test(texto)) {
    return {
      ...base,
      familia: "sin_verificar",
      clave: "sin_verificar",
      etiqueta: "Quedó sin confirmar — hay que mirar en Dropi",
      comoSeArregla: "Buscar el teléfono en Dropi antes de reintentar: puede haberse creado igual.",
      loArreglaElDueno: false,
    };
  }

  // 10. Lo que no reconocemos se muestra tal cual, recortado. Se agrupa por las
  //     primeras palabras para que dos veces el mismo error desconocido queden
  //     juntas en vez de contarse como dos problemas distintos.
  const firma = NORMALIZAR_CLAVE(texto).replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  return {
    ...base,
    familia: "otro",
    clave: `otro:${firma || "?"}`,
    etiqueta: texto.slice(0, 120),
    comoSeArregla: "Motivo no reconocido: hay que leerlo y decidir.",
    loArreglaElDueno: false,
  };
}
