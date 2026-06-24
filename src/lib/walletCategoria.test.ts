import { describe, it, expect } from "vitest";
// La lógica vive en _shared para que la comparta la edge function `dropi-wallet-sync`
// (Deno) y este test (Vitest). Es un módulo PURO sin dependencias de Deno.
import { mapCategoria, normalizeDesc } from "../../supabase/functions/_shared/walletCategoria";

describe("mapCategoria — descripciones REALES del historial de cartera", () => {
  // Strings exactos extraídos de los Excel de wallet de mayo/junio 2026.
  const casos: Array<[string, string]> = [
    [
      "ENTRADA POR GANANCIA EN LA ORDEN COMO DROPSHIPPER: 76479947* GUIA: *240053270863*",
      "ganancia_dropshipper",
    ],
    ["SALIDA POR COBRO DE FLETE INICIAL: 74667626", "flete_inicial"],
    [
      "SALIDA POR TRANSFERENCIA DE WALLET AL USUARIO hoyosf500@gmail.com",
      "retiro",
    ],
    [
      "ENTRADA POR INDEMNIZACION ORDEN: 73786451. MOTIVO: PROVEEDOR NO DESPACHA EN 72 HORAS, TIPO: PROFIT",
      "indemnizacion",
    ],
    [
      "SALIDA DE COBRO DE DEVOLUCIÓN POR ENTREGA NO EFECTIVA: 71616498",
      "costo_devolucion",
    ],
    ["SALIDA POR NUEVA ORDEN: 76218969", "orden_sin_recaudo"],
    [
      "SALIDA POR MANTENIMIENTO MENSUAL TARJETA VIRTUAL ID: 45229 UUID:car_0338mUZeope7AO3Z2ohqyb - CORRESPONDIENTE A MES: 05-2026",
      "mantenimiento_tarjeta",
    ],
    [
      "ENTRADA POR TRANSFERENCIA DE WALLET DESDE EL USUARIO vendiendoyvendiendo11@gmail.com",
      "deposito",
    ],
  ];

  it.each(casos)("clasifica %s correctamente (no en 'otro')", (desc, esperado) => {
    const got = mapCategoria(desc);
    expect(got).toBe(esperado);
    expect(got).not.toBe("otro");
  });
});

describe("mapCategoria — robustez (casos que el split(':')[0] viejo rompía)", () => {
  it("matchea aunque la palabra clave caiga DESPUÉS del primer ':'", () => {
    // El código viejo hacía descripcion.split(':')[0] → perdía 'AL USUARIO' → 'otro'.
    expect(mapCategoria("SALIDA: TRANSFERENCIA DE WALLET AL USUARIO x@y.com")).toBe("retiro");
    expect(mapCategoria("MOTIVO: COBRO DE MANTENIMIENTO TARJETA VIRTUAL")).toBe(
      "mantenimiento_tarjeta",
    );
  });

  it("es robusto a tildes (DEVOLUCIÓN / INDEMNIZACIÓN con acento)", () => {
    expect(mapCategoria("SALIDA POR DEVOLUCIÓN POR ENTREGA NO EFECTIVA")).toBe("costo_devolucion");
    expect(mapCategoria("ENTRADA POR INDEMNIZACIÓN DE LA ORDEN")).toBe("indemnizacion");
  });

  it("colapsa saltos de línea y espacios múltiples", () => {
    expect(mapCategoria("SALIDA POR  COBRO\n  DE FLETE INICIAL")).toBe("flete_inicial");
  });
});

describe("mapCategoria — distinciones que NO se deben perder", () => {
  it("reembolso (orden entregada) ≠ costo (no efectiva)", () => {
    expect(mapCategoria("ENTRADA POR DEVOLUCION DE FLETE - ORDEN ENTREGADA")).toBe("reembolso_flete");
    expect(mapCategoria("SALIDA POR DEVOLUCION DE FLETE NO EFECTIVA")).toBe("costo_devolucion");
  });

  it("ganancia dropshipper ≠ proveedor", () => {
    expect(mapCategoria("ENTRADA POR GANANCIA COMO DROPSHIPPER")).toBe("ganancia_dropshipper");
    expect(mapCategoria("ENTRADA POR GANANCIA COMO PROVEEDOR")).toBe("ganancia_proveedor");
  });

  it("una descripción desconocida se queda en 'otro' (no se fuerza)", () => {
    expect(mapCategoria("ALGUN CONCEPTO NUEVO DE DROPI QUE NO CONOCEMOS")).toBe("otro");
    expect(mapCategoria("")).toBe("otro");
    expect(mapCategoria(null)).toBe("otro");
  });
});

describe("normalizeDesc", () => {
  it("UPPER + sin acentos + colapsa espacios + trim", () => {
    expect(normalizeDesc("  Devolución   por\nflete  ")).toBe("DEVOLUCION POR FLETE");
  });
});
