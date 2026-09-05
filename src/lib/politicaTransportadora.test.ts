// La lógica pura vive en supabase/functions/_shared (la importa la edge function
// Deno); Vitest solo mira src/**, así que el test vive acá y cruza el límite.
import { describe, it, expect } from "vitest";
import {
  ordenarCandidatas,
  preferenciaTransportadora,
  esRechazoPorMetodoDeEnvio,
  motivoEleccion,
} from "../../supabase/functions/_shared/politicaTransportadora";

const EC = "512309c3-d5b7-4434-898a-31bed51dcd4d";
const CO = "00000000-0000-0000-0000-000000000001";

// Cotización REAL de Dropi para TUMBACO (PICHINCHA), 5-sep-2026 18:25Z, pedido 6866089.
const TUMBACO = [
  { id: 3, name: "VELOCES", typeService: "normal", shippingAmount: 4.71477 },
  { id: 4, name: "GINTRACOM", typeService: "normal", shippingAmount: 4.910155 },
  { id: 1, name: "LAARCOURIER", typeService: "normal", shippingAmount: 6.531425 },
];

describe("ordenarCandidatas — la transportadora que la asesora iba a elegir de todas formas", () => {
  it("Ecuador: LAARCOURIER primero aunque GINTRACOM sea más barata (127 cambios a mano en 2 días)", () => {
    const out = ordenarCandidatas(TUMBACO, preferenciaTransportadora(EC));
    expect(out.map((o) => o.name)).toEqual(["LAARCOURIER", "GINTRACOM"]);
  });

  it("nunca VELOCES, ni como preferida ni como resto", () => {
    const out = ordenarCandidatas(TUMBACO, ["VELOCES", "LAARCOURIER"]);
    expect(out.map((o) => o.name)).toEqual(["LAARCOURIER", "GINTRACOM"]);
  });

  it("sin preferencia (Colombia) se comporta como antes: la más barata que no es VELOCES", () => {
    const out = ordenarCandidatas(TUMBACO, preferenciaTransportadora(CO));
    expect(out.map((o) => o.name)).toEqual(["GINTRACOM", "LAARCOURIER"]);
    expect(preferenciaTransportadora(CO)).toEqual([]);
    expect(preferenciaTransportadora(null)).toEqual([]);
  });

  it("si LAARCOURIER no cotizó ese destino, cae a SERVIENTREGA antes que a la barata", () => {
    const rural = [
      { id: 4, name: "GINTRACOM", typeService: "normal", shippingAmount: 5.1 },
      { id: 2, name: "SERVIENTREGA", typeService: "normal", shippingAmount: 7.9 },
    ];
    expect(ordenarCandidatas(rural, preferenciaTransportadora(EC)).map((o) => o.name)).toEqual(["SERVIENTREGA", "GINTRACOM"]);
  });

  it("devuelve la LISTA completa para poder reintentar con la siguiente si Dropi rechaza la primera", () => {
    const out = ordenarCandidatas(
      [
        { id: 1, name: "LAARCOURIER", typeService: "normal", shippingAmount: 6.5 },
        { id: 2, name: "SERVIENTREGA", typeService: "normal", shippingAmount: 7.9 },
        { id: 4, name: "GINTRACOM", typeService: "normal", shippingAmount: 4.9 },
      ],
      preferenciaTransportadora(EC),
    );
    expect(out.map((o) => o.name)).toEqual(["LAARCOURIER", "SERVIENTREGA", "GINTRACOM"]);
  });

  it("solo VELOCES → vacío (el caller mantiene su mensaje de «ninguna cotizó»)", () => {
    expect(ordenarCandidatas([TUMBACO[0]], preferenciaTransportadora(EC))).toEqual([]);
    expect(ordenarCandidatas([], preferenciaTransportadora(EC))).toEqual([]);
  });

  it("no confía en el orden de Dropi: reordena el resto por precio", () => {
    const desordenado = [
      { id: 4, name: "GINTRACOM", typeService: "normal", shippingAmount: 9 },
      { id: 9, name: "OTRA", typeService: "normal", shippingAmount: 3 },
    ];
    expect(ordenarCandidatas(desordenado, []).map((o) => o.name)).toEqual(["OTRA", "GINTRACOM"]);
  });

  it("nombres con espacios o minúsculas cuentan igual", () => {
    const out = ordenarCandidatas([{ id: 1, name: " laarcourier ", typeService: "normal", shippingAmount: 6 }], preferenciaTransportadora(EC));
    expect(out).toHaveLength(1);
    expect(motivoEleccion(out[0], preferenciaTransportadora(EC))).toBe("preferida #1 de la tienda");
    expect(motivoEleccion(TUMBACO[1], preferenciaTransportadora(EC))).toBe("la más barata que no es VELOCES");
  });
});

describe("esRechazoPorMetodoDeEnvio — el mensaje real de Dropi, con su typo", () => {
  it("reconoce el rechazo textual de producción (3-sep-2026, PALENQUE)", () => {
    expect(esRechazoPorMetodoDeEnvio("3. La ciudad no tiene habilitado el médoto de envío: CON RECAUDO - PALENQUE-LOS RIOS-LAARCOURIER")).toBe(true);
    expect(esRechazoPorMetodoDeEnvio("La ciudad no tiene habilitado el método de envio")).toBe(true);
  });
  it("no confunde otros rechazos (esos NO se reintentan con otra transportadora)", () => {
    expect(esRechazoPorMetodoDeEnvio("El producto Dropi 147152 no tiene stock en bodega (sin ciudad de origen).")).toBe(false);
    expect(esRechazoPorMetodoDeEnvio("3: La ciudad no existe en el departamento ingresado")).toBe(false);
    expect(esRechazoPorMetodoDeEnvio(null)).toBe(false);
  });
});
