import { describe, it, expect } from "vitest";
// Cruza el límite a la lógica pura que vive en _shared (la importa la edge
// function Deno); acá se prueba porque `npm test` no corre las de supabase/functions.
import {
  esConsultaEstado,
  faseDePedido,
  componerEstadoPedido,
} from "../../supabase/functions/_shared/estadoPedidoRespuesta";

describe("esConsultaEstado — detector de intención", () => {
  it("reconoce las formas reales de preguntar por el envío", () => {
    const si = [
      "cuál es mi guía?",
      "cual es mi guia",
      "¿cuándo llega mi pedido?",
      "cuando me llega",
      "dónde está mi pedido",
      "donde va mi paquete",
      "ya lo enviaron?",
      "me pueden dar el número de rastreo",
      "cuánto falta para que llegue",
      "quiero el seguimiento de mi compra",
      "con qué transportadora va",
      "en cuánto tiempo me llega",
    ];
    for (const t of si) expect(esConsultaEstado(t), t).toBe(true);
  });

  it("NO confunde una consulta de venta o un saludo con estado", () => {
    const no = [
      "hola",
      "gracias",
      "cuánto cuesta?",
      "quiero comprar las gafas",
      "me interesa el producto",
      "es original?",
      "qué tallas tienen",
      "",
      "ok",
    ];
    for (const t of no) expect(esConsultaEstado(t), t).toBe(false);
  });
});

describe("faseDePedido — estado crudo → fase de cliente", () => {
  it("clasifica los estados principales de CO y EC", () => {
    expect(faseDePedido("ENTREGADO")).toBe("entregado");
    expect(faseDePedido("DEVOLUCION")).toBe("devolucion");
    expect(faseDePedido("DEVOLUCION EN TRANSITO")).toBe("devolucion");
    expect(faseDePedido("CANCELADO")).toBe("cancelado");
    expect(faseDePedido("ARCHIVADO GHOST")).toBe("cancelado");
    expect(faseDePedido("NOVEDAD")).toBe("novedad");
    expect(faseDePedido("INTENTO DE ENTREGA")).toBe("novedad");
    expect(faseDePedido("RECLAME EN OFICINA")).toBe("en_oficina");
    expect(faseDePedido("EN TRANSITO")).toBe("en_camino");
    expect(faseDePedido("EN REPARTO")).toBe("en_camino");
    expect(faseDePedido("GUIA GENERADA")).toBe("preparando");
    expect(faseDePedido("PENDIENTE")).toBe("preparando");
    expect(faseDePedido("ALISTAMIENTO")).toBe("preparando");
  });

  it("lo que no reconoce cae en 'desconocido' (para derivar, no adivinar)", () => {
    expect(faseDePedido("")).toBe("desconocido");
    expect(faseDePedido(null)).toBe("desconocido");
    expect(faseDePedido("UN ESTADO RARO QUE DROPI INVENTO")).toBe("desconocido");
  });
});

describe("componerEstadoPedido — el mensaje", () => {
  it("EN CAMINO: da guía, transportadora, rastreo y recuerda el pago COD", () => {
    const r = componerEstadoPedido({
      nombre: "Carlos Bermeo",
      estado: "EN TRANSITO",
      guia: "123456",
      transportadora: "SERVIENTREGA",
      trackingUrl: "https://track.example/123456",
    });
    expect(r.fase).toBe("en_camino");
    expect(r.derivarAHumano).toBe(false);
    expect(r.incluyeGuia).toBe(true);
    expect(r.texto).toContain("Carlos"); // solo primer nombre
    expect(r.texto).toContain("123456");
    expect(r.texto).toContain("SERVIENTREGA");
    expect(r.texto).toContain("https://track.example/123456");
    expect(r.texto.toLowerCase()).toContain("contra entrega");
    // usted, no voseo
    expect(r.texto).not.toMatch(/\bten[ée]s\b|\bpod[ée]s\b/i);
  });

  it("EN CAMINO sin guía: NO inventa un número", () => {
    const r = componerEstadoPedido({ estado: "EN REPARTO", guia: null, transportadora: "LAAR" });
    expect(r.fase).toBe("en_camino");
    expect(r.incluyeGuia).toBe(false);
    expect(r.texto).not.toContain("guía *"); // no hay guía falsa
    expect(r.texto.toLowerCase()).toContain("en camino");
  });

  it("EN OFICINA: dice que lo retire y ofrece la dirección", () => {
    const r = componerEstadoPedido({ nombre: "Ana", estado: "RECLAME EN OFICINA", guia: "999", transportadora: "GINTRACOM" });
    expect(r.fase).toBe("en_oficina");
    expect(r.derivarAHumano).toBe(false);
    expect(r.texto.toLowerCase()).toContain("oficina");
    expect(r.texto).toContain("999");
  });

  it("NOVEDAD: cálido y ofrece reprogramar (no asusta ni culpa)", () => {
    const r = componerEstadoPedido({ nombre: "Luis", estado: "NOVEDAD", guia: "555", transportadora: "SERVIENTREGA" });
    expect(r.fase).toBe("novedad");
    expect(r.derivarAHumano).toBe(false);
    expect(r.texto.toLowerCase()).toContain("reprogram");
    expect(r.texto.toLowerCase()).not.toContain("ley"); // nada de amenazas tipo "ley 67"
  });

  it("PREPARANDO con guía la da; sin guía es honesto", () => {
    const con = componerEstadoPedido({ estado: "GUIA GENERADA", guia: "777" });
    expect(con.fase).toBe("preparando");
    expect(con.texto).toContain("777");

    const sin = componerEstadoPedido({ estado: "PENDIENTE", guia: null });
    expect(sin.incluyeGuia).toBe(false);
    expect(sin.texto).not.toContain("*"); // no hay número en negrita inventado
    expect(sin.texto.toLowerCase()).toContain("guía");
  });

  it("ENTREGADO y DEVOLUCION responden sin escalar", () => {
    const e = componerEstadoPedido({ estado: "ENTREGADO", nombre: "Sofía" });
    expect(e.fase).toBe("entregado");
    expect(e.derivarAHumano).toBe(false);
    expect(e.texto).toContain("Sofía");

    const d = componerEstadoPedido({ estado: "DEVOLUCION" });
    expect(d.fase).toBe("devolucion");
    expect(d.texto.toLowerCase()).toContain("nuevo envío");
  });

  it("CANCELADO y DESCONOCIDO se DERIVAN a un humano (texto vacío)", () => {
    const c = componerEstadoPedido({ estado: "CANCELADO" });
    expect(c.derivarAHumano).toBe(true);
    expect(c.texto).toBe("");

    const x = componerEstadoPedido({ estado: "ALGO_QUE_NO_EXISTE" });
    expect(x.fase).toBe("desconocido");
    expect(x.derivarAHumano).toBe(true);
    expect(x.texto).toBe("");
  });

  it("sin nombre saluda igual, sin quedar '¡Hola undefined!'", () => {
    const r = componerEstadoPedido({ estado: "EN TRANSITO", guia: "1", nombre: null });
    expect(r.texto.startsWith("¡Hola!")).toBe(true);
  });
});

