import { describe, it, expect } from 'vitest';
import { metodosParaEstado, metodosRapidosParaEstado, METODOS_DEFAULT, esContactoEfectivo } from './segMetodosEstado';
import { SEG_CLOSERS, isSegCloser } from './segDailyReview';

describe('metodosRapidosParaEstado (las 3 que van en la tarjeta del kanban)', () => {
  it('devuelve como máximo 3 y respeta el orden de relevancia del estado', () => {
    const guia = metodosRapidosParaEstado('GUIA GENERADA');
    expect(guia.length).toBeLessThanOrEqual(3);
    expect(guia[0]).toBe('Envié la guía');
    expect(guia).toContain('No contestó');
  });

  it('en oficina ofrece "Cliente recoge" SIN abrir la ficha', () => {
    // El caso que motivó el cambio: el kanban tenía un único "Gestioné hoy"
    // genérico y la asesora abría el detalle solo para decir que el cliente
    // pasa a recogerlo.
    expect(metodosRapidosParaEstado('RECLAME EN OFICINA')).toContain('Cliente recoge');
  });

  it('nunca ofrece un CIERRE desde la tarjeta', () => {
    // Resuelto/Devolución cambian el desenlace del pedido: se eligen en la
    // ficha, con el contexto delante, no de un clic en el tablero.
    for (const estado of ['GUIA GENERADA', 'EN REPARTO', 'RECLAME EN OFICINA', 'NOVEDAD', 'EN TRANSITO']) {
      for (const m of metodosRapidosParaEstado(estado)) {
        expect(isSegCloser(`SEG: ${m}`)).toBe(false);
      }
    }
  });

  it('un estado desconocido igual da acciones (nunca deja la tarjeta muda)', () => {
    expect(metodosRapidosParaEstado('ESTADO RARO DE DROPI').length).toBeGreaterThan(0);
    expect(metodosRapidosParaEstado(null).length).toBeGreaterThan(0);
  });

  it('tránsito CON TILDE y "EN CAMINO" ya no caen al cajón de Otros', () => {
    // Era la causa de que "Otros" fuera la columna más grande del tablero: los
    // matchers están escritos sin tilde y Dropi EC manda "EN TRÁNSITO".
    for (const estado of ['EN TRÁNSITO', 'EN TRANSITO', 'EN TRANSITO A UIO', 'EN CAMINO']) {
      expect(metodosRapidosParaEstado(estado)[0]).toBe('Avisé que va en camino');
    }
  });
});

describe('metodosParaEstado', () => {
  it('guía generada: lo primero es enviar la guía al cliente', () => {
    expect(metodosParaEstado('GUIA GENERADA')[0]).toBe('Envié la guía');
    expect(metodosParaEstado('ENTREGADO A TRANSPORTADORA')[0]).toBe('Envié la guía');
  });

  it('en reparto: lo primero es avisar que llega hoy', () => {
    expect(metodosParaEstado('EN REPARTO')[0]).toBe('Avisé que llega hoy');
  });

  it('oficina (CO y EC): avisar dónde está y confirmar que recoge', () => {
    for (const estado of ['RECLAME EN OFICINA', 'PARA RETIRO EN AGENCIA SERVIENTREGA']) {
      const m = metodosParaEstado(estado);
      expect(m[0]).toBe('Avisé: en oficina');
      expect(m[1]).toBe('Cliente recoge'); // label ya existente en el histórico
    }
  });

  it('tránsito EC (EN RUTA / INGRESANDO / ASIGNADO): avisar que va en camino', () => {
    for (const estado of ['EN RUTA A CENTRO LOGISTICO', 'INGRESANDO OPERATIVO A QUITO', 'ASIGNADO A LAARCOURIER']) {
      expect(metodosParaEstado(estado)[0]).toBe('Avisé que va en camino');
    }
  });

  it('novedad: reclamar a la transportadora primero', () => {
    expect(metodosParaEstado('NOVEDAD')[0]).toBe('Reclamé transportadora');
  });

  it('"No contestó" está SIEMPRE en los juegos por estado', () => {
    for (const estado of ['GUIA GENERADA', 'EN REPARTO', 'RECLAME EN OFICINA', 'NOVEDAD', 'EN TRANSPORTE', 'DEVOLUCION']) {
      expect(metodosParaEstado(estado)).toContain('No contestó');
    }
  });

  it('estado desconocido o ausente → los 4 de siempre', () => {
    expect(metodosParaEstado('ESTADO INVENTADO XYZ')).toEqual([...METODOS_DEFAULT]);
    expect(metodosParaEstado(null)).toEqual([...METODOS_DEFAULT]);
    expect(metodosParaEstado(undefined)).toEqual([...METODOS_DEFAULT]);
  });

  it('ninguna acción por estado es un cierre (no saca el pedido de Seguimiento)', () => {
    const todos = new Set<string>();
    for (const estado of ['PENDIENTE', 'GUIA GENERADA', 'EN TRANSPORTE', 'EN REPARTO', 'RECLAME EN OFICINA', 'NOVEDAD', 'RECHAZADO', 'DEVOLUCION', 'lo-que-sea']) {
      for (const m of metodosParaEstado(estado)) todos.add(m);
    }
    for (const m of todos) {
      expect(isSegCloser(`SEG: ${m}`), m).toBe(false);
      expect(SEG_CLOSERS as readonly string[]).not.toContain(m);
    }
  });

  // ⛔ 25-ago-2026. La botonera NO vuelve a pedir que se declare un WhatsApp:
  // desde que Guardian manda el mensaje y lo verifica releyendo el chat, ese
  // touchpoint lo escribe la edge function. Un botón que declara lo que ya se
  // mide es un dato peor (no comprobable) compitiendo con uno bueno.
  // Las gestiones de LLAMADA sí se quedan: eso no lo puede medir nadie más.
  it('ningún estado ofrece declarar "WhatsApp" — se registra solo', () => {
    for (const estado of ['PENDIENTE', 'GUIA GENERADA', 'EN TRANSPORTE', 'EN REPARTO',
      'RECLAME EN OFICINA', 'NOVEDAD', 'RECHAZADO', 'DEVOLUCION', 'lo-que-sea', null]) {
      expect(metodosParaEstado(estado), String(estado)).not.toContain('WhatsApp');
      // …pero la llamada nunca puede quedarse sin salida.
      expect(metodosParaEstado(estado).some((m) => /llam/i.test(m)), String(estado)).toBe(true);
    }
  });
});

