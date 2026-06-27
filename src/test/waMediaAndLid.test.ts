// Tests de la lógica pura de media (clasificación/marcador) y de la detección @lid
// en parseInbound. Sin red ni Deno globals — Vitest ejercita los módulos compartidos
// tal cual. Cubre el fix "el bot no se queda callado con audio" + el guard @lid
// (auditoría 2026-06-26). Ver supabase/functions/_shared/waMedia.ts + waTransport.ts.
import { describe, it, expect } from "vitest";
import { mediaKindOf, isAudioKind, mediaMarker } from "../../supabase/functions/_shared/waMedia";
import { getWaTransport, isLidJid } from "../../supabase/functions/_shared/waTransport";

describe("waMedia.mediaKindOf", () => {
  it("prefiere el kind del media (Evolution 'audioMessage')", () => {
    expect(mediaKindOf({ type: "text", media: { kind: "audioMessage" } })).toBe("audiomessage");
  });
  it("cae al type cuando no hay media.kind (WAHA 'ptt')", () => {
    expect(mediaKindOf({ type: "ptt", media: null })).toBe("ptt");
  });
  it("string vacío si no hay nada", () => {
    expect(mediaKindOf({})).toBe("");
  });
});

describe("waMedia.isAudioKind", () => {
  it("reconoce audio en ambos motores", () => {
    expect(isAudioKind("audiomessage")).toBe(true); // Evolution
    expect(isAudioKind("audio")).toBe(true); // WAHA
    expect(isAudioKind("ptt")).toBe(true); // nota de voz WEBJS
    expect(isAudioKind("voice")).toBe(true);
  });
  it("no confunde imagen/video con audio", () => {
    expect(isAudioKind("imageMessage")).toBe(false);
    expect(isAudioKind("video")).toBe(false);
  });
});

describe("waMedia.mediaMarker", () => {
  it("marca cada tipo de media de forma legible y NO vacía", () => {
    expect(mediaMarker("audiomessage")).toContain("nota de voz");
    expect(mediaMarker("imageMessage")).toContain("imagen");
    expect(mediaMarker("video")).toContain("video");
    expect(mediaMarker("documentMessage")).toContain("archivo");
    expect(mediaMarker("location")).toContain("ubicaci");
    // Nunca devuelve vacío → el bot siempre tiene algo a qué responder.
    expect(mediaMarker("loquesea").length).toBeGreaterThan(0);
  });
});

describe("isLidJid", () => {
  it("detecta JIDs @lid y descarta los normales", () => {
    expect(isLidJid("249553355121566@lid")).toBe(true);
    expect(isLidJid("573001112233@s.whatsapp.net")).toBe(false);
    expect(isLidJid("573001112233@c.us")).toBe(false);
    expect(isLidJid(undefined)).toBe(false);
    expect(isLidJid("")).toBe(false);
  });
});

describe("parseInbound marca isLid (guard anti-fantasma)", () => {
  const evo = getWaTransport("evolution", { token: "k", base: "https://bot.x", instanceName: "co" });
  const waha = getWaTransport("waha", { token: "k", base: "https://srv/waha", instanceName: "default" });

  it("Evolution: remoteJid @lid → isLid true", () => {
    const out = evo.parseInbound({
      event: "messages.upsert",
      data: { key: { remoteJid: "249553355121566@lid", id: "L1" }, message: { conversation: "hola" } },
    });
    expect(out).toHaveLength(1);
    expect(out[0].isLid).toBe(true);
  });

  it("Evolution: remoteJid normal → isLid false", () => {
    const out = evo.parseInbound({
      event: "messages.upsert",
      data: { key: { remoteJid: "573001112233@s.whatsapp.net", id: "N1" }, message: { conversation: "hola" } },
    });
    expect(out[0].isLid).toBe(false);
  });

  it("WAHA: from @lid → NO se descarta (isLid false) y keyea por el @lid completo", () => {
    const out = waha.parseInbound({
      event: "message",
      payload: { id: "W1", from: "249553355121566@lid", body: "hola" },
    });
    expect(out).toHaveLength(1);
    // WAHA (WhatsApp Web real) ENTREGA al @lid → no es fantasma: no se descarta y se
    // keyea/responde por su JID @lid completo (el teléfono real está oculto por LID).
    expect(out[0].isLid).toBe(false);
    expect(out[0].fromPhone).toBe("249553355121566@lid");
  });

  it("audio entrante (Evolution) llega con body vacío y media de audio → el webhook lo enriquece", () => {
    const out = evo.parseInbound({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "573001112233@s.whatsapp.net", id: "A1" },
        messageType: "audioMessage",
        message: { audioMessage: { seconds: 5, ptt: true } },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe(""); // sin texto…
    expect(isAudioKind(mediaKindOf(out[0]))).toBe(true); // …pero clasifica como audio
    expect(out[0].isLid).toBe(false);
  });

  it("WAHA: nota de voz con type SOLO en _data ('ptt') → se detecta como audio", () => {
    const out = waha.parseInbound({
      event: "message",
      payload: {
        id: "A1", from: "59945345110108@lid", fromMe: false, body: "", hasMedia: true,
        media: { url: "http://localhost:3000/api/files/default/A1.oga", mimetype: "audio/ogg; codecs=opus" },
        _data: { type: "ptt", notifyName: "Felipe" },
      },
    });
    expect(out).toHaveLength(1);
    expect(isAudioKind(mediaKindOf(out[0]))).toBe(true); // antes caía a "text" → no transcribía
    expect(out[0].body).toBe("");
  });

  it("WAHA: nota de voz SIN type ni _data → infiere audio por mimetype", () => {
    const out = waha.parseInbound({
      event: "message",
      payload: {
        id: "A2", from: "573001112233@c.us", fromMe: false, body: "", hasMedia: true,
        media: { url: "http://localhost:3000/api/files/default/A2.oga", mimetype: "audio/ogg" },
      },
    });
    expect(out).toHaveLength(1);
    expect(isAudioKind(mediaKindOf(out[0]))).toBe(true);
  });
});
