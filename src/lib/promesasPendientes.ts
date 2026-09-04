/**
 * LOS QUE EL BOT DEJÓ ESPERANDO A UNA PERSONA.
 *
 * ── De dónde sale (medido en producción, 4-sep-2026) ────────────────────────
 * La bandeja tenía dos canastas y las dos miran lo mismo: quién habló último.
 * «Nos escribieron» = el cliente habló y nadie contestó. «Sin respuesta» = le
 * escribimos y no contestó. Falta la tercera, y es la que el dueño reportó:
 * **el bot contestó — prometiendo que una persona sigue — y esa persona nunca
 * llegó.** Como el último mensaje es NUESTRO, esos clientes no aparecen en
 * ninguna de las dos canastas. Son invisibles.
 *
 * En una sola noche de Ecuador fueron 21. Textual, lo que recibieron:
 *   «Perfecto, en este momento procedemos con su despacho, en un momento le
 *    comparto su guía de envío 😊»
 *   «Un momentito 🙏 Déjeme verificar con el equipo por su pedido y le
 *    confirmo enseguida por aquí.»
 * Ese último era un cliente que había tocado «Corregir un dato» para pedir DOS
 * gafas en vez de una. Nadie volvió. No es solo un cliente molesto: es una
 * venta que se duplicaba y no se duplicó.
 *
 * ── Por qué no lo contesta el robot ─────────────────────────────────────────
 * `importchat-responder` ya responde solo cuando la pregunta es por el estado
 * del envío, y se ABSTIENE en estos casos a propósito (su veto). Está bien que
 * lo haga: a quien pidió cambiar la cantidad no se le contesta «su pedido está
 * en preparación» — eso lo dejaría peor, creyendo que ya se resolvió. Lo que
 * hace falta acá no es otro mensaje automático, es una persona. Esta lista es
 * esa cola de trabajo, y sale de las decisiones que el robot ya venía
 * escribiendo en `importchat_auto_respuestas`.
 *
 * Puro: sin red, sin React. Probado en `promesasPendientes.test.ts`.
 */

/** Margen para no contar como "atendido" el eco del propio mensaje que prometió. */
export const MARGEN_ATENDIDA_MS = 2 * 60_000;

/** Cuánto atrás se mira. Una promesa de anteayer ya no es una cola de hoy. */
export const DIAS_VENTANA_PROMESAS = 3;

export interface PromesaCruda {
  externalId: string;
  phone: string;
  /** Cuándo se hizo la promesa (ms epoch). */
  at: number;
  /** Por qué el robot no la contestó. Texto libre que escribe el responder. */
  motivo: string;
}

/**
 * ¿Este «omitido» del robot es trabajo para una persona?
 *
 * Los motivos son texto libre a propósito (agregar uno no puede costar una
 * migración), así que se reconocen por lo que dicen. Lo que NO entra:
 * problemas técnicos del robot y chats sin un pedido del que hablar — ahí no
 * hay nada que una asesora pueda hacer, y una cola con ruido se deja de mirar.
 */
export function necesitaPersona(motivo: string | null | undefined): boolean {
  const m = (motivo || '').toLowerCase().trim();
  if (!m) return false;
  // El chat siguió solo, o el robot no pudo releerlo: no hay promesa colgada.
  if (m.includes('el chat siguió') || m.includes('hilo vacío')) return false;
  // Sin pedido vivo no hay nada que contestar ni que mostrar en la ficha.
  if (m.includes('sin_vivos') || m.includes('sin_pedidos')) return false;
  return (
    m.includes('no era sobre el envío') ||   // prometió algo que el robot no sabe contestar
    m.includes('no responde a ningún mensaje') || // prometió sin que nadie preguntara
    m.includes('preguntó hace más de') ||    // preguntó hace rato y quedó viejo
    m.includes('derivar a humano') ||        // el robot no supo clasificar el pedido
    m.includes('ambiguo') ||                 // dos pedidos vivos: hay que elegir a mano
    m.includes('ventana')                    // pasadas 24 h solo entra una plantilla
  );
}

/** Lo que lee la asesora. Sin jerga: dice qué pasó y qué falta. */
export function motivoLegible(motivo: string | null | undefined): string {
  const m = (motivo || '').toLowerCase();
  if (m.includes('ventana')) return 'Pasaron 24 h: solo entra una plantilla';
  if (m.includes('ambiguo')) return 'Tiene más de un pedido vivo';
  if (m.includes('derivar a humano')) return 'El bot no supo qué contestar';
  if (m.includes('preguntó hace más de')) return 'Preguntó hace rato y quedó colgado';
  if (m.includes('no responde a ningún mensaje')) return 'El bot prometió sin que preguntara';
  if (m.includes('no era sobre el envío')) return 'El bot prometió que alguien le escribe';
  return 'El bot prometió y nadie volvió';
}

export interface EstadoChatPedido {
  /** Último mensaje NUESTRO (ms epoch) o null. */
  salienteAt: number | null;
  /** Último mensaje del CLIENTE (ms epoch) o null. */
  entranteAt: number | null;
}

/**
 * ¿La promesa sigue colgada?
 *
 * Se cae de la lista por dos caminos, y los dos son buenas noticias:
 *   · alguien de la casa escribió DESPUÉS de la promesa → la persona llegó;
 *   · el cliente volvió a escribir → ya está en «Nos escribieron», que es la
 *     canasta que se mira primero. Repetirlo en dos listas hace que se trabaje
 *     dos veces el mismo caso.
 *
 * El margen existe porque el mensaje que promete ES un mensaje nuestro: sin él,
 * toda promesa nacería "atendida" por su propio eco.
 */
export function promesaSigueAbierta(p: PromesaCruda, chat: EstadoChatPedido): boolean {
  if (!necesitaPersona(p.motivo)) return false;
  if (chat.salienteAt != null && chat.salienteAt > p.at + MARGEN_ATENDIDA_MS) return false;
  if (chat.entranteAt != null && chat.entranteAt > p.at) return false;
  return true;
}

/**
 * Una fila por cliente: la promesa MÁS NUEVA de cada pedido.
 *
 * El robot decide cada 3 minutos y puede anotar el mismo chat más de una vez
 * (otra promesa, otro motivo). La cola es de personas, no de decisiones.
 */
export function unaPorPedido<T extends PromesaCruda>(filas: T[]): T[] {
  const porPedido = new Map<string, T>();
  for (const f of filas) {
    if (!f.externalId) continue;
    const previa = porPedido.get(f.externalId);
    if (!previa || f.at > previa.at) porPedido.set(f.externalId, f);
  }
  // Quien lleva MÁS esperando primero: es a quien más urge no dejar enfriar.
  return [...porPedido.values()].sort((a, b) => a.at - b.at);
}