describe('esContactoEfectivo — evita que un cliente desaparezca del tablero', () => {
  it('NO contestar no es contacto: la tarjeta tiene que seguir a la vista', () => {
    // Bug del 31-jul: un "No contestó" de una asesora bloqueaba la tarjeta para
    // TODO el equipo y —con "Ocultar gestionados" activado por defecto— la hacía
    // desaparecer del tablero el resto del día. El cliente que no atendió a la
    // primera se volvía invisible y nadie lo volvía a llamar.
    expect(esContactoEfectivo('No contestó')).toBe(false);
    expect(esContactoEfectivo('Volver a llamar')).toBe(false);
  });

  it('acepta las variantes reales que hay en la base (sin tilde, mayúsculas)', () => {
    for (const v of ['No contesto', 'NO CONTESTÓ', 'no contestó', 'VOLVER A LLAMAR']) {
      expect(esContactoEfectivo(v), v).toBe(false);
    }
  });

  it('las gestiones donde SÍ se habló cuentan como atendidas', () => {
    for (const v of ['Envié la guía', 'Cliente recoge', 'Avisé que va en camino',
      'Coordinó entrega', 'Reclamé transportadora', 'Llamé', 'WhatsApp']) {
      expect(esContactoEfectivo(v), v).toBe(true);
    }
  });

  it('vacío o nulo NO cuenta como contacto (no bloquea nada)', () => {
    expect(esContactoEfectivo('')).toBe(false);
    expect(esContactoEfectivo(null)).toBe(false);
    expect(esContactoEfectivo(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sin "No contestó" en el juego por defecto, la asesora que llamaba a un cliente
// de un estado desconocido solo podía tocar "Llamé" — que cuenta como contacto
// efectivo, esconde la tarjeta para TODO el equipo el resto del día, y deja al
// cliente sin que nadie lo vuelva a llamar.
describe('METODOS_DEFAULT — el estado desconocido también necesita salida', () => {
  it('ofrece los dos desenlaces que dejan el pedido pendiente', () => {
    expect(METODOS_DEFAULT).toContain('No contestó');
    expect(METODOS_DEFAULT).toContain('Volver a llamar');
  });

  it('esos dos NO cuentan como contacto efectivo (no esconden la tarjeta)', () => {
    expect(esContactoEfectivo('No contestó')).toBe(false);
    expect(esContactoEfectivo('Volver a llamar')).toBe(false);
  });

  // El fallback tiene que servir para un estado que todavía no existe.
  it('un estado inventado por Dropi recibe un juego que incluye "No contestó"', () => {
    expect(metodosParaEstado('EN GESTION DE ENTREGA')).toContain('No contestó');
  });
});
