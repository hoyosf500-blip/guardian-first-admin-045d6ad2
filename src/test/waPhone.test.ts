// Tests del helper puro de teléfono (sufijo / match) que usa el modo solo-warm de
// wa-status-notifier. Sin red ni Deno. Ver supabase/functions/_shared/waPhone.ts.
import { describe, it, expect } from "vitest";
import { phoneSuffix, samePhone } from "../../supabase/functions/_shared/waPhone";

describe("phoneSuffix", () => {
  it("toma los últimos 10 dígitos y limpia el formato", () => {
    expect(phoneSuffix("+57 320 963 2914")).toBe("3209632914");
    expect(phoneSuffix("573209632914")).toBe("3209632914");
    expect(phoneSuffix("3209632914")).toBe("3209632914");
    expect(phoneSuffix("0593987654321")).toBe("3987654321"); // EC con 0 inicial
  });
  it("devuelve lo que hay si es más corto, y vacío para nulos", () => {
    expect(phoneSuffix("123")).toBe("123");
    expect(phoneSuffix("")).toBe("");
    expect(phoneSuffix(null)).toBe("");
    expect(phoneSuffix(undefined)).toBe("");
  });
});

describe("samePhone", () => {
  it("matchea por sufijo aunque difiera el formato o el código de país", () => {
    expect(samePhone("573209632914", "3209632914")).toBe(true);
    expect(samePhone("+57 320 963 2914", "0003209632914")).toBe(true);
  });
  it("NO matchea distintos, vacíos ni números demasiado cortos", () => {
    expect(samePhone("3209632914", "3001112233")).toBe(false);
    expect(samePhone("", "")).toBe(false);
    expect(samePhone("123", "123")).toBe(false); // <7 dígitos → evita falso positivo
  });
});
