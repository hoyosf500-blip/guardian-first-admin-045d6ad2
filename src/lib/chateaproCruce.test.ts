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
