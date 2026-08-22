import { describe, it, expect } from "vitest";
import {
  derivarSenal,
  clasificar,
  esBotonConfirmar,
  esPalabraDelCliente,
  PRIORIDAD_RIESGO,
  RIESGO_DOC,
  PLANTILLA_CONFIRMACION,
  type MensajeChat,
  type NivelRiesgo,
} from "../../supabase/functions/_shared/senalConfirmacion";

// El archivo vive en src/lib aunque prueba código de supabase/functions:
// vitest.config.ts solo incluye `src/**`, así que un test al lado de la edge
// function NO se ejecuta nunca (ni acá ni en CI). Ver CLAUDE.md.

const t = (h: number) => new Date(2026, 7, 10, h, 0, 0);

const msg = (p: Partial<MensajeChat>): MensajeChat => ({
  rol: "Cliente",
  tipo: "text",
  texto: "",
  plantilla: null,
  fecha: t(10),
  ...p,
});

const plantilla = (h = 9) =>
  msg({ rol: "Propietario", tipo: "template", plantilla: PLANTILLA_CONFIRMACION, fecha: t(h) });
const boton = (h = 9) => msg({ tipo: "button", texto: "CONFIRMAR PEDIDO", fecha: t(h) });
const escribe = (texto = "hola", h = 11) => msg({ texto, fecha: t(h) });

describe("reconocer lo que hizo el cliente", () => {
  it("el botón de confirmar se reconoce aunque cambie la acentuación o el caso", () => {
    expect(esBotonConfirmar(msg({ tipo: "button", texto: "Confirmar pedido" }))).toBe(true);
    expect(esBotonConfirmar(msg({ tipo: "button", texto: "  CONFIRMAR PEDIDO  " }))).toBe(true);
  });

  it("apretar ACTUALIZAR INFORMACIÓN no es confirmar", () => {
    // Medido: los que apretaron ese botón cancelaron 42,9%, del lado malo.
    expect(esBotonConfirmar(msg({ tipo: "button", texto: "ACTUALIZAR INFORMACIÓN" }))).toBe(false);
  });

  it("un texto del negocio que diga 'confirmar pedido' NO cuenta como botón", () => {
    // Si contara, la plantilla se auto-confirmaría y la señal valdría cero.
    expect(esBotonConfirmar(msg({ rol: "Propietario", tipo: "text", texto: "Confirmar pedido?" })))
      .toBe(false);
  });

  it("apretar un botón no es escribir", () => {
    expect(esPalabraDelCliente(boton())).toBe(false);
    expect(esPalabraDelCliente(escribe())).toBe(true);
  });
});

describe("los cuatro grupos medidos en agosto", () => {
  it("apretó el botón → confirmado (10% cancela)", () => {
    const s = derivarSenal([plantilla(), boton()], [plantilla(), boton()]);
    expect(s.riesgo).toBe("confirmado");
    expect(s.apretoBotonAt).toEqual(t(9));
  });

  it("escribió pero no apretó → tibio (33,5% cancela)", () => {
    const conv = [plantilla(), escribe("¿estas gafas toman foto?")];
    expect(derivarSenal(conv, conv).riesgo).toBe("tibio");
  });

  it("le llegó la plantilla, no hizo nada, pero alguna vez habló → frío (37,5%)", () => {
    const ventana = [plantilla()];
    const historial = [plantilla(), escribe("gracias", 20)]; // habló, pero fuera de la ventana
    const s = derivarSenal(ventana, historial);
    expect(s.riesgo).toBe("frio");
    expect(s.mudo).toBe(false);
  });

  it("nunca escribió en TODA la historia → mudo (66,2% cancela, la mitad de la plata)", () => {
    const solos = [plantilla(), plantilla(12)];
    const s = derivarSenal(solos, solos);
    expect(s.riesgo).toBe("mudo");
    expect(s.mudo).toBe(true);
  });

  it("el botón manda aunque después el cliente discuta", () => {
    // 10,4% vs 57,7%: apretar pesa más que conversar. Si algún día se invierte
    // este orden, la cola de trabajo se ordena al revés.
    const conv = [plantilla(), boton(), escribe("igual no me convence", 15)];
    expect(derivarSenal(conv, conv).riesgo).toBe("confirmado");
  });

  it("mudo gana sobre frío: es el peor Y cambia el canal", () => {
    // 66,2% contra 37,5%, y son 157 pedidos contra 24. Si esto se invirtiera,
    // la cola pondría arriba al grupo chico y dejaría abajo la mitad de la
    // plata que se pierde en el mes.
    expect(clasificar({ apreto: false, escribio: false, recibioPlantilla: true, mudo: true }))
      .toBe("mudo");
    expect(PRIORIDAD_RIESGO.mudo).toBeLessThan(PRIORIDAD_RIESGO.frio);
  });
});

describe("no se puede inventar una medición que no existe", () => {
  it("sin conversación devuelve sin_dato, NUNCA 'confirmado'", () => {
    const s = derivarSenal(null, null);
    expect(s.riesgo).toBe("sin_dato");
    expect(s.apretoBotonAt).toBeNull();
  });

  it("una conversación vacía NO es lo mismo que no haberla leído", () => {
    // Ventana leída y vacía: eso sí es información (nadie le escribió nada).
    expect(derivarSenal([], []).riesgo).toBe("mudo");
    // Ventana no leída: no se sabe.
    expect(derivarSenal(null, []).riesgo).toBe("sin_dato");
  });

  it("sin historial completo no se afirma que el cliente nunca habló", () => {
    // `mudo` es una acusación fuerte: 'a esta persona llamala, el chat no sirve'.
    // Con la ventana sola no alcanza para sostenerla.
    const s = derivarSenal([plantilla()], null);
    expect(s.mudo).toBe(false);
    expect(s.riesgo).toBe("frio");
  });
});

describe("la cola de trabajo", () => {
  it("ordena por lo que más se pierde, y deja lo confirmado al final", () => {
    const orden = (["confirmado", "sin_dato", "frio", "mudo", "tibio"] as NivelRiesgo[])
      .sort((a, b) => PRIORIDAD_RIESGO[a] - PRIORIDAD_RIESGO[b]);
    expect(orden).toEqual(["mudo", "frio", "tibio", "sin_dato", "confirmado"]);
  });

  it("sin_dato va antes que confirmado: un pedido en blanco no es un pedido tranquilo", () => {
    expect(PRIORIDAD_RIESGO.sin_dato).toBeLessThan(PRIORIDAD_RIESGO.confirmado);
  });

  it("todo nivel tiene explicación y qué hacer — nadie ve una etiqueta muda", () => {
    for (const k of Object.keys(PRIORIDAD_RIESGO) as NivelRiesgo[]) {
      expect(RIESGO_DOC[k]?.que?.length ?? 0).toBeGreaterThan(10);
      expect(RIESGO_DOC[k]?.queHacer?.length ?? 0).toBeGreaterThan(10);
    }
  });
});