// ── Lo que agregó el responder automático (4-sep-2026) ───────────────────────
import {
  esNumeroSuelto,
  esPromesaPendiente,
  elegirPedidoParaResponder,
} from "../../supabase/functions/_shared/estadoPedidoRespuesta";

describe("esNumeroSuelto — el cliente contestó con su número", () => {
  it("acepta teléfonos y números de pedido pelados, con o sin separadores", () => {
    for (const t of ["0960915765", "+593 96 091 5765", "6821793", "593-99-868-1178", " 0999263107 "]) {
      expect(esNumeroSuelto(t), t).toBe(true);
    }
  });
  it("no acepta texto, números cortos ni cantidades", () => {
    for (const t of ["hola", "2", "ok 3", "quiero 2 gafas", "", "12345", "1".repeat(14), "$29,99"]) {
      expect(esNumeroSuelto(t), t).toBe(false);
    }
  });
});

describe("esPromesaPendiente — el negocio dijo que verificaba y no volvió", () => {
  it("reconoce las promesas reales del bot y de la asesora", () => {
    const si = [
      "Perfecto, ya lo busco con ese número 😊 Un momentito que lo verifico con el equipo y le confirmo por aquí 🙏",
      "Déjeme revisar el detalle de su envío y ya mismo le confirmo por aquí 🙏",
      "Permítame verificar el estado de su pedido, deme un momento por favor",
      "dejame verificar y le aviso por aquí",
    ];
    for (const t of si) expect(esPromesaPendiente(t), t).toBe(true);
  });
  it("una respuesta que YA trae la guía, un saludo o una venta no son promesas", () => {
    const no = [
      "¡Buenas noticias! Su 1 x GAFAS ya tiene guía y salió de bodega. Guía LC55165087",
      "Su guía es 6805342, va con Servientrega",
      "Hola, ¿en qué le puedo ayudar?",
      "Perfecto, ¿me confirma con qué número hizo el pedido?",
      "Gracias por su compra",
      "",
    ];
    for (const t of no) expect(esPromesaPendiente(t), t).toBe(false);
  });
});

describe("elegirPedidoParaResponder — por cuál pedido se contesta", () => {
  const ahora = Date.UTC(2026, 8, 4, 12, 0, 0);
  const dias = (n: number) => ahora - n * 86400_000;
  it("con un solo pedido vivo responde por ese", () => {
    const r = elegirPedidoParaResponder([{ estado: "NOVEDAD", movidoMs: dias(1) }], ahora);
    expect(r.motivo).toBe("unico");
    expect(r.pedido?.estado).toBe("NOVEDAD");
  });
  it("descarta el REEMPLAZADO y el CANCELADO: el vivo es el que queda", () => {
    const r = elegirPedidoParaResponder([
      { estado: "REEMPLAZADA", movidoMs: dias(2) },
      { estado: "CANCELADO", movidoMs: dias(3) },
      { estado: "EN TRANSITO", movidoMs: dias(0) },
    ], ahora);
    expect(r.motivo).toBe("unico");
    expect(r.pedido?.estado).toBe("EN TRANSITO");
  });
  it("un entregado viejo no compite; uno reciente sí cuenta como vivo", () => {
    expect(elegirPedidoParaResponder([
      { estado: "ENTREGADO", movidoMs: dias(30) },
      { estado: "EN REPARTO", movidoMs: dias(0) },
    ], ahora).motivo).toBe("unico");
    expect(elegirPedidoParaResponder([
      { estado: "ENTREGADO", movidoMs: dias(2) },
      { estado: "EN REPARTO", movidoMs: dias(0) },
    ], ahora).motivo).toBe("ambiguo");
  });
  it("dos vivos = ambiguo (no se responde); ninguno vivo lo dice; sin pedidos lo dice", () => {
    expect(elegirPedidoParaResponder([
      { estado: "NOVEDAD", movidoMs: dias(1) }, { estado: "EN TRANSITO", movidoMs: dias(1) },
    ], ahora).motivo).toBe("ambiguo");
    expect(elegirPedidoParaResponder([{ estado: "CANCELADO", movidoMs: dias(1) }], ahora).motivo).toBe("sin_vivos");
    expect(elegirPedidoParaResponder([], ahora).motivo).toBe("sin_pedidos");
  });
});
