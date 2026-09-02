import { describe, it, expect } from 'vitest';
import {
  plantillasQueConfirman,
  aMensajeChat,
  senalDeHilo,
} from '../../supabase/functions/_shared/chateaproSenal';
import type { MensajeConversacion } from '../../supabase/functions/_shared/conversacion';

/**
 * La señal que más plata mueve, ahora en Colombia.
 *
 * En Ecuador separa 10,4% de cancelación contra 57,7% (n=622, agosto-2026).
 * Todo lo de acá está medido contra la cuenta real de Chatea Pro el
 * 2-sep-2026: las 8 plantillas de confirmación traen "CONFIRMAR PEDIDO" y
 * "Modificar Datos", y el apretón llega como `postback` (pedido 88110734,
 * CANDIDA VILORIA).
 */

const msg = (o: Partial<MensajeConversacion>): MensajeConversacion => ({
  id: 'x', fechaMs: Date.parse('2026-09-02T15:00:00Z'), de: 'cliente',
  texto: '', tipo: 'text', ...o,
} as MensajeConversacion);

const PLANTILLA_CONF = msg({
  de: 'negocio', tipo: 'wa_template', plantilla: 'ES confirmacion_sin_imagen_v2',
  texto: 'Hola, CANDIDA\n\nQueremos confirmar los datos de tu pedido',
  fechaMs: Date.parse('2026-09-02T14:00:00Z'),
});
const CONFIRMA = new Set(['confirmacion_sin_imagen_v2']);

describe('plantillasQueConfirman — se descubren solas', () => {
  const cruda = (name: string, botones: string[]) => ({
    name,
    components: [
      { type: 'BODY', text: 'hola' },
      { type: 'BUTTONS', buttons: botones.map((text) => ({ type: 'QUICK_REPLY', text })) },
    ],
  });

  it('reconoce la que ofrece CONFIRMAR PEDIDO', () => {
    const s = plantillasQueConfirman([
      cruda('confirmacion_sin_imagen_v2', ['CONFIRMAR PEDIDO', 'Modificar Datos']),
      cruda('seguimiento_entregado_v2', []),
    ]);
    expect([...s]).toEqual(['confirmacion_sin_imagen_v2']);
  });

  it('⛔ una plantilla NUEVA con ese botón entra sola', () => {
    // Es la defensa contra el incidente del 27-ago-2026: cambiar la plantilla
    // en el panel apagó la señal dos días enteros, sin un solo error en el log.
    const s = plantillasQueConfirman([cruda('confirmacion_v9_recien_creada', ['CONFIRMAR PEDIDO'])]);
    expect(s.has('confirmacion_v9_recien_creada')).toBe(true);
  });

  it('«Modificar Datos» y «Hablar con asesor» NO hacen confirmadora a una plantilla', () => {
    const s = plantillasQueConfirman([cruda('carrito_x', ['Modificar Datos', 'Hablar con asesor'])]);
    expect(s.size).toBe(0);
  });

  it('aguanta components como texto JSON y como basura', () => {
    const j = { name: 'p1', components: JSON.stringify([{ type: 'BUTTONS', buttons: [{ text: 'CONFIRMAR PEDIDO' }] }]) };
    expect(plantillasQueConfirman([j]).has('p1')).toBe(true);
    expect(plantillasQueConfirman([{ name: 'p2', components: 'no soy json' }]).size).toBe(0);
    expect(plantillasQueConfirman([{ components: [] }]).size).toBe(0);
  });
});

describe('aMensajeChat', () => {
  it('⛔ `postback` es apretar un botón, no escribir', () => {
    // En ImporChat el tipo se llama "button". Sin esta traducción,
    // `esBotonConfirmar` da false para TODOS y la señal queda en cero sin
    // dar ningún error — la falla silenciosa de agosto otra vez.
    expect(aMensajeChat(msg({ tipo: 'postback', texto: 'CONFIRMAR PEDIDO' })).tipo).toBe('button');
  });

  it('el lado del mensaje se traduce a los roles de ImporChat', () => {
    expect(aMensajeChat(msg({ de: 'cliente' })).rol).toBe('Cliente');
    expect(aMensajeChat(msg({ de: 'negocio' })).rol).toBe('Propietario');
  });
});

