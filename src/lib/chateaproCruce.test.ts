import { describe, it, expect } from 'vitest';
import {
  cambiosDeChat,
  aIso,
  last9,
  type ContactoCp,
  type PedidoCruce,
} from '../../supabase/functions/_shared/chateaproCruce';

/**
 * El cruce que enciende la bandeja «Escribieron» en Colombia.
 *
 * Medido el 2-sep-2026 sobre los 800 contactos reales de la cuenta: 39
 * clientes habían escrito y nadie contestó (22 hacía más de un día, el más
 * viejo 97 h) y Guardian mostraba «Nadie esperando respuesta 🎉».
 */

const ped = (o: Partial<PedidoCruce> & { external_id: string }): PedidoCruce => ({
  phone: '3218877000', fecha: '2026-09-01', ...o,
});

describe('aIso — la hora del país, no la del servidor', () => {
  it('⛔ un mensaje de Colombia NO se lee como si fuera UTC', () => {
    // Sin la zona, `new Date('2026-09-02 14:38:24')` en Supabase (UTC) daría
    // las 14:38 UTC = 09:38 en Bogotá: el mensaje figuraría 5 h en el futuro y
    // la bandeja lo ordenaría último justo cuando es el más urgente.
    expect(aIso('2026-09-02 14:38:24', -5)).toBe('2026-09-02T19:38:24.000Z');
  });

  it('Ecuador tiene el mismo huso, y el offset se respeta igual', () => {
    expect(aIso('2026-09-02 09:00:00', -5)).toBe('2026-09-02T14:00:00.000Z');
  });

  it('una fecha rota no inventa una hora', () => {
    expect(aIso('')).toBeNull();
    expect(aIso(null)).toBeNull();
    expect(aIso('ayer por la tarde')).toBeNull();
  });
});

describe('last9 — el mismo cliente con tres formas de número', () => {
  it('nacional, con indicativo y con "+" caen en la misma llave', () => {
    expect(last9('3218877000')).toBe('218877000');
    expect(last9('573218877000')).toBe('218877000');
    expect(last9('+57 321 887 7000')).toBe('218877000');
  });
});

