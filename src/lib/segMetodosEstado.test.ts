import { describe, it, expect } from 'vitest';
import { metodosParaEstado, metodosRapidosParaEstado, METODOS_DEFAULT } from './segMetodosEstado';
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
});
