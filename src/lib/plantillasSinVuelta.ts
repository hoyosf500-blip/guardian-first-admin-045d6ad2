// src/lib/plantillasSinVuelta.ts
//
// A QUIÉN LE QUEDÓ COLGADO UN CLIENTE: mensajes que salieron y nunca volvieron.
//
// ── Por qué existe (pedido del dueño, 3-sep-2026) ───────────────────────────
// Textual: *"tengo un supervisor que siento que manda plantillas con el botón
// en automático, hace un solo intento y no está pendiente si respondieron"*.
//
// Ese comportamiento hoy es invisible en TODO el CRM. El estado tenía nombre
// desde agosto —`estadoConversacion` devuelve `'sin_respuesta'`, *"le
// escribimos y el cliente nunca contestó nada"*— y se usaba en UN solo lugar
// decorativo. Nadie lo contaba, y menos por persona.
//
// ── ⛔ POR QUÉ LA ATRIBUCIÓN NO SALE DE `chat_saliente_tipo` ────────────────
// Existe una columna `orders.chat_saliente_tipo` con los valores 'plantilla' y
// 'directo', y sería el camino obvio para contar plantillas. **No sirve para
// acusar a nadie**: dice QUÉ se mandó, no QUIÉN lo mandó. El propio
// `actividadChat.ts` lo advierte — *"el export de ImporChat NO dice si fue el
// bot o una asesora"*— y el bot manda plantillas todo el día. Contar así le
// cargaría a una persona el trabajo de un robot, y con ese número no se puede
// hablar con nadie.
//
// La atribución sale del SELLO de gestión (`touchpoints`), que lleva
// `operator_id`: la última persona que tocó ese teléfono. Es la que lo dejó
// esperando, y es la única afirmación que los datos sostienen.
//
// ⛔ Y lo que no se puede atribuir NO se le cuelga a nadie: va aparte, en
// `sinAtribuir`. Un cliente al que le escribió el bot y nadie más tocó no es
// culpa de ninguna asesora.
//
// Puro: sin red, sin React, sin reloj.

export interface ClienteColgado {
  phone: string;
  /** ms epoch del último mensaje NUESTRO. `null` = no se sabe. */
  salienteAt: number | null;
}

/** Lo mínimo que hace falta del sello: quién tocó por último ese teléfono. */
export interface SelloMinimo {
  operatorId: string;
  createdAt: string;
}

export interface ResumenSinVuelta {
  /** operatorId → cuántos clientes suyos quedaron sin respuesta. */
  porAsesora: Map<string, number>;
  /** Clientes colgados que NO se le pueden achacar a ninguna persona. */
  sinAtribuir: number;
  /** Total de clientes colgados (la suma de todo lo de arriba). */
  total: number;
}

const VACIO: ResumenSinVuelta = { porAsesora: new Map(), sinAtribuir: 0, total: 0 };

/**
 * Reparte los clientes colgados entre quienes los tocaron por última vez.
 *
 * `selloDe` devuelve el último toque de ese teléfono (de `useSelloGestion`), o
 * `null` si no hay ninguno registrado.
 *
 * ⛔ `medido = false` (la lectura de sellos falló) devuelve TODO en cero y sin
 * atribuir. Sin sellos, cada cliente colgado parecería "de nadie" y el dueño
 * leería «0 colgados» de una asesora que sí tiene cinco. Un cero que sale de no
 * haber podido leer se lee como una buena noticia — es el error que este
 * proyecto ya cometió tres veces.
 */
export function resumirSinVuelta(
  colgados: ClienteColgado[] | null | undefined,
  selloDe: (phone: string) => SelloMinimo | null | undefined,
  medido: boolean,
): ResumenSinVuelta {
  if (!medido || !colgados || colgados.length === 0) return VACIO;

  const porAsesora = new Map<string, number>();
  let sinAtribuir = 0;

  for (const c of colgados) {
    const sello = c.phone ? selloDe(c.phone) : null;
    if (!sello?.operatorId) { sinAtribuir++; continue; }
    porAsesora.set(sello.operatorId, (porAsesora.get(sello.operatorId) ?? 0) + 1);
  }

  return { porAsesora, sinAtribuir, total: colgados.length };
}

/**
 * La frase para la tarjeta del dueño. `null` en cero: una asesora sin clientes
 * colgados no necesita una línea que lo diga — solo agrega ruido a la tarjeta y
 * hace que las que SÍ tienen se pierdan entre las demás.
 */
export function textoSinVuelta(cuantos: number): string | null {
  if (!Number.isFinite(cuantos) || cuantos <= 0) return null;
  return cuantos === 1
    ? '1 cliente sin respuesta y sin 2º intento'
    : `${cuantos} clientes sin respuesta y sin 2º intento`;
}