describe('cambiosDeChat', () => {
  it('el cliente escribió último → queda como ENTRANTE', () => {
    const c: ContactoCp[] = [{
      phone: '3218877000', last_message_at: '2026-09-02 14:38:24', last_message_type: 'in',
    }];
    const r = cambiosDeChat(c, [ped({ external_id: '87992083' })]);
    expect(r).toEqual([{ external_id: '87992083', chat_entrante_at: '2026-09-02T19:38:24.000Z' }]);
  });

  it('⛔ NO inventa el saliente cuando solo sabe del entrante', () => {
    const c: ContactoCp[] = [{
      phone: '3218877000', last_message_at: '2026-09-02 14:38:24', last_message_type: 'in',
    }];
    const [u] = cambiosDeChat(c, [ped({ external_id: '87992083' })]);
    // `last_message_type` dice quién habló último y NADA más. Escribir también
    // el saliente sería afirmar una hora que no se midió — y encima taparía la
    // señal de "está esperando respuesta".
    expect(u.chat_saliente_at).toBeUndefined();
  });

  it('el bot contestó último → queda como SALIENTE automático', () => {
    const c: ContactoCp[] = [{
      phone: '3218877000', last_message_at: '2026-09-02 10:28:00', last_message_type: 'out',
    }];
    const [u] = cambiosDeChat(c, [ped({ external_id: '87992083' })]);
    expect(u.chat_saliente_at).toBe('2026-09-02T15:28:00.000Z');
    expect(u.chat_saliente_tipo).toBe('plantilla');
    expect(u.chat_entrante_at).toBeUndefined();
  });

  it('una PERSONA contestó último → saliente "directo", no automático', () => {
    const c: ContactoCp[] = [{
      phone: '3218877000', last_message_at: '2026-09-02 14:27:00', last_message_type: 'agent',
    }];
    const [u] = cambiosDeChat(c, [ped({ external_id: '87992083' })]);
    expect(u.chat_saliente_tipo).toBe('directo');
  });

  it('⛔ NUNCA pisa hacia atrás lo que la asesora acaba de mandar', () => {
    // La asesora escribió desde Guardian a las 14:27 (ya guardado). El sync
    // corre después y la lista de Chatea Pro todavía trae el mensaje del bot
    // de las 10:28. Sin este guard, el pedido "perdería" el mensaje recién
    // enviado y volvería a la bandeja como si nadie hubiera contestado.
    const c: ContactoCp[] = [{
      phone: '3218877000', last_message_at: '2026-09-02 10:28:00', last_message_type: 'out',
    }];
    const r = cambiosDeChat(c, [ped({
      external_id: '87992083', chat_saliente_at: '2026-09-02T19:27:00.000Z',
    })]);
    expect(r).toEqual([]);
  });

  it('un entrante ya conocido no se vuelve a escribir', () => {
    const c: ContactoCp[] = [{
      phone: '3218877000', last_message_at: '2026-09-02 14:38:24', last_message_type: 'in',
    }];
    const r = cambiosDeChat(c, [ped({
      external_id: '87992083', chat_entrante_at: '2026-09-02T19:38:24.000Z',
    })]);
    expect(r).toEqual([]);
  });

  it('un cliente con DOS pedidos entra una sola vez, en el más reciente', () => {
    // La conversación de WhatsApp es una sola. Repartirla entre los dos
    // pedidos pondría a la misma persona dos veces en la bandeja y la asesora
    // le escribiría dos veces por el mismo mensaje.
    const c: ContactoCp[] = [{
      phone: '3218877000', last_message_at: '2026-09-02 14:38:24', last_message_type: 'in',
    }];
    const r = cambiosDeChat(c, [
      ped({ external_id: 'viejo', fecha: '2026-08-01' }),
      ped({ external_id: 'nuevo', fecha: '2026-09-01' }),
    ]);
    expect(r.map((x) => x.external_id)).toEqual(['nuevo']);
  });

  it('un contacto sin pedido en esta tienda no genera nada', () => {
    // De los 39 que esperaban, 27 no tenían pedido registrado. No son un
    // error: son gente que preguntó y no compró. No pueden inventar una fila.
    const c: ContactoCp[] = [{
      phone: '3001234567', last_message_at: '2026-09-02 14:00:00', last_message_type: 'in',
    }];
    expect(cambiosDeChat(c, [ped({ external_id: '87992083' })])).toEqual([]);
  });

  it('un tipo de mensaje que no se entiende se ignora, no se adivina', () => {
    const c: ContactoCp[] = [{
      phone: '3218877000', last_message_at: '2026-09-02 14:00:00', last_message_type: 'nota',
    }];
    expect(cambiosDeChat(c, [ped({ external_id: '87992083' })])).toEqual([]);
  });

  it('un contacto sin fecha no escribe nada', () => {
    const c: ContactoCp[] = [{ phone: '3218877000', last_message_at: '', last_message_type: 'in' }];
    expect(cambiosDeChat(c, [ped({ external_id: '87992083' })])).toEqual([]);
  });

  it('un teléfono demasiado corto no cruza con nadie', () => {
    const c: ContactoCp[] = [{
      phone: '123', last_message_at: '2026-09-02 14:00:00', last_message_type: 'in',
    }];
    expect(cambiosDeChat(c, [ped({ external_id: '87992083', phone: '123' })])).toEqual([]);
  });

  it('cruza aunque Chatea Pro guarde el número con indicativo', () => {
    // El contacto que crea la propia API queda como `+573209498426`.
    const c: ContactoCp[] = [{
      phone: '+573218877000', last_message_at: '2026-09-02 14:38:24', last_message_type: 'in',
    }];
    const r = cambiosDeChat(c, [ped({ external_id: '87992083', phone: '3218877000' })]);
    expect(r.map((x) => x.external_id)).toEqual(['87992083']);
  });
});

/**
 * ⛔ EL AGUJERO DE `last_interaction` (3-sep-2026).
 *
 * Reportado por el dueño mirando el tablero de Colombia: *"en algunos sale la
 * plantilla y en otros no"*. Medido sobre la cuenta real: de los 900 contactos
 * que devuelve `GET /subscribers`, **845 tienen `last_message_type = 'out'`** —
 * el bot contesta en unos 25 segundos, así que casi nunca el cliente es el
 * último que habló. Con la regla vieja (escribir un solo lado, según el tipo
 * del último mensaje) Guardian escribía `chat_entrante_at` en **53 de 900**
 * conversaciones: un 6%.
 *
 * Y `chat_entrante_at` es lo que decide la ventana de 24 h de WhatsApp. Sin él,
 * `ventanaWhatsapp` contesta `nunca_escribio`, el riel verde de la tarjeta se
 * apaga y la pantalla ofrece el camino de PLANTILLA —que se paga— sobre una
 * conversación abierta que admitía un mensaje escrito gratis.
 */
