import { describe, it, expect } from "vitest";
import { payloadTexto, payloadMedia, graphBase, TIPOS_MEDIA, META_API_VERSION_DEFAULT } from "./metaWhatsapp";

describe("payloadTexto", () => {
  it("arma el formato oficial de Meta para texto", () => {
    const p = payloadTexto("593983364222", "Hola, tu pedido está listo");
    expect(p).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "593983364222",
      type: "text",
      text: { preview_url: true, body: "Hola, tu pedido está listo" },
    });
  });

  it("recorta espacios del destino y del cuerpo", () => {
    const p = payloadTexto("  593983364222 ", "  hola  ") as any;
    expect(p.to).toBe("593983364222");
    expect(p.text.body).toBe("hola");
  });
});

describe("payloadMedia", () => {
  it("imagen con caption", () => {
    const p = payloadMedia("593983364222", "image", "https://x.com/a.jpg", { caption: "Mirá" }) as any;
    expect(p.type).toBe("image");
    expect(p.image).toEqual({ link: "https://x.com/a.jpg", caption: "Mirá" });
  });

  it("audio NUNCA lleva caption (Meta lo rechaza)", () => {
    const p = payloadMedia("593983364222", "audio", "https://x.com/a.ogg", { caption: "no va" }) as any;
    expect(p.type).toBe("audio");
    expect(p.audio).toEqual({ link: "https://x.com/a.ogg" });
    expect(p.audio.caption).toBeUndefined();
  });

  it("document lleva filename para que el cliente vea un nombre", () => {
    const p = payloadMedia("593983364222", "document", "https://x.com/g.pdf", { filename: "guia.pdf", caption: "tu guía" }) as any;
    expect(p.document).toEqual({ link: "https://x.com/g.pdf", caption: "tu guía", filename: "guia.pdf" });
  });

  it("video sin caption ni filename: solo el link", () => {
    const p = payloadMedia("593983364222", "video", "https://x.com/v.mp4") as any;
    expect(p.video).toEqual({ link: "https://x.com/v.mp4" });
  });

  it("el filename solo aplica a document, no a image", () => {
    const p = payloadMedia("593983364222", "image", "https://x.com/a.jpg", { filename: "foto.jpg" }) as any;
    expect(p.image.filename).toBeUndefined();
  });
});

describe("graphBase", () => {
  it("usa la versión por defecto si no se pasa una", () => {
    expect(graphBase()).toBe(`https://graph.facebook.com/${META_API_VERSION_DEFAULT}`);
    expect(graphBase(null)).toBe(`https://graph.facebook.com/${META_API_VERSION_DEFAULT}`);
    expect(graphBase("")).toBe(`https://graph.facebook.com/${META_API_VERSION_DEFAULT}`);
  });

  it("respeta una versión override", () => {
    expect(graphBase("v25.0")).toBe("https://graph.facebook.com/v25.0");
  });
});

describe("TIPOS_MEDIA", () => {
  it("son los 4 que Meta entrega por link", () => {
    expect([...TIPOS_MEDIA]).toEqual(["image", "audio", "video", "document"]);
  });
});
