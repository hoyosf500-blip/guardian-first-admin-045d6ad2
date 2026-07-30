import { describe, it, expect } from 'vitest';
import { metodosParaEstado, METODOS_DEFAULT } from './segMetodosEstado';
import { SEG_CLOSERS, isSegCloser } from './segDailyReview';

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
