// Test del parseo + validaciones de WAHA en el transporte WhatsApp (lógica pura,
// sin red). Importa el módulo compartido de las edge functions (TypeScript puro,
// sin globals de Deno al cargar). Valida el contrato evento "message" → WaInboundMessage
// SIN necesitar el server WAHA levantado. Lo único no testeable acá es el sendText
// en vivo (eso ya se verificó manualmente: entrega warm con ack DEVICE).
// Ver supabase/functions/_shared/waTransport.ts (WahaTransport).
import { describe, it, expect } from "vitest";
import { getWaTransport } from "../../supabase/functions/_shared/waTransport";

const waha = getWaTransport("waha", { token: "k", base: "https://srv.x/waha", instanceName: "default" });

describe("WahaTransport.parseInbound", () => {
  it("normaliza un evento 'message' de texto plano (from @c.us)", () => {
    const out = waha.parseInbound({
      event: "message",
      session: "default",
      payload: {
        id: "true_573001112233@c.us_ABC",
        from: "573001112233@c.us",
        to: "573164291009@c.us",
        fromMe: false,
        body: "Hola, ¿dónde está mi pedido?",
        type: "chat",
        timestamp: 1719123456,
        _data: { notifyName: "Helena" },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      waMessageId: "true_573001112233@c.us_ABC",
      fromPhone: "573001112233",
      fromName: "Helena",
      type: "text",
      body: "Hola, ¿dónde está mi pedido?",
      fromMe: false,
      isGroup: false,
      timestamp: 1719123456,
    });
  });

  it("usa notifyName de nivel superior si está presente", () => {
    const out = waha.parseInbound({
      event: "message",
      payload: { id: "x", from: "573002@c.us", body: "hi", notifyName: "Juan" },
    });
    expect(out[0].fromName).toBe("Juan");
  });

  it("captura imagen como media y normaliza el type", () => {
    const out = waha.parseInbound({
      event: "message",
      payload: {
        id: "img1",
        from: "573003@c.us",
        body: "mirá esto",
        type: "image",
        hasMedia: true,
        media: { url: "https://srv.x/file.jpg", mimetype: "image/jpeg" },
      },
    });
    expect(out[0].body).toBe("mirá esto");
    expect(out[0].type).toBe("image");
    expect(out[0].media).toMatchObject({ kind: "image", mimetype: "image/jpeg" });
  });

  it("marca isGroup para from @g.us", () => {
    const out = waha.parseInbound({
      event: "message",
      payload: { id: "g1", from: "120363000000@g.us", participant: "573004@c.us", body: "hola grupo" },
    });
    expect(out[0].isGroup).toBe(true);
  });

  it("ignora eventos que NO son message / message.any", () => {
    expect(waha.parseInbound({ event: "session.status", payload: { status: "WORKING" } })).toEqual([]);
    expect(waha.parseInbound({ event: "message.ack", payload: { id: "a", from: "573005@c.us", ack: 2 } })).toEqual([]);
  });

  it("acepta 'message.any' (incluye salientes; el fromMe se filtra aguas abajo)", () => {
    const out = waha.parseInbound({
      event: "message.any",
      payload: { id: "echo1", from: "573164291009@c.us", to: "573006@c.us", fromMe: true, body: "respuesta nuestra" },
    });
    expect(out).toHaveLength(1);
    expect(out[0].fromMe).toBe(true);
  });

  it("acepta el objeto crudo sin wrapper (detección por forma)", () => {
    const out = waha.parseInbound({ id: "noevt", from: "573007@c.us", body: "hola" });
    expect(out[0].waMessageId).toBe("noevt");
    expect(out[0].fromPhone).toBe("573007");
  });

  it("descarta mensajes sin id o sin teléfono", () => {
    expect(waha.parseInbound({ event: "message", payload: { from: "573008@c.us", body: "sin id" } })).toEqual([]);
    expect(waha.parseInbound({ event: "message", payload: { id: "x", body: "sin from" } })).toEqual([]);
  });
});

describe("WahaTransport.sendText (validaciones puras, sin red)", () => {
  it("rechaza teléfono inválido sin tocar la red", async () => {
    const r = await waha.sendText("", "hola");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/inválido/i);
  });

  it("exige provider_base https:// (anti-SSRF)", async () => {
    const insecure = getWaTransport("waha", { token: "k", base: "http://interno.local", instanceName: "default" });
    const r = await insecure.sendText("573001112233", "hola");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/https/i);
  });

  it("falla claro si no hay token", async () => {
    const noTok = getWaTransport("waha", { token: "", base: "https://srv.x/waha", instanceName: "default" });
    const r = await noTok.sendText("573001112233", "hola");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/token|X-Api-Key/i);
  });
});
