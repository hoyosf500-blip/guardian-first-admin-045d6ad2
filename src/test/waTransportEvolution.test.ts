// Test del parseo de Evolution en el transporte WhatsApp (lógica pura, sin red).
// Importa el módulo compartido de las edge functions: es TypeScript puro (sin
// globals de Deno al cargar), así que Vitest lo puede ejercitar tal cual. Esto
// valida el contrato `messages.upsert` → WaInboundMessage SIN necesitar el server
// de Evolution levantado (lo único que no se puede testear acá es el sendText en
// vivo). Ver supabase/functions/_shared/waTransport.ts (EvolutionTransport).
import { describe, it, expect } from "vitest";
import { getWaTransport } from "../../supabase/functions/_shared/waTransport";

const evo = getWaTransport("evolution", { token: "k", base: "https://bot.x", instanceName: "co" });

describe("EvolutionTransport.parseInbound", () => {
  it("normaliza un messages.upsert de texto plano", () => {
    const out = evo.parseInbound({
      event: "messages.upsert",
      instance: "co",
      data: {
        key: { remoteJid: "573001112233@s.whatsapp.net", fromMe: false, id: "ABC123" },
        pushName: "Helena",
        messageType: "conversation",
        message: { conversation: "Hola, ¿dónde está mi pedido?" },
        messageTimestamp: 1719123456,
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      waMessageId: "ABC123",
      fromPhone: "573001112233",
      fromName: "Helena",
      body: "Hola, ¿dónde está mi pedido?",
      fromMe: false,
      isGroup: false,
      timestamp: 1719123456,
    });
  });

  it("lee el texto de extendedTextMessage (mensaje con link/cita)", () => {
    const out = evo.parseInbound({
      event: "messages.upsert",
      data: { key: { remoteJid: "573002@s.whatsapp.net", id: "x" }, message: { extendedTextMessage: { text: "con link" } } },
    });
    expect(out[0].body).toBe("con link");
  });

  it("captura el caption de imagen como body + media", () => {
    const out = evo.parseInbound({
      event: "messages.upsert",
      data: { key: { remoteJid: "573003@s.whatsapp.net", id: "img1" }, messageType: "imageMessage", message: { imageMessage: { caption: "mirá esto" } } },
    });
    expect(out[0].body).toBe("mirá esto");
    expect(out[0].media).toMatchObject({ kind: "imageMessage", caption: "mirá esto" });
  });

  it("marca isGroup para remoteJid @g.us", () => {
    const out = evo.parseInbound({
      event: "messages.upsert",
      data: { key: { remoteJid: "120363000000@g.us", id: "g1" }, message: { conversation: "hola grupo" } },
    });
    expect(out[0].isGroup).toBe(true);
  });

  it("ignora eventos que NO son messages.upsert", () => {
    expect(evo.parseInbound({ event: "messages.update", data: { key: { remoteJid: "573004@s.whatsapp.net", id: "u1" } } })).toEqual([]);
    expect(evo.parseInbound({ event: "connection.update", data: { state: "open" } })).toEqual([]);
  });

  it("acepta data como ARRAY y descarta los que no tienen id/teléfono", () => {
    const out = evo.parseInbound({
      event: "messages.upsert",
      data: [
        { key: { remoteJid: "573005@s.whatsapp.net", id: "a" }, message: { conversation: "uno" } },
        { key: {}, message: { conversation: "sin key" } },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].waMessageId).toBe("a");
  });

  it("acepta payload sin `event` (cae a detección por forma)", () => {
    const out = evo.parseInbound({
      data: { key: { remoteJid: "573006@s.whatsapp.net", id: "noevt" }, message: { conversation: "hola" } },
    });
    expect(out[0].waMessageId).toBe("noevt");
  });
});
