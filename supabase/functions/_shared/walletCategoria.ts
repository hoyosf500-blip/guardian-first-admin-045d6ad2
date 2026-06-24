// Clasificador de movimientos de wallet de Dropi (historial de cartera).
//
// PURO y SIN dependencias de Deno → se importa tanto desde la edge function
// `dropi-wallet-sync` como desde el test Vitest `src/lib/walletCategoria.test.ts`.
//
// POR QUÉ EXISTE ESTE ARCHIVO (root cause del bug 2026-06-24):
// El edge antes derivaba un `codigo` con `descripcion.split(":")[0]` y clasificaba
// sobre ESE texto truncado. Si la palabra clave que discrimina cae DESPUÉS del
// primer ":" (ej. "SALIDA: TRANSFERENCIA AL USUARIO ...") se perdía y el movimiento
// caía en 'otro'. Acá clasificamos sobre la descripción COMPLETA normalizada.
//
// Réplica de la lógica de `normalizeEstado` (src/lib/estadoBuckets.ts): UPPER +
// colapsar espacios/saltos + trim. ADEMÁS quitamos acentos (NFD) — los códigos de
// Dropi traen "DEVOLUCIÓN"/"INDEMNIZACIÓN" con tilde y el match debe ser robusto.

/** UPPER + sin acentos + underscores→espacio + colapsa espacios/saltos + trim. */
export function normalizeDesc(s: string | null | undefined): string {
  return (s || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quitar acentos (DEVOLUCIÓN → DEVOLUCION)
    .replace(/_/g, " ")
    .replace(/\s+/g, " ") // colapsar espacios y saltos de línea
    .trim();
}

/**
 * Clasifica una descripción de movimiento de wallet en su categoría.
 *
 * EL ORDEN IMPORTA (primer match gana):
 *  1. Transferencias (tesorería: retiro/depósito) ANTES que cualquier match
 *     genérico — son movimientos de caja, no operativos.
 *  2. Devoluciones: las reglas específicas (reembolso vs costo) ANTES que el
 *     genérico, para no perder los reembolsos (entradas) clasificándolos como costo.
 *
 * Si nada matchea, devuelve 'otro' (NO se fuerza a ninguna categoría).
 */
export function mapCategoria(descripcion: string | null | undefined): string {
  const c = normalizeDesc(descripcion);
  if (!c) return "otro";

  // 1) Transferencias de wallet = tesorería (no entran al operativo).
  if (c.includes("TRANSFERENCIA") && c.includes("AL USUARIO")) return "retiro";
  if (c.includes("TRANSFERENCIA") && c.includes("DESDE")) return "deposito";

  // 2) Ganancias por orden (entradas operativas).
  if (c.includes("GANANCIA") && c.includes("DROPSHIPPER")) return "ganancia_dropshipper";
  if (c.includes("GANANCIA") && c.includes("PROVEEDOR")) return "ganancia_proveedor";

  // 3) Devoluciones: reembolso (entrada, orden SÍ entregada) vs costo (no entregada).
  //    El genérico cae a costo_devolucion como último recurso. Va ANTES de FLETE
  //    INICIAL por si un reembolso menciona "flete inicial" en su texto.
  if (c.includes("DEVOLUCION") && c.includes("ORDEN ENTREGADA")) return "reembolso_flete";
  if (c.includes("DEVOLUCION") && c.includes("NO EFECTIV")) return "costo_devolucion";
  if (c.includes("DEVOLUCION")) return "costo_devolucion";

  // 4) Cargos por orden / mantenimiento / indemnización.
  if (c.includes("FLETE INICIAL")) return "flete_inicial";
  if (c.includes("NUEVA ORDEN")) return "orden_sin_recaudo";
  if (c.includes("CAMBIO DE ESTATUS")) return "cobro_entrega";
  if (c.includes("MANTENIMIENTO")) return "mantenimiento_tarjeta";
  if (c.includes("INDEMNIZACION")) return "indemnizacion";
  if (c.includes("COMISION") && c.includes("REFERIDO")) return "comision_referidos";

  // 5) Legacy: texto simplificado de syncs viejos.
  if (c.includes("RETIRO")) return "retiro";
  if (c.includes("DEPOSITO") || c.includes("RECARGA")) return "deposito";

  return "otro";
}
