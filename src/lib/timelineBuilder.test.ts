import { describe, it, expect } from 'vitest';
import {
  parseTouchpointAction,
  buildTimeline,
  prettyStatus,
  type TimelineSources,
  type TimelineOrderRow,
  type TimelineTouchpoint,
  type TimelineNote,
  type TimelineOrderResult,
  type TimelineStatusChange,
} from './timelineBuilder';

describe('parseTouchpointAction', () => {
  it('parses "Confirmado"', () => {
    const result = parseTouchpointAction('Confirmado');
    expect(result.category).toBe('status');
    expect(result.title).toBe('Confirmado por operadora');
  });

  it('parses "Cancelado: reason"', () => {
    const result = parseTouchpointAction('Cancelado: No quiere');
    expect(result.category).toBe('status');
    expect(result.title).toBe('Cancelado por operadora');
    expect(result.description).toBe('No quiere');
  });

  it('parses "Cancelado" without reason', () => {
    const result = parseTouchpointAction('Cancelado');
    expect(result.category).toBe('status');
    expect(result.description).toBeUndefined();
  });

  it('parses "No respondió"', () => {
    const result = parseTouchpointAction('No respondió');
    expect(result.category).toBe('status');
    expect(result.title).toBe('No respondió la llamada');
  });

  it('parses "No respondio" (no accent)', () => {
    const result = parseTouchpointAction('No respondio');
    expect(result.category).toBe('status');
  });

  it('parses "NOVEDAD: Volver a ofrecer — solution"', () => {
    const result = parseTouchpointAction('NOVEDAD: Volver a ofrecer — Cambio dirección');
    expect(result.category).toBe('novedad');
    expect(result.title).toBe('Novedad: Volver a ofrecer');
    expect(result.description).toBe('Cambio dirección');
  });

  it('parses "NOVEDAD: Devolver al remitente"', () => {
    const result = parseTouchpointAction('NOVEDAD: Devolver al remitente');
    expect(result.category).toBe('novedad');
    expect(result.title).toBe('Novedad: Devolver al remitente');
  });

  it('parses future "CALL:" prefix', () => {
    const result = parseTouchpointAction('CALL: Llamada saliente');
    expect(result.category).toBe('call');
    expect(result.title).toBe('Llamada');
    expect(result.description).toBe('Llamada saliente');
  });

  it('parses future "WHATSAPP:" prefix', () => {
    const result = parseTouchpointAction('WHATSAPP: Mensaje enviado');
    expect(result.category).toBe('whatsapp');
  });

  it('parses future "SMS:" prefix', () => {
    const result = parseTouchpointAction('SMS: Plantilla cobro');
    expect(result.category).toBe('sms');
  });

  it('falls back to system for unknown actions', () => {
    const result = parseTouchpointAction('Algo raro');
    expect(result.category).toBe('system');
    expect(result.title).toBe('Algo raro');
  });

  it('handles empty/null action', () => {
    const result = parseTouchpointAction('');
    expect(result.category).toBe('system');
    expect(result.title).toBe('Evento');
  });
});

