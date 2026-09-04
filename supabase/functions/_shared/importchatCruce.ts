import { normalizePhoneForCountry } from "./telefonoWhatsapp.ts";
import { esNumeroSuelto } from "./estadoPedidoRespuesta.ts";

/**
 * Cómo Guardian encuentra el pedido de un chat: por enlace, por el número que el
 * cliente escribió, o por el celular desde el que escribe.
 *
 * ⛔ Por qué existe (reportado y verificado el 4-sep-2026, Ecuador). El bot de
 * ImporChat le dijo al cliente *"con este número no me aparece un pedido
 * confirmado"* y le preguntó *"¿es 0986255535 o 986255535?"*. El pedido EXISTE:
 * `#6853503`, guardado con `phone = '986255535'`. El cliente lo escribió con el
 * cero inicial, como lo escribe cualquier ecuatoriano.
 *
 * Guardian tampoco pudo ayudar: `importchat-responder` cruzaba SOLO por
 * `importchat_chat_id` y, cuando el cliente mandaba su número, lo clasificaba
 * como disparador `"numero"` y **nunca lo leía**. Los dos ciegos a la vez.
 *
 * Censo del dato guardado (12.000 pedidos de Ecuador): 11.988 en 9 dígitos
 * limpios, 2 con 593, 8 de 8 dígitos, **ninguno con cero inicial**. O sea que el
 * dato está sano y el problema era del lado de la BÚSQUEDA. Por eso acá no se
 * toca ninguna ingesta: se normaliza al buscar, con la función que ya existe y
 * ya está probada (`normalizeEcuadorianPhone`, vía `normalizePhoneForCountry`).
 *
 * ── Las tres etapas, escalonadas y nunca fusionadas ─────────────────────────
 *
 *   1. `chat`             — `importchat_chat_id`. Corre siempre, igual que hoy.
 *   2. `telefono_mensaje` — el número que el cliente acaba de escribir.
 *   3. `celular_chat`     — el celular desde el que escribe (lo manda ImporChat).
 *
 * Las etapas 2 y 3 SOLO corren donde hoy el respondedor no hace nada, así que
 * ningún envío actual cambia de destinatario.
 *
 * ⛔ Y si la etapa 1 sale AMBIGUA (dos pedidos vivos colgando del chat) NO se cae
 * a la 2: la ambigüedad es real y callarse es la respuesta correcta. Es la misma
 * filosofía de `elegirPedidoParaResponder`, que se usa sin modificar.
 */

export type ViaCruce = "chat" | "telefono_mensaje" | "celular_chat";

export interface PedidoCruzable {
  external_id: string;
  phone: string | null;
  importchat_chat_id: string | number | null;
}

export interface IndicePedidos<T extends PedidoCruzable> {
  porChat: Map<string, T[]>;
  porTelefono: Map<string, T[]>;
  /** Cuántos pedidos tienen un teléfono que no normaliza para este país. No se
   *  adivinan: se cuentan y se reportan. */
  sinTelefonoNormalizable: number;
}

/**
 * El número que el cliente escribió, normalizado, o `null`.
 *
 * `esNumeroSuelto` acota a 6-13 dígitos, así que un número de pedido de 7 cifras
 * (`6853503`) entra igual — pero al normalizarlo para Ecuador no queda un móvil
 * válido y devuelve null. Ese es el filtro real, no la longitud.
 */
export function telefonoDelTexto(texto: string, cc: string): string | null {
  const t = String(texto ?? "").trim();
  if (!t || !esNumeroSuelto(t)) return null;
  return normalizePhoneForCountry(t, cc);
}

export function indexarPedidos<T extends PedidoCruzable>(pedidos: T[], cc: string): IndicePedidos<T> {
  const porChat = new Map<string, T[]>();
  const porTelefono = new Map<string, T[]>();
  let sinTelefonoNormalizable = 0;

  for (const p of pedidos) {
    if (p.importchat_chat_id !== null && p.importchat_chat_id !== undefined && p.importchat_chat_id !== "") {
      const k = String(p.importchat_chat_id);
      const arr = porChat.get(k);
      if (arr) arr.push(p); else porChat.set(k, [p]);
    }
    const tel = normalizePhoneForCountry(String(p.phone ?? ""), cc);
    if (!tel) { if (p.phone) sinTelefonoNormalizable++; continue; }
    const arr = porTelefono.get(tel);
    if (arr) arr.push(p); else porTelefono.set(tel, [p]);
  }

  return { porChat, porTelefono, sinTelefonoNormalizable };
}

export interface CandidatosCruce<T> {
  /** Los pedidos a pasarle a `elegirPedidoParaResponder`. Vacío = no hay por dónde. */
  candidatos: T[];
  via: ViaCruce | null;
}

/**
 * Elige POR QUÉ VÍA buscar el pedido. No decide cuál pedido: eso lo sigue
 * haciendo `elegirPedidoParaResponder`, que ya sabe descartar REEMPLAZADA,
 * cancelados y entregados viejos, y devolver `ambiguo` cuando quedan dos vivos.
 */
export function candidatosParaChat<T extends PedidoCruzable>(
  idx: IndicePedidos<T>,
  o: { chatId: string; textoCliente: string; celularChat?: string | null; cc: string },
): CandidatosCruce<T> {
  const delChat = idx.porChat.get(o.chatId);
  if (delChat && delChat.length > 0) return { candidatos: delChat, via: "chat" };

  const escrito = telefonoDelTexto(o.textoCliente, o.cc);
  if (escrito) {
    const porEscrito = idx.porTelefono.get(escrito);
    if (porEscrito && porEscrito.length > 0) return { candidatos: porEscrito, via: "telefono_mensaje" };
  }

  const celular = normalizePhoneForCountry(String(o.celularChat ?? ""), o.cc);
  if (celular) {
    const porCelular = idx.porTelefono.get(celular);
    if (porCelular && porCelular.length > 0) return { candidatos: porCelular, via: "celular_chat" };
  }

  return { candidatos: [], via: null };
}

/** El motivo que se anota cuando no hay pedido por ninguna vía.
 *
 *  ⛔ NO puede contener `sin_pedidos` ni `sin_vivos`: `necesitaPersona`
 *  (`src/lib/promesasPendientes.ts`) descarta esos motivos por subcadena, y
 *  entonces el caso nunca llegaría a una cola humana. */
export function motivoSinPedido(via: ViaCruce | null, hubo: { escrito: boolean }): string {
  if (via === null && hubo.escrito) return "el cliente dio un número y no hay pedido con ese número";
  return "el chat no tiene pedido ni por enlace ni por teléfono";
}
