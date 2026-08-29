import { describe, it, expect } from "vitest";
import {
  derivarSenal,
  clasificar,
  esBotonConfirmar,
  esBotonConocido,
  esPalabraDelCliente,
  PRIORIDAD_RIESGO,
  RIESGO_DOC,
  PLANTILLA_CONFIRMACION,
  PLANTILLAS_CONFIRMACION,
  BOTONES_CONFIRMAR,
  BOTONES_NO_CONFIRMAR,
  BOTONES_OTRAS_PLANTILLAS,
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

// ── El incidente del 27-ago-2026 ───────────────────────────────────────────
// Se cableó `confirmacion_datos_v1` en ImporChat (mejor plantilla: muestra la
// dirección antes de confirmar) y su botón dice "Sí, está correcto". Acá se
// buscaba la palabra "CONFIRMAR". `confirmado` pasó de 58% a 0% en dos días
// sin un solo error, y la asesora llamó a gente que ya había confirmado.
describe("el botón de CADA plantilla cableada, no el de una sola", () => {
  const apreta = (texto: string) => esBotonConfirmar(msg({ tipo: "button", texto }));

  it('"Sí, está correcto" ES confirmar — con tilde, sin tilde y en cualquier caso', () => {
    // Textos reales de producción (Roxana Mora 6749394/6748452, Seimon Tirado
    // 6755681, 28-ago-2026): los tres apretaron y salieron clasificados `tibio`.
    expect(apreta("Sí, está correcto")).toBe(true);
    expect(apreta("SI, ESTA CORRECTO")).toBe(true);
    expect(apreta("  sí,   está correcto  ")).toBe(true);
  });

  it('"Corregir un dato" NO es confirmar: es el botón de al lado', () => {
    // Es el gemelo de "ACTUALIZAR INFORMACIÓN" (42,9% cancela). Darlo por
    // confirmado mandaría al fondo de la cola justo al que pidió un cambio.
    expect(apreta("Corregir un dato")).toBe(false);
  });

  it("los botones de las OTRAS plantillas tampoco confirman nada", () => {
    // Todas caen dentro de la ventana del pedido (creación +7 días), así que
    // llegan hasta acá. Ninguna dice nada sobre la confirmación.
    for (const b of BOTONES_OTRAS_PLANTILLAS) expect(apreta(b)).toBe(false);
  });

  it("las tres listas no se pisan entre sí", () => {
    // Un texto en dos listas haría que el resultado dependa del orden de los
    // `if`, que es exactamente el tipo de bug que no se ve.
    const todas = [...BOTONES_CONFIRMAR, ...BOTONES_NO_CONFIRMAR, ...BOTONES_OTRAS_PLANTILLAS];
    expect(new Set(todas).size).toBe(todas.length);
    for (const b of BOTONES_CONFIRMAR) expect(apreta(b)).toBe(true);
    for (const b of BOTONES_NO_CONFIRMAR) expect(apreta(b)).toBe(false);
  });

  it("la plantilla nueva también cuenta como 'le llegó la plantilla'", () => {
    const conNueva = [
      msg({ rol: "Propietario", tipo: "template", plantilla: "confirmacion_datos_v1", fecha: t(9) }),
      msg({ tipo: "button", texto: "Sí, está correcto", fecha: t(9) }),
    ];
    const s = derivarSenal(conNueva, conNueva);
    expect(s.recibioPlantilla).toBe(true);
    expect(s.riesgo).toBe("confirmado");
  });

  it("PLANTILLA_CONFIRMACION sigue siendo una de las de la lista", () => {
    // El export viejo se quedó por compatibilidad; si alguien lo cambia sin
    // tocar la lista, `recibioPlantilla` empieza a mentir.
    expect(PLANTILLAS_CONFIRMACION).toContain(PLANTILLA_CONFIRMACION);
  });
});

describe("la alarma de ceguera: un botón que no se sabe leer se DENUNCIA", () => {
  it("un botón nuevo aparece en botonesDesconocidos con su texto", () => {
    // Es lo único que separa "se cableó una plantilla nueva" de "hace dos días
    // que nadie confirma". Sin esto la falla es muda.
    const conv = [
      plantilla(),
      msg({ tipo: "button", texto: "Dale, mándenlo", fecha: t(10) }),
    ];
    const s = derivarSenal(conv, conv);
    expect(s.botonesDesconocidos).toEqual(["Dale, mándenlo"]);
    expect(s.riesgo).not.toBe("confirmado");
  });

  it("los botones conocidos NO disparan la alarma", () => {
    const conocidos = [
      ...BOTONES_CONFIRMAR, ...BOTONES_NO_CONFIRMAR, ...BOTONES_OTRAS_PLANTILLAS,
    ].map((texto, i) => msg({ tipo: "button", texto, fecha: t(10 + (i % 8)) }));
    expect(derivarSenal(conocidos, conocidos).botonesDesconocidos).toEqual([]);
    for (const m of conocidos) expect(esBotonConocido(m)).toBe(true);
  });

  it("el mismo botón raro repetido se denuncia UNA vez", () => {
    const conv = [
      msg({ tipo: "button", texto: "Otra cosa", fecha: t(10) }),
      msg({ tipo: "button", texto: "Otra cosa", fecha: t(11) }),
    ];
    expect(derivarSenal(conv, conv).botonesDesconocidos).toEqual(["Otra cosa"]);
  });

  it("sin conversación leída no se denuncia nada (no se inventa una alarma)", () => {
    expect(derivarSenal(null, null).botonesDesconocidos).toEqual([]);
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
