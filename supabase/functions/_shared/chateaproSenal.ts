// La señal de confirmación en Chatea Pro (Colombia).
//
// ── Qué es y por qué vale tanto ────────────────────────────────────────────
// Lo que el cliente hace con el botón de la plantilla de confirmación parte la
// población en dos mundos. Medido en Ecuador sobre 765 pedidos resueltos de
// agosto-2026:
//
//     apretó "CONFIRMAR PEDIDO" ....  402 → 10,4% cancela
//     NO lo apretó ................  220 → 57,7% cancela  ($3.928, el 62% de
//                                          toda la plata cancelada del mes)
//
// Y llega a tiempo: la mediana entre que sale la plantilla y que aprietan es
// 0,0 h. Se sabe en el primer minuto.
//
// ── Lo que se midió en Colombia el 2-sep-2026 ──────────────────────────────
// Las 8 plantillas de confirmación de la cuenta traen los MISMOS dos botones:
//
//     QUICK_REPLY: "CONFIRMAR PEDIDO"   ← confirma
//     QUICK_REPLY: "Modificar Datos"    ← no confirma
//
// (más "Hablar con asesor" en las dos de carrito). Y el apretón llega en el
// hilo así — leído del pedido 88110734, CANDIDA VILORIA:
//
//     negocio | wa_template | "Hola, CANDIDA\n\nQueremos confirmar los da…"
//     cliente | postback    | "CONFIRMAR PEDIDO"
//
// O sea `msg_type: "postback"`, no "button" como en ImporChat. Ese es todo el
// trabajo del adaptador de acá abajo.
//
// ── Por qué la lista de plantillas NO está escrita a mano ──────────────────
// ⛔ La lección más cara de este archivo viene de Ecuador. El 27-ago-2026 se
// cambió la plantilla de confirmación en el panel; la nueva era mejor, pero su
// botón decía otra cosa y el código buscaba el texto viejo. Resultado:
//
//     26-ago: 25 de 43 confirmados (58%)
//     27-ago:  1 de 45  (2%)
//     28-ago:  0 de 41  (0%)
//
// Cero, sin un solo error en ningún log, durante dos días — con la asesora
// llamando a gente que ya había confirmado. Por eso acá las plantillas de
// confirmación **se descubren solas**: `plantillasQueConfirman()` mira los
// botones que Chatea Pro declara en cada plantilla y se queda con las que
// ofrecen uno de confirmar. Si mañana crean `confirmacion_v9`, entra sola.

import {
  esBotonConfirmar,
  clasificar,
  type MensajeChat,
  type NivelRiesgo,
} from "./senalConfirmacion.ts";
import type { MensajeConversacion } from "./conversacion.ts";

/** Una plantilla tal como la devuelve `/whatsapp-template/list`. */
export interface PlantillaConBotones {
  name?: string;
  status?: string;
  components?: unknown;
}

