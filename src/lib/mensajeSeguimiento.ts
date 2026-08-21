// src/lib/mensajeSeguimiento.ts
//
// Arma el mensaje de WhatsApp que la asesora le manda al cliente DESPUÉS de que
// el pedido salió — el de Seguimiento, no el de Confirmar (ese es
// `buildWhatsAppMessage`, que solo pide datos de dirección faltantes).
//
// ── Por qué existe ──────────────────────────────────────────────────────────
// Hasta el 21-ago-2026 en Seguimiento NO HABÍA BOTÓN DE WHATSAPP. El que había
// vivía detrás de `waEnabled` del bot, y al retirar el bot (13-ago) `waEnabled`
// quedó en `false` PARA SIEMPRE → el botón dejó de renderizarse en SegBoard,
// CrmTable y CrmCallView. La asesora que trabajaba la lista "En agencia" solo
// podía llamar. Los dos únicos wa.me que sobrevivieron (CallView, NovedadView)
// abrían el chat VACÍO: había que retipear guía, plazo y datos a mano en cada
// pedido.
//
// La auditoría de julio en Ecuador midió lo que eso cuesta: 76 devoluciones de
// paquetes que se quedaron esperando en la agencia hasta que la transportadora
// los mandó de vuelta ($2.316). Es la pérdida más barata de evitar de toda la
// operación — no hace falta mejor pauta ni mejor precio, hace falta avisarle al
// cliente a tiempo.
//
// ── Reglas que NO se negocian ───────────────────────────────────────────────
// 1. NUNCA inventar un dato. Sin guía no se escribe "Guía: undefined"; sin
//    transportadora se dice "la transportadora". Cada línea se agrega solo si
//    su dato existe. Un mensaje con un hueco es peor que uno más corto.
// 2. El plazo de la agencia se dice CORTO A PROPÓSITO. La transportadora
//    retiene ~7 días, acá se avisa a los DIAS_PARA_RECLAMAR (5). Errar hacia
//    "vení antes" es seguro; errar al revés manda al cliente a un mostrador
//    donde el paquete ya no está.
// 3. Es puro: sin red, sin Supabase, sin reloj implícito (entra por parámetro)
//    para poder testearlo con fechas fijas.

import type { SegStatusKey } from './segStatus';

/** Días tras la llegada a la oficina en los que le pedimos que lo reclame.
 *  Menor que los ~7 que la transportadora retiene: margen a favor del cliente. */
export const DIAS_PARA_RECLAMAR = 5;

export interface MensajeSeguimientoInput {
  nombre: string;
  producto: string;
  /** Fase del pedido (`classifySegEstado(o.estado)`). */
  fase: SegStatusKey;
  ciudad?: string;
  transportadora?: string;
  guia?: string;
  /** `getTrackingUrl(transportadora, guia, countryCode)` — ya resuelto por país. */
  trackingUrl?: string | null;
  /** Valor a cobrar YA FORMATEADO (`formatCOP` es country-aware: COP/USD/GTQ). */
  valorTexto?: string;
  /** Texto de la novedad tal como lo manda la transportadora. */
  novedad?: string;
  /** `orders.last_movement_at` — para la fase `oficina` es cuándo llegó a la agencia. */
  lastMovementAt?: string | null;
  /** Zona para calcular el día del plazo. CO/EC = -05, GT = -06. */
  timeZone?: string;
}

const limpio = (s: string | null | undefined): string => (s ?? '').trim();

/** Primer nombre, capitalizado. Dropi manda "MARIA FERNANDA GOMEZ" en mayúscula
 *  sostenida y un "Hola MARIA FERNANDA GOMEZ" se lee como una notificación de
 *  cobranza, no como una persona escribiendo. */
export function primerNombre(nombre: string | null | undefined): string {
  const n = limpio(nombre);
  if (!n) return '';
  const p = n.split(/\s+/)[0];
  if (p.length < 2) return '';
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

/** Fecha límite para reclamar en la agencia, o null si no sabemos cuándo llegó.
 *  No saber NO es lo mismo que estar vencido: sin dato no se inventa un plazo. */
export function fechaLimiteAgencia(
  lastMovementAt: string | null | undefined,
  timeZone = 'America/Bogota',
): string | null {
  const raw = limpio(lastMovementAt);
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const limite = new Date(ms + DIAS_PARA_RECLAMAR * 24 * 60 * 60 * 1000);
  try {
    return new Intl.DateTimeFormat('es-CO', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone,
    }).format(limite);
  } catch {
    // timeZone inválida (entorno sin ICU completo) → sin plazo antes que un texto roto.
    return null;
  }
}

const mayus = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Mensaje de WhatsApp por fase. Devuelve texto plano listo para `?text=`.
 * Nunca devuelve cadena vacía: la fase desconocida cae a un saludo útil.
 */