describe('buildTimeline', () => {
  const baseOrder: TimelineOrderRow = {
    id: 'order-1',
    external_id: 'EXT-100',
    nombre: 'Juan',
    estado: 'EN REPARTO',
    fecha: '2026-04-10',
    fecha_conf: '2026-04-11',
    guia: 'G999',
    transportadora: 'TCC',
    novedad: null,
    novedad_sol: false,
    created_at: '2026-04-10T08:00:00Z',
  };

  const baseSources: TimelineSources = {
    order: baseOrder,
    touchpoints: [],
    notes: [],
    orderResults: [],
    operatorNames: { 'op-1': 'María', 'op-2': 'Carlos' },
  };

  it('generates synthetic events from order data', () => {
    const events = buildTimeline(baseSources);
    const titles = events.map(e => e.title);
    expect(titles).toContain('Pedido creado');
    expect(titles).toContain('Guía generada — TCC');
  });

  it('includes external_id in "Pedido creado" description', () => {
    const events = buildTimeline(baseSources);
    const created = events.find(e => e.title === 'Pedido creado');
    expect(created?.description).toContain('EXT-100');
  });

  it('includes touchpoint events', () => {
    const tp: TimelineTouchpoint = {
      id: 'tp-1',
      phone: '311',
      action: 'Confirmado',
      operator_id: 'op-1',
      action_date: '2026-04-11',
      action_time: '10:30',
      created_at: '2026-04-11T10:30:00Z',
    };
    const events = buildTimeline({ ...baseSources, touchpoints: [tp] });
    const confEvent = events.find(e => e.title === 'Confirmado por operadora');
    expect(confEvent).toBeDefined();
    expect(confEvent!.actor).toBe('María');
  });

  it('includes notes', () => {
    const note: TimelineNote = {
      id: 'n-1',
      note_text: 'Cliente llamó pidiendo ETA',
      operator_id: 'op-2',
      created_at: '2026-04-12T14:00:00Z',
    };
    const events = buildTimeline({ ...baseSources, notes: [note] });
    const noteEvent = events.find(e => e.title === 'Nota');
    expect(noteEvent).toBeDefined();
    expect(noteEvent!.description).toBe('Cliente llamó pidiendo ETA');
    expect(noteEvent!.actor).toBe('Carlos');
  });

  it('includes order results not duplicated by touchpoints', () => {
    const or: TimelineOrderResult = {
      id: 'or-1',
      result: 'conf',
      reason: null,
      operator_id: 'op-1',
      result_date: '2026-04-11',
      result_time: '10:30',
      created_at: '2026-04-11T10:30:00Z',
    };
    // No touchpoints, so result should appear
    const events = buildTimeline({ ...baseSources, orderResults: [or] });
    const confEvent = events.find(e => e.id === 'or-or-1');
    expect(confEvent).toBeDefined();
    expect(confEvent!.title).toBe('Confirmado por operadora');
  });

  it('deduplicates order results when near-matching touchpoint exists', () => {
    const tp: TimelineTouchpoint = {
      id: 'tp-1',
      phone: '311',
      action: 'Confirmado',
      operator_id: 'op-1',
      action_date: '2026-04-11',
      action_time: '10:30',
      created_at: '2026-04-11T10:30:00Z',
    };
    const or: TimelineOrderResult = {
      id: 'or-1',
      result: 'conf',
      reason: null,
      operator_id: 'op-1',
      result_date: '2026-04-11',
      result_time: '10:30',
      created_at: '2026-04-11T10:30:30Z', // 30 seconds later
    };
    const events = buildTimeline({ ...baseSources, touchpoints: [tp], orderResults: [or] });
    // Should only have the touchpoint version, not the order_result duplicate
    const confEvents = events.filter(e => e.title === 'Confirmado por operadora');
    expect(confEvents).toHaveLength(1);
    expect(confEvents[0].id).toBe('tp-tp-1');
  });

  it('sorts events newest first', () => {
    const tp1: TimelineTouchpoint = {
      id: 'tp-1', phone: '311', action: 'No respondió',
      operator_id: 'op-1', action_date: '2026-04-11', action_time: '08:00',
      created_at: '2026-04-11T08:00:00Z',
    };
    const tp2: TimelineTouchpoint = {
      id: 'tp-2', phone: '311', action: 'Confirmado',
      operator_id: 'op-1', action_date: '2026-04-12', action_time: '09:00',
      created_at: '2026-04-12T09:00:00Z',
    };
    const events = buildTimeline({ ...baseSources, touchpoints: [tp1, tp2] });
    // First event should be the most recent
    const tpEvents = events.filter(e => e.id.startsWith('tp-'));
    expect(tpEvents[0].id).toBe('tp-tp-2');
  });

  it('generates novedad event for orders in NOVEDAD state', () => {
    const novedadOrder: TimelineOrderRow = {
      ...baseOrder,
      estado: 'NOVEDAD',
      novedad: 'Dirección incorrecta',
    };
    const events = buildTimeline({ ...baseSources, order: novedadOrder });
    const novedadEvent = events.find(e => e.title === 'Novedad reportada por transportadora');
    expect(novedadEvent).toBeDefined();
    expect(novedadEvent!.description).toBe('Dirección incorrecta');
  });

  it('shows "Operadora" when operator name is not in the map', () => {
    const tp: TimelineTouchpoint = {
      id: 'tp-1', phone: '311', action: 'Confirmado',
      operator_id: 'unknown-id', action_date: '2026-04-11', action_time: '10:00',
      created_at: '2026-04-11T10:00:00Z',
    };
    const events = buildTimeline({ ...baseSources, touchpoints: [tp] });
    const confEvent = events.find(e => e.id === 'tp-tp-1');
    expect(confEvent!.actor).toBe('Operadora');
  });

  it('returns empty array when order has no dates', () => {
    const emptyOrder: TimelineOrderRow = {
      id: 'order-empty',
      fecha: null,
      created_at: null,
    };
    const events = buildTimeline({ order: emptyOrder, touchpoints: [], notes: [], orderResults: [] });
    expect(events).toHaveLength(0);
  });

  it('emits Dropi status-history events with friendly labels', () => {
    const statusChanges: TimelineStatusChange[] = [
      { id: 1, status: 'GUIA_GENERADA', changed_at: '2026-04-11T10:00:00Z' },
      { id: 2, status: 'PREPARADO PARA TRANSPORTADORA', changed_at: '2026-04-11T16:00:00Z' },
      { id: 3, status: 'DESPACHADA', changed_at: '2026-04-11T22:00:00Z' },
    ];
    const events = buildTimeline({ ...baseSources, statusChanges });
    const titles = events.map(e => e.title);
    expect(titles).toContain('Preparado para transportadora');
    expect(titles).toContain('Despachada');
    const guia = events.find(e => e.id === 'status-1');
    expect(guia!.category).toBe('dropi');
    expect(guia!.title).toBe('Guía generada');
    expect(guia!.description).toContain('G999'); // enriquecido con el número de guía
  });

  it('suppresses the synthetic "Guía generada" milestone when status history exists', () => {
    const statusChanges: TimelineStatusChange[] = [
      { id: 1, status: 'GUIA_GENERADA', changed_at: '2026-04-11T10:00:00Z' },
    ];
    const events = buildTimeline({ ...baseSources, statusChanges });
    expect(events.find(e => e.id === `order-guia-${baseOrder.id}`)).toBeUndefined();
    expect(events.find(e => e.title === 'Pedido creado')).toBeDefined();
  });

  it('keeps the synthetic "Guía generada" when there is NO status history', () => {
    const events = buildTimeline(baseSources);
    expect(events.find(e => e.title === 'Guía generada — TCC')).toBeDefined();
  });

  it('collapses a duplicated current status (trigger row + Dropi entry)', () => {
    // El trigger local grabó "DESPACHADA" (detección tardía) y Dropi también la trae
    // (transición real, más temprana). Debe quedar UN solo evento "Despachada".
    const statusChanges: TimelineStatusChange[] = [
      { id: 'dropi-1', status: 'GUIA_GENERADA', changed_at: '2026-04-11T10:00:00Z' },
      { id: 'dropi-2', status: 'DESPACHADA', changed_at: '2026-04-11T22:00:00Z' },     // entrada real Dropi
      { id: 'trigger-9', status: 'DESPACHADA', changed_at: '2026-04-12T08:00:00Z' },   // fila tardía del trigger
    ];
    const events = buildTimeline({ ...baseSources, statusChanges });
    const despachadas = events.filter(e => e.title === 'Despachada');
    expect(despachadas).toHaveLength(1);
    // Conserva el timestamp más temprano (la transición real de Dropi)
    expect(despachadas[0].timestamp.toISOString()).toBe('2026-04-11T22:00:00.000Z');
  });

  it('preserves a non-consecutive repeated status (e.g. NOVEDAD que reaparece)', () => {
    const statusChanges: TimelineStatusChange[] = [
      { id: 1, status: 'NOVEDAD', changed_at: '2026-04-11T10:00:00Z' },
      { id: 2, status: 'EN REPARTO', changed_at: '2026-04-12T10:00:00Z' },
      { id: 3, status: 'NOVEDAD', changed_at: '2026-04-13T10:00:00Z' },
    ];
    const events = buildTimeline({ ...baseSources, statusChanges });
    // Dos NOVEDAD separadas por EN REPARTO → ambas se conservan
    expect(events.filter(e => e.title === 'Novedad')).toHaveLength(2);
  });
});

describe('prettyStatus', () => {
  it('maps known Dropi statuses to friendly labels', () => {
    expect(prettyStatus('DESPACHADA')).toBe('Despachada');
    expect(prettyStatus('PREPARADO PARA TRANSPORTADORA')).toBe('Preparado para transportadora');
    expect(prettyStatus('GUIA_GENERADA')).toBe('Guía generada');
  });

  it('title-cases unknown statuses as a fallback', () => {
    expect(prettyStatus('ALGO_RARO')).toBe('Algo Raro');
  });
});