/** Mayúsculas, sin tildes, espacios colapsados — igual que en ImporChat. */
function limpio(s: string | null | undefined): string {
  return (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * Los nombres de las plantillas que OFRECEN el botón de confirmar.
 *
 * Se descubre leyendo los `components` de cada plantilla, no de una lista
 * escrita a mano. Ver el comentario de arriba: una lista fija es exactamente lo
 * que apagó la señal dos días enteros en Ecuador.
 */
export function plantillasQueConfirman(crudas: PlantillaConBotones[]): Set<string> {
  const out = new Set<string>();
  for (const t of crudas ?? []) {
    const nombre = String(t?.name ?? "").trim();
    if (!nombre) continue;
    let comps = t?.components as unknown;
    if (typeof comps === "string") {
      try { comps = JSON.parse(comps); } catch { comps = []; }
    }
    if (!Array.isArray(comps)) continue;
    for (const c of comps as Array<Record<string, unknown>>) {
      if (String(c?.type ?? "").toUpperCase() !== "BUTTONS") continue;
      const botones = Array.isArray(c?.buttons) ? c.buttons as Array<Record<string, unknown>> : [];
      for (const b of botones) {
        // Se reusa `esBotonConfirmar` —la MISMA función que decide en el hilo—
        // para que no puedan desalinearse: si un día acepta un texto nuevo, la
        // plantilla que lo trae entra sola por acá.
        if (esBotonConfirmar({ rol: "Cliente", tipo: "button", texto: String(b?.text ?? ""), plantilla: null, fecha: new Date(0) })) {
          out.add(nombre);
        }
      }
    }
  }
  return out;
}

/**
 * Un mensaje de Chatea Pro con la forma que entiende `senalConfirmacion`.
 *
 * ⛔ `postback` es el apretón de un botón. En ImporChat ese tipo se llama
 * "button"; si no se traduce, `esBotonConfirmar` devuelve false para TODO el
 * mundo y la señal queda en cero sin dar ningún error — el mismo modo de falla
 * silenciosa del incidente de agosto.
 */
export function aMensajeChat(m: MensajeConversacion): MensajeChat {
  const tipo = String(m.tipo ?? "text").toLowerCase();
  return {
    rol: m.de === "cliente" ? "Cliente" : "Propietario",
    tipo: tipo === "postback" ? "button" : tipo,
    // En un postback el texto ES el botón; en una plantilla, `texto` ya trae el
    // cuerpo armado que leyó el cliente.
    texto: String(m.texto ?? ""),
    plantilla: m.plantilla ?? null,
    fecha: new Date(m.fechaMs ?? 0),
  };
}

export interface SenalChateapro {
  riesgo: NivelRiesgo;
  apretoBotonAt: Date | null;
  clienteEscribioAt: Date | null;
  recibioPlantilla: boolean;
  /** Botones que el cliente apretó y no reconocemos. Ver `esBotonConocido`. */
  botonesDesconocidos: string[];
}

/**
 * Deriva la señal de un pedido a partir del hilo de Chatea Pro.
 *
 * `confirmadoras` son los nombres que devolvió `plantillasQueConfirman`. El
 * nombre que trae el mensaje viene con prefijo de idioma
 * ("ES confirmacion_sin_imagen_v2"), así que se compara por "contiene" en vez
 * de por igualdad — comparar exacto contra un formato que no controlamos es
 * apostar a que nunca cambie.
 *
 * ⛔ `hilo` en `null` NO es "no pasó nada": es "no se pudo leer", y sale
 * `sin_dato`. Un pedido sin conversación leída no es un pedido tranquilo.
 */
export function senalDeHilo(
  hilo: MensajeConversacion[] | null,
  confirmadoras: Set<string>,
): SenalChateapro {
  if (!hilo) {
    return { riesgo: "sin_dato", apretoBotonAt: null, clienteEscribioAt: null, recibioPlantilla: false, botonesDesconocidos: [] };
  }
  const ms = hilo.map(aMensajeChat).sort((a, b) => a.fecha.getTime() - b.fecha.getTime());

  const boton = ms.find((m) => m.rol === "Cliente" && esBotonConfirmar(m)) ?? null;
  // Apretar un botón NO es escribir. La diferencia decide si al cliente le
  // sirve otro WhatsApp o hay que llamarlo por teléfono.
  const palabra = ms.find((m) => m.rol === "Cliente" && m.tipo !== "button") ?? null;
  const recibioPlantilla = ms.some((m) => {
    if (m.rol !== "Propietario" || !m.plantilla) return false;
    const n = limpio(m.plantilla);
    for (const c of confirmadoras) if (n.includes(limpio(c))) return true;
    return false;
  });
  // `mudo` se mide sobre el hilo COMPLETO, y acá el hilo ES completo: Chatea
  // Pro devuelve la conversación entera del contacto, no una ventana por
  // pedido. En ImporChat hacían falta dos listas por eso mismo.
  const mudo = !palabra;

  const conocidos = new Set<string>();
  for (const m of ms) {
    if (m.rol !== "Cliente" || m.tipo !== "button") continue;
    const t = limpio(m.texto);
    if (!t) continue;
    // Conocidos hoy en Colombia (medidos sobre las 28 plantillas de la cuenta):
    // el de confirmar, "Modificar Datos" y "Hablar con asesor". Cualquier otro
    // se reporta: es la señal de que se cableó una plantilla nueva y podríamos
    // estar ciegos AHORA MISMO sin un solo error.
    if (esBotonConfirmar(m) || t.includes("MODIFICAR DATOS") || t.includes("HABLAR CON ASESOR")) continue;
    conocidos.add(m.texto.trim());
  }

  return {
    riesgo: clasificar({ apreto: !!boton, escribio: !!palabra, recibioPlantilla, mudo }),
    apretoBotonAt: boton?.fecha ?? null,
    clienteEscribioAt: palabra?.fecha ?? null,
    recibioPlantilla,
    botonesDesconocidos: [...conocidos],
  };
}
