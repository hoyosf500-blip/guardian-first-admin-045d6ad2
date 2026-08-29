import { describe, it, expect } from 'vitest';
import {
  cicloContacto, enEspera, rangoCiclo,
  ESPERA_REINTENTO_MIN, INTENTOS_ANTES_DE_LLAMAR,
} from './cicloContacto';
import type { ActividadChatOrden } from './actividadChat';
import type { GestionDelPedido } from './gestionPorPedido';

const AHORA = Date.parse('2026-08-28T18:00:00.000Z');
const haceMin = (m: number) => AHORA - m * 60_000;

const act = (o: Partial<ActividadChatOrden>): ActividadChatOrden => ({
  salienteAt: null, salienteTipo: null, entranteAt: null, leidoAt: AHORA, ...o,
});
const ges = (o: Partial<GestionDelPedido>): GestionDelPedido => ({
  intentos: 1, ultimoAt: new Date(haceMin(10)).toISOString(),
  ultimoPor: 'ana', ultimoResult: 'Avisé: en oficina', ultimoMotivo: null, ...o,
});

const c = (a: Partial<Parameters<typeof cicloContacto>[0]>) =>
  cicloContacto({ ahoraMs: AHORA, ...a });

describe('el ciclo que pidió el dueño', () => {
  it('recién enviado → se enfría y dice CUÁNDO vuelve', () => {
    // Los minutos van RELATIVOS a la ventana: con un 10 fijo, subirla de 60 a
    // 240 puso roja esta prueba sin que ninguna regla hubiera cambiado.
    const r = c({ actividad: act({ salienteAt: haceMin(ESPERA_REINTENTO_MIN - 50) }) });
    expect(r.estado).toBe('enfriando');
    expect(enEspera(r)).toBe(true);
    expect(r.vuelveEnMin).toBe(50);
    expect(r.etiqueta).toContain('vuelve en 50 min');
  });

  it('pasada la espera vuelve a la cola con la etiqueta del segundo intento', () => {
    const r = c({
      actividad: act({ salienteAt: haceMin(ESPERA_REINTENTO_MIN + 1) }),
      gestion: ges({ intentos: 1, ultimoAt: new Date(haceMin(ESPERA_REINTENTO_MIN + 1)).toISOString() }),
    });
    expect(r.estado).toBe('reintento');
    expect(enEspera(r)).toBe(false);
    expect(r.etiqueta).toContain('2º intento');
    expect(r.accion).toBe('insistir');
  });

  it('justo al cumplirse la espera ya volvió — el límite es inclusivo', () => {
    expect(c({ actividad: act({ salienteAt: haceMin(ESPERA_REINTENTO_MIN) }) }).estado).toBe('reintento');
  });

  it('si el cliente RESPONDE vuelve enseguida, sin esperar', () => {
    // Es la mitad del pedido: "si el cliente responde que vuelva y aparezca
    // pero con una etiqueta para que el asesor lo atienda".
    const r = c({ actividad: act({ salienteAt: haceMin(20), entranteAt: haceMin(3) }) });
    expect(r.estado).toBe('respondio');
    expect(enEspera(r)).toBe(false);
    expect(r.etiqueta).toContain('Te respondió');
    expect(r.accion).toBe('atender');
  });

  it('un mensaje del cliente ANTERIOR al nuestro no es una respuesta', () => {
    const r = c({ actividad: act({ salienteAt: haceMin(10), entranteAt: haceMin(400) }) });
    expect(r.estado).toBe('enfriando');
  });

  it('al tercer intento manda a llamar: con esa persona el chat no funciona', () => {
    const r = c({
      actividad: act({ salienteAt: haceMin(ESPERA_REINTENTO_MIN + 60) }),
      gestion: ges({ intentos: INTENTOS_ANTES_DE_LLAMAR, ultimoAt: new Date(haceMin(ESPERA_REINTENTO_MIN + 60)).toISOString() }),
    });
    expect(r.accion).toBe('llamar');
    expect(r.etiqueta).toContain('mejor llamá');
  });

  it('⛔ si ya salió un mensaje, el siguiente es el SEGUNDO intento', () => {
    // Visto en pantalla el 28-ago-2026: un pedido al que le escribimos hace 3
    // días y que nadie volvió a tocar traía `intentos = 0` (solo cuenta las
    // gestiones de HOY) y la etiqueta decía "1º intento" sobre alguien que ya
    // había recibido un mensaje.
    const r = c({ actividad: act({ salienteAt: haceMin(60 * 24 * 3) }) });
    expect(r.etiqueta).toContain('2º intento');
  });

  it('sin saliente registrado pero con gestión de hoy, la cuenta la lleva la gestión', () => {
    const r = c({ gestion: ges({ intentos: 2, ultimoAt: new Date(haceMin(ESPERA_REINTENTO_MIN + 30)).toISOString() }) });
    expect(r.etiqueta).toContain('3º intento');
    expect(r.accion).toBe('llamar');
  });

  it('⛔ los intentos de DÍAS ANTERIORES cuentan: no puede decir "2º" sobre el cuarto', () => {
    // El bug: `gestion` es solo de HOY, así que un cliente con tres gestiones
    // esta semana y ninguna hoy leía "2º intento" (el 1 lo aportaba el saliente).
    // Decisión del dueño 28-ago-2026: se cuenta la semana.
    const viejo = new Date(haceMin(ESPERA_REINTENTO_MIN + 60)).toISOString();
    const sinHistorial = c({ actividad: act({ salienteAt: haceMin(ESPERA_REINTENTO_MIN + 60) }) });
    expect(sinHistorial.etiqueta).toContain('2º intento');

    const conHistorial = c({
      actividad: act({ salienteAt: haceMin(ESPERA_REINTENTO_MIN + 60) }),
      gestionPrevia: ges({ intentos: 3, ultimoAt: viejo }),
    });
    expect(conHistorial.intentosConocidos).toBe(3);
    expect(conHistorial.etiqueta).toContain('4º intento');
    expect(conHistorial.accion).toBe('llamar');
  });

  it('las de hoy SE SUMAN a las previas — los dos mapas viven aparte', () => {
    // `gestionSegPorTelefono` (hoy, vivo) y `ultimaGestionSeg` (días anteriores,
    // se lee al cargar) son disjuntos a propósito: fusionarlos daría de menos en
    // cuanto la asesora marque el primer pedido del turno.
    const r = c({
      gestion: ges({ intentos: 1, ultimoAt: new Date(haceMin(ESPERA_REINTENTO_MIN + 5)).toISOString() }),
      gestionPrevia: ges({ intentos: 2, ultimoAt: new Date(haceMin(60 * 24 * 2)).toISOString() }),
    });
    expect(r.intentos).toBe(1);          // el día, que es lo que firma el cierre
    expect(r.intentosConocidos).toBe(3); // 1 de hoy + 2 de la semana
    expect(r.etiqueta).toContain('4º intento');
  });

  it('⛔ el historial NO enfría el pedido ni lo saca de la cola de hoy', () => {
    // Una gestión de anteayer no puede esconder un pedido que hoy hay que
    // trabajar: `ultimoNuestroMs` sigue saliendo de hoy + el saliente.
    const r = c({ gestionPrevia: ges({ intentos: 5, ultimoAt: new Date(haceMin(60 * 24 * 2)).toISOString() }) });
    expect(r.estado).toBe('sin_tocar');
    expect(enEspera(r)).toBe(false);
    expect(r.ultimoNuestroMs).toBeNull();
  });

  it('el saliente de ImporChat no se SUMA a lo anotado: es el mismo mensaje', () => {
    // Contarlo aparte mandaría a llamar antes de tiempo sobre un solo contacto.
    const r = c({
      actividad: act({ salienteAt: haceMin(ESPERA_REINTENTO_MIN + 10) }),
      gestion: ges({ intentos: 1, ultimoAt: new Date(haceMin(ESPERA_REINTENTO_MIN + 10)).toISOString() }),
    });
    expect(r.intentosConocidos).toBe(1);
    expect(r.etiqueta).toContain('2º intento');
  });

  it('nadie le escribió nunca → "Sin avisar"', () => {
    const r = c({});
    expect(r.estado).toBe('sin_tocar');
    expect(r.etiqueta).toBe('Sin avisar');
    expect(r.accion).toBe('avisar');
  });

  it('⛔ una LLAMADA registrada enfría igual que un WhatsApp', () => {
    // "que sea como en la llamada": el mecanismo es el mismo para los dos, y
    // por eso el reloj es el MÁS RECIENTE de gestión o mensaje. Sin esto, dos
    // asesoras podían llamar al mismo cliente con dos minutos de diferencia.
    const r = c({ gestion: ges({ ultimoAt: new Date(haceMin(5)).toISOString() }) });
    expect(r.estado).toBe('enfriando');
  });

  it('⛔ un "No contestó" NO esconde el pedido todo el día', () => {
    // Era el bug del 31-jul: el "no contestó" de una asesora a las 9 a. m.
    // hacía desaparecer al cliente del tablero de TODO el equipo hasta el día
    // siguiente. Ahora vuelve pasada la espera (4 h desde el 28-ago-2026), con
    // su etiqueta. La REGLA es "vuelve el mismo día", no un número de minutos.
    const pasadaLaEspera = new Date(haceMin(ESPERA_REINTENTO_MIN + 30)).toISOString();
    const r = c({ gestion: ges({ ultimoResult: 'No contestó', ultimoAt: pasadaLaEspera }) });
    expect(r.estado).toBe('reintento');
    expect(enEspera(r)).toBe(false);
  });

  it('gana el contacto MÁS RECIENTE entre el mensaje y la gestión', () => {
    const r = c({
      actividad: act({ salienteAt: haceMin(300) }),
      gestion: ges({ ultimoAt: new Date(haceMin(5)).toISOString() }),
    });
    expect(r.estado).toBe('enfriando');
    expect(r.ultimoNuestroMs).toBe(haceMin(5));
  });
});

describe('rangoCiclo — el orden dentro de la columna', () => {
  it('quien respondió va arriba de todo; lo que se enfría, al fondo', () => {
    const respondio = c({ actividad: act({ salienteAt: haceMin(30), entranteAt: haceMin(2) }) });
    const reintento = c({ actividad: act({ salienteAt: haceMin(ESPERA_REINTENTO_MIN + 60) }) });
    const sinTocar = c({});
    const enfriando = c({ actividad: act({ salienteAt: haceMin(5) }) });
    expect(rangoCiclo(respondio)).toBeLessThan(rangoCiclo(reintento));
    expect(rangoCiclo(enfriando)).toBeGreaterThan(rangoCiclo(sinTocar));
  });

  it('⛔ reintento y sin-tocar comparten rango, a propósito', () => {
    // Separarlos enterraría a uno de los dos grupos a medida que crece el otro:
    // con 127 pedidos sin avisar, ningún reintento se vería nunca.
    const reintento = c({ actividad: act({ salienteAt: haceMin(ESPERA_REINTENTO_MIN + 60) }) });
    expect(rangoCiclo(reintento)).toBe(rangoCiclo(c({})));
  });
});