describe('senalDeHilo', () => {
  it('apretó el botón → confirmado (10% cancela)', () => {
    const s = senalDeHilo([PLANTILLA_CONF, msg({ tipo: 'postback', texto: 'CONFIRMAR PEDIDO' })], CONFIRMA);
    expect(s.riesgo).toBe('confirmado');
    expect(s.apretoBotonAt).toEqual(new Date('2026-09-02T15:00:00Z'));
    expect(s.recibioPlantilla).toBe(true);
  });

  it('escribió pero no apretó → tibio (34% cancela, hay que llamarlo)', () => {
    const s = senalDeHilo([PLANTILLA_CONF, msg({ texto: '¿cuándo llega?' })], CONFIRMA);
    expect(s.riesgo).toBe('tibio');
    expect(s.apretoBotonAt).toBeNull();
  });

  it('le llegó la plantilla y no hizo NADA → mudo (66% cancela, teléfono o nada)', () => {
    const s = senalDeHilo([PLANTILLA_CONF], CONFIRMA);
    expect(s.riesgo).toBe('mudo');
  });

  it('⛔ apretar «Modificar Datos» NO es confirmar', () => {
    // Los que apretaron el otro botón cancelaron 42,9% en Ecuador: están del
    // lado malo. Leerlo como un sí sería el error de 2026 al revés.
    const s = senalDeHilo([PLANTILLA_CONF, msg({ tipo: 'postback', texto: 'Modificar Datos' })], CONFIRMA);
    expect(s.riesgo).not.toBe('confirmado');
  });

  /**
   * ⛔ Sin plantilla enviada NO hay señal del botón — el hallazgo del
   * 2-sep-2026.
   *
   * La primera corrida real en Colombia leyó 30 pedidos y solo 2 habían
   * recibido la plantilla de confirmación (en Ecuador la reciben 622 de 765).
   * El bot colombiano confirma CONVERSANDO dentro de la ventana de 24 h. Con
   * la escalera tal cual, esos 28 salían `tibio` = "escribió pero nunca apretó
   * el botón · llamalo" — falso, y encima `tibio` tiene MÁS prioridad que
   * `sin_dato` en la cola de Confirmar: 33 pedidos sin información real se le
   * adelantaban a todo.
   */
  it('escribió pero NUNCA se le ofreció el botón → sin_dato, no tibio', () => {
    const s = senalDeHilo([msg({ texto: 'quiero dos pares' })], CONFIRMA);
    expect(s.riesgo).toBe('sin_dato');
    expect(s.recibioPlantilla).toBe(false);
  });

  it('pero `mudo` SÍ vale aunque no se le haya mandado plantilla', () => {
    // A esa persona el chat no le llega: hay que llamarla, se le haya ofrecido
    // un botón o no. Es el peor grupo de Ecuador (66% cancela).
    const soloBot = msg({ de: 'negocio', texto: 'Hola, ya salió tu pedido' });
    expect(senalDeHilo([soloBot], CONFIRMA).riesgo).toBe('mudo');
  });

  it('y `confirmado` no puede existir sin plantilla, pero si existe manda', () => {
    const s = senalDeHilo([PLANTILLA_CONF, msg({ tipo: 'postback', texto: 'CONFIRMAR PEDIDO' })], CONFIRMA);
    expect(s.riesgo).toBe('confirmado');
  });

  it('⛔ un hilo que no se pudo leer es `sin_dato`, nunca «tranquilo»', () => {
    const s = senalDeHilo(null, CONFIRMA);
    expect(s.riesgo).toBe('sin_dato');
    expect(s.recibioPlantilla).toBe(false);
  });

  it('sin plantilla de confirmación enviada, `recibioPlantilla` es false', () => {
    // No se le puede exigir un botón que nunca se le ofreció.
    const otra = msg({ de: 'negocio', tipo: 'wa_template', plantilla: 'ES seguimiento_entregado_v2', texto: 'gracias' });
    expect(senalDeHilo([otra, msg({ texto: 'ok' })], CONFIRMA).recibioPlantilla).toBe(false);
  });

  it('el prefijo de idioma del nombre no rompe el cruce', () => {
    // El mensaje dice "ES confirmacion_sin_imagen_v2"; la lista, solo el nombre.
    expect(senalDeHilo([PLANTILLA_CONF], CONFIRMA).recibioPlantilla).toBe(true);
  });

  it('un botón desconocido se REPORTA en vez de pasar como nada', () => {
    const s = senalDeHilo([PLANTILLA_CONF, msg({ tipo: 'postback', texto: 'QUIERO OTRO COLOR' })], CONFIRMA);
    expect(s.botonesDesconocidos).toEqual(['QUIERO OTRO COLOR']);
    // Y no se lo inventa como confirmación.
    expect(s.riesgo).not.toBe('confirmado');
  });

  it('los tres botones conocidos de Colombia NO se reportan como desconocidos', () => {
    const s = senalDeHilo([
      PLANTILLA_CONF,
      msg({ tipo: 'postback', texto: 'Modificar Datos' }),
      msg({ tipo: 'postback', texto: 'Hablar con asesor' }),
      msg({ tipo: 'postback', texto: 'CONFIRMAR PEDIDO' }),
    ], CONFIRMA);
    expect(s.botonesDesconocidos).toEqual([]);
  });

  it('apretar el botón NO cuenta como haber escrito', () => {
    // Un cliente que solo aprieta botones sigue siendo alguien que nunca
    // escribió: eso cambia el canal con el que hay que buscarlo.
    const s = senalDeHilo([PLANTILLA_CONF, msg({ tipo: 'postback', texto: 'CONFIRMAR PEDIDO' })], CONFIRMA);
    expect(s.clienteEscribioAt).toBeNull();
  });

  it('el botón manda aunque el cliente después discuta', () => {
    const s = senalDeHilo([
      PLANTILLA_CONF,
      msg({ tipo: 'postback', texto: 'CONFIRMAR PEDIDO', fechaMs: Date.parse('2026-09-02T15:00:00Z') }),
      msg({ texto: 'espere, no estoy seguro', fechaMs: Date.parse('2026-09-02T16:00:00Z') }),
    ], CONFIRMA);
    expect(s.riesgo).toBe('confirmado');
  });
});
