// Cruce entre los contactos de Chatea Pro y los pedidos de Guardian.
//
// Es la lógica pura de `chateapro-sync`: decide, para cada pedido, si el
// cliente escribió y nadie contestó. Vive acá —y no dentro de la edge
// function— porque `npm test` NO corre las pruebas de `supabase/functions/`
// (ver CLAUDE.md); la prueba está en `src/lib/chateaproCruce.test.ts`.
//
// ── Por qué existe esto ────────────────────────────────────────────────────
// Medido el 2-sep-2026 sobre los 800 contactos de la cuenta de Colombia:
// **39 clientes habían escrito y nadie les había contestado**, 22 de ellos
// hacía más de un día y el más viejo hacía 97 horas. Entre ellos una clienta
// con el pedido en NOVEDAD —la transportadora esperando respuesta— y otra a la
// que le acababa de salir la guía.
//
// Guardian no podía verlos: la bandeja «Escribieron» se alimenta de
// `orders.chat_entrante_at`, que en Ecuador llena `importchat-sync` y en
// Colombia no llenaba nadie. En la base: EC 2.196 pedidos con ese dato de
// 3.426; CO **0 de 589**. La pantalla no decía "no lo puedo medir": decía
// *"Nadie esperando respuesta — todos los que escribieron ya fueron atendidos
// 🎉"*. Un cero afirmado sobre un dato que no existía.
//
// ── Lo que la lista de contactos SÍ da, y lo que no ────────────────────────
// `GET /subscribers` trae por contacto `last_message_at` y `last_message_type`
// ('in' = lo último lo escribió el cliente; 'out'/'agent' = lo último salió del
// negocio). O sea da el ÚLTIMO mensaje, no las dos fechas por separado.
//
// Alcanza justo para la pregunta que importa —¿está esperando respuesta?— sin
// abrir 800 conversaciones. Con `in` se escribe la fecha del entrante y NO se
// toca el saliente; con `out`/`agent`, al revés. Así `entrante > saliente`
// queda verdadero exactamente cuando el cliente es el último que habló, que es
// lo que `estadoConversacion` pregunta.

/** Un contacto tal como lo devuelve `GET /subscribers` (campos medidos). */
export interface ContactoCp {
  phone?: string | null;
  name?: string | null;
  /** 'YYYY-MM-DD HH:MM:SS' en hora del espacio de trabajo. */
  last_message_at?: string | null;
  /** 'in' | 'out' | 'agent'. */
  last_message_type?: string | null;
  status?: string | null;
}

/** Lo mínimo que hace falta de un pedido para cruzarlo. */
export interface PedidoCruce {
  external_id: string;
  phone?: string | null;
  /** ISO. Se usa para elegir el pedido más reciente del mismo teléfono. */
  fecha?: string | null;
  chat_entrante_at?: string | null;
  chat_saliente_at?: string | null;
}

/** Lo que hay que escribirle a un pedido. `null` = no tocar esa columna. */
export interface CambioChat {
  external_id: string;
  chat_entrante_at?: string;
  chat_saliente_at?: string;
  chat_saliente_tipo?: string;
}

/**
 * Los últimos 9 dígitos.
 *
 * Mismo criterio que `shopify-reconcile` y que el buscador de Chatea Pro: un
 * mismo número aparece como `3218877000`, `573218877000` y `+573218877000`
 * según quién lo haya guardado. Nueve dígitos es lo que sobrevive a las tres
 * formas sin juntar dos clientes distintos.
 */
export function last9(t: string | null | undefined): string {
  return String(t ?? "").replace(/\D/g, "").slice(-9);
}

/**
 * `'2026-09-02 14:38:24'` → ISO, interpretado en la zona del país.
 *
 * ⛔ NO se usa `new Date(texto)`: sin zona, el motor lo toma como hora LOCAL
 * del servidor —que en Supabase es UTC— y en Colombia eso adelanta el reloj
 * cinco horas. Un mensaje de hace 10 minutos pasaría a figurar dentro de 4 h 50
 * y la bandeja lo ordenaría último en vez de primero. Es la misma trampa que
 * ya costó el auto-reparto (ver `bogotaToday`).
 */
