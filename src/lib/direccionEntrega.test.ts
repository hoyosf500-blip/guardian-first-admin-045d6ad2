import { describe, it, expect } from "vitest";
import { agregarLlamarParaLaEntrega, yaPideLlamar } from "./direccionEntrega";

describe("agregarLlamarParaLaEntrega — la coletilla que la asesora escribía a mano", () => {
  it("agrega la coletilla con el guion que usa el equipo", () => {
    expect(agregarLlamarParaLaEntrega("Calle 37 y Chember, arriba de la panadería"))
      .toBe("Calle 37 y Chember, arriba de la panadería - llamar para la entrega");
  });

  it("es idempotente: si ya la tiene, no la duplica (mayúsculas incluidas)", () => {
    const con = "Av. Eloy Alfaro 102 - llamar para la entrega";
    expect(agregarLlamarParaLaEntrega(con)).toBe(con);
    expect(agregarLlamarParaLaEntrega("Av. Eloy Alfaro 102 - LLAMAR PARA LA ENTREGA")).toBe("Av. Eloy Alfaro 102 - LLAMAR PARA LA ENTREGA");
  });

  it("no produce guiones dobles ni puntuación colgando", () => {
    expect(agregarLlamarParaLaEntrega("Calle 5 - ")).toBe("Calle 5 - llamar para la entrega");
    expect(agregarLlamarParaLaEntrega("Calle 5, ")).toBe("Calle 5 - llamar para la entrega");
    expect(agregarLlamarParaLaEntrega("Calle 5.")).toBe("Calle 5 - llamar para la entrega");
  });

  it("con dirección vacía devuelve vacío (no inventa una dirección que solo dice «llamar»)", () => {
    expect(agregarLlamarParaLaEntrega("")).toBe("");
    expect(agregarLlamarParaLaEntrega("   ")).toBe("");
    expect(agregarLlamarParaLaEntrega(null)).toBe("");
  });

  it("yaPideLlamar reconoce variantes de espaciado", () => {
    expect(yaPideLlamar("x -  llamar  para la entrega")).toBe(true);
    expect(yaPideLlamar("x - llamar antes")).toBe(false);
    expect(yaPideLlamar(undefined)).toBe(false);
  });
});