export function mensajeSeguimiento(input: MensajeSeguimientoInput): string {
  const nombre = primerNombre(input.nombre);
  const saludo = nombre ? `Hola ${nombre} 👋` : 'Hola 👋';

  const producto = limpio(input.producto);
  const elPedido = producto ? `tu pedido de ${producto}` : 'tu pedido';

  const transp = limpio(input.transportadora);
  const laTransp = transp || 'la transportadora';
  const ciudad = limpio(input.ciudad);
  const guia = limpio(input.guia);
  const valor = limpio(input.valorTexto);
  const url = limpio(input.trackingUrl);

  const lineas: string[] = [];
  const push = (s: string) => { if (s) lineas.push(s); };

  switch (input.fase) {
    case 'oficina': {
      const donde = ciudad
        ? `a la oficina de ${laTransp} en ${ciudad}`
        : `a la oficina de ${laTransp}`;
      push(`${saludo} ${mayus(elPedido)} ya llegó ${donde} y te está esperando.`);
      const limite = fechaLimiteAgencia(input.lastMovementAt, input.timeZone);
      push(limite
        ? `⚠️ Importante: solo lo guardan unos días. Si no lo reclamás antes del ${limite}, lo devuelven y se cancela el pedido.`
        : '⚠️ Importante: solo lo guardan unos días. Si no lo reclamás pronto, lo devuelven y se cancela el pedido.');
      push(guia ? `Llevá tu cédula y este número de guía: ${guia}` : 'Llevá tu cédula para reclamarlo.');
      push(valor ? `Pagás ${valor} al recibirlo.` : '');
      break;
    }

    case 'reparto': {
      push(`${saludo} ${mayus(elPedido)} está EN RUTA DE ENTREGA hoy 🛵`);
      push(valor
        ? `Por favor tené listos ${valor} en efectivo y quedate atento al teléfono — el mensajero te va a llamar.`
        : 'Por favor quedate atento al teléfono — el mensajero te va a llamar.');
      push(guia ? `Guía: ${guia}` : '');
      break;
    }

    case 'novedad':
    case 'novedad_sol': {
      const nov = limpio(input.novedad);
      push(`${saludo} Te escribo por ${elPedido}: ${laTransp} reportó un inconveniente para entregarlo.`);
      push(nov ? `Nos dijeron: "${nov}"` : '');
      push('¿Me confirmás por acá tu dirección completa y un punto de referencia para reprogramar la entrega? Así lo volvemos a mandar sin que pierdas el pedido.');
      break;
    }

    case 'devolucion':
    case 'devolucion_transito':
    case 'rechazado': {
      push(`${saludo} Vimos que ${elPedido} no se pudo entregar y ${laTransp} lo está devolviendo.`);
      push('¿Querés que lo intentemos otra vez? Si me confirmás la dirección y un horario en el que estés, lo despachamos de nuevo.');
      break;
    }

    case 'transito':
    case 'bodega_trans': {
      push(`${saludo} ${mayus(elPedido)} ya va en camino con ${laTransp} 📦`);
      push(guia ? `Guía: ${guia}` : '');
      push(valor ? `Cuando llegue pagás ${valor} al recibirlo.` : '');
      break;
    }

    case 'guia': {
      push(`${saludo} Ya despachamos ${elPedido} 📦`);
      push(guia ? `Tu número de guía con ${laTransp} es: ${guia}` : `Sale con ${laTransp} en las próximas horas.`);
      push(valor ? `Pagás ${valor} al recibirlo.` : '');
      break;
    }

    case 'procesamiento': {
      push(`${saludo} Estamos alistando ${elPedido} para despacharlo. Apenas salga te paso el número de guía por acá.`);
      break;
    }

    default: {
      push(`${saludo} Te escribo por ${elPedido}.`);
      push(guia ? `Guía: ${guia}${transp ? ` (${transp})` : ''}` : '');
      break;
    }
  }

  // El link de rastreo va al final y solo si existe: un "podés rastrearlo acá:"
  // sin link es peor que no ofrecerlo.
  if (url) push(`Podés seguirlo acá: ${url}`);

  return lineas.join('\n\n');
}

/**
 * URL de WhatsApp con el mensaje YA cargado.
 *
 * `telefono` debe venir normalizado por país (`getWhatsAppPhone`). Sin teléfono
 * devuelve null — abrir wa.me sin número lleva a una pantalla de error, no a un
 * chat, y la asesora pierde el click.
 */
export function urlWhatsApp(telefono: string | null | undefined, texto: string): string | null {
  const tel = limpio(telefono).replace(/\D/g, '');
  if (tel.length < 7) return null;
  const t = limpio(texto);
  return t
    ? `https://wa.me/${tel}?text=${encodeURIComponent(t)}`
    : `https://wa.me/${tel}`;
}