export function aIso(texto: string | null | undefined, offsetHoras = -5): string | null {
  const t = String(texto ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(t);
  if (!m) return null;
  const signo = offsetHoras < 0 ? "-" : "+";
  const abs = Math.abs(offsetHoras);
  const hh = String(Math.floor(abs)).padStart(2, "0");
  const mm = String(Math.round((abs % 1) * 60)).padStart(2, "0");
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${signo}${hh}:${mm}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ¿`a` es posterior a `b`? Un `b` vacío cuenta como "no hay nada". */
function masNuevo(a: string, b: string | null | undefined): boolean {
  if (!b) return true;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  return Number.isFinite(ta) && (!Number.isFinite(tb) || ta > tb);
}

/**
 * Qué escribir en cada pedido, a partir de los contactos de Chatea Pro.
 *
 * Reglas, todas por una razón:
 *
 *  1. **Un teléfono, un pedido.** La conversación de WhatsApp es una sola; si
 *     el cliente tiene dos pedidos, el dato va al MÁS RECIENTE. Repartirlo
 *     entre los dos pondría a la misma persona dos veces en la bandeja y la
 *     asesora escribiría dos veces por el mismo mensaje.
 *  2. **Nunca se escribe hacia atrás.** Si Guardian ya tiene una fecha más
 *     nueva —porque la asesora acaba de mandar un mensaje desde el CRM— el
 *     sync no la pisa con una más vieja. Sin esto, un mensaje recién enviado
 *     "desaparecería" hasta la próxima corrida y el pedido volvería a la
 *     bandeja como si nadie hubiera contestado.
 *  3. **Solo se toca el lado que el dato prueba.** `last_message_type` dice
 *     quién habló último y nada más; inventar la otra fecha sería afirmar algo
 *     que no se midió.
 */
export function cambiosDeChat(
  contactos: ContactoCp[],
  pedidos: PedidoCruce[],
  offsetHoras = -5,
): CambioChat[] {
  // El pedido más reciente por teléfono.
  const porTel = new Map<string, PedidoCruce>();
  for (const p of pedidos) {
    const k = last9(p.phone);
    if (k.length < 7) continue;
    const previo = porTel.get(k);
    if (!previo) { porTel.set(k, p); continue; }
    const a = new Date(p.fecha ?? 0).getTime();
    const b = new Date(previo.fecha ?? 0).getTime();
    if ((Number.isFinite(a) ? a : 0) > (Number.isFinite(b) ? b : 0)) porTel.set(k, p);
  }

  const cambios: CambioChat[] = [];
  const yaHecho = new Set<string>();
  for (const c of contactos) {
    const k = last9(c.phone);
    if (k.length < 7) continue;
    const p = porTel.get(k);
    if (!p || yaHecho.has(p.external_id)) continue;

    const cuando = aIso(c.last_message_at, offsetHoras);
    if (!cuando) continue;

    const tipo = String(c.last_message_type ?? "").toLowerCase();
    if (tipo === "in") {
      if (!masNuevo(cuando, p.chat_entrante_at)) continue;
      cambios.push({ external_id: p.external_id, chat_entrante_at: cuando });
    } else if (tipo === "out" || tipo === "agent") {
      if (!masNuevo(cuando, p.chat_saliente_at)) continue;
      cambios.push({
        external_id: p.external_id,
        chat_saliente_at: cuando,
        // 'agent' es una persona del equipo; 'out' es el bot o una plantilla.
        // La distinción ya existe en Guardian y decide si la tarjeta dice
        // "le escribió una asesora" o "salió un automático".
        chat_saliente_tipo: tipo === "agent" ? "directo" : "plantilla",
      });
    } else {
      continue;
    }
    yaHecho.add(p.external_id);
  }
  return cambios;
}