describe('cambiosDeChat — el entrante sale de `last_interaction`', () => {
  const ped2 = (o: Partial<PedidoCruce>): PedidoCruce => ({
    external_id: 'X', phone: '3218877000', fecha: '2026-09-01', ...o,
  });

  it('⛔ el bot contestó 25 s después y IGUAL se sabe cuándo escribió el cliente', () => {
    // Este es el caso del 94% de la cuenta. Antes salía SOLO el saliente y el
    // pedido quedaba como si el cliente nunca hubiera escrito.
    const c: ContactoCp[] = [{
      phone: '3218877000',
      last_message_at: '2026-09-02 21:55:10',
      last_interaction: '2026-09-02 21:54:55',
      last_message_type: 'out',
    }];
    const r = cambiosDeChat(c, [ped2({ external_id: '88110734' })]);
    expect(r).toEqual([{
      external_id: '88110734',
      chat_entrante_at: '2026-09-03T02:54:55.000Z',
      chat_saliente_at: '2026-09-03T02:55:10.000Z',
      chat_saliente_tipo: 'plantilla',
    }]);
  });

  it('el entrante queda ANTES que el saliente: no aparece esperando respuesta', () => {
    // `estadoConversacion` pregunta `entrante > saliente`. Escribir los dos no
    // puede meter en la bandeja «Escribieron» a alguien que ya fue atendido.
    const c: ContactoCp[] = [{
      phone: '3218877000',
      last_message_at: '2026-09-02 21:55:10',
      last_interaction: '2026-09-02 21:54:55',
      last_message_type: 'out',
    }];
    const [x] = cambiosDeChat(c, [ped2({ external_id: '88110734' })]);
    expect(new Date(x.chat_entrante_at!).getTime())
      .toBeLessThan(new Date(x.chat_saliente_at!).getTime());
  });

  it('cuando el cliente habló último, el saliente NO se toca', () => {
    // Escribir "ahora" ahí borraría el hecho de que nadie le contestó — que es
    // justamente lo que la bandeja «Escribieron» tiene que ver.
    const c: ContactoCp[] = [{
      phone: '3218877000',
      last_message_at: '2026-09-02 21:20:14',
      last_interaction: '2026-09-02 21:20:14',
      last_message_type: 'in',
    }];
    const r = cambiosDeChat(c, [ped2({ external_id: '88110734' })]);
    expect(r).toEqual([{ external_id: '88110734', chat_entrante_at: '2026-09-03T02:20:14.000Z' }]);
  });

  it('una persona del equipo sigue quedando como `directo`', () => {
    const c: ContactoCp[] = [{
      phone: '3218877000',
      last_message_at: '2026-09-02 21:55:10',
      last_interaction: '2026-09-02 21:54:55',
      last_message_type: 'agent',
    }];
    expect(cambiosDeChat(c, [ped2({ external_id: 'A' })])[0].chat_saliente_tipo).toBe('directo');
  });

  it('⛔ sin `last_interaction`, un mensaje del NEGOCIO no se lee como del cliente', () => {
    // La regla de siempre: solo se toca el lado que el dato prueba. Un contacto
    // viejo sin ese campo no puede producir un entrante inventado.
    const c: ContactoCp[] = [{
      phone: '3218877000', last_message_at: '2026-09-02 21:55:10', last_message_type: 'out',
    }];
    const r = cambiosDeChat(c, [ped2({ external_id: 'A' })]);
    expect(r[0].chat_entrante_at).toBeUndefined();
    expect(r[0].chat_saliente_at).toBe('2026-09-03T02:55:10.000Z');
  });

  it('tampoco se escribe hacia atrás: un entrante más viejo no pisa al que hay', () => {
    const c: ContactoCp[] = [{
      phone: '3218877000',
      last_message_at: '2026-09-02 10:00:00',
      last_interaction: '2026-09-02 09:00:00',
      last_message_type: 'out',
    }];
    const r = cambiosDeChat(c, [ped2({
      external_id: 'A',
      chat_entrante_at: '2026-09-02T20:00:00.000Z',
      chat_saliente_at: '2026-09-02T20:00:00.000Z',
    })]);
    expect(r).toEqual([]);
  });

  it('un contacto que no aporta nada nuevo no gasta un UPDATE', () => {
    const c: ContactoCp[] = [{
      phone: '3218877000',
      last_message_at: '2026-09-02 10:00:00',
      last_interaction: '2026-09-02 09:55:00',
      last_message_type: 'out',
    }];
    const r = cambiosDeChat(c, [ped2({
      external_id: 'A',
      chat_entrante_at: '2026-09-02T14:55:00.000Z',
      chat_saliente_at: '2026-09-02T15:00:00.000Z',
    })]);
    expect(r).toEqual([]);
  });
});
