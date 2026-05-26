import { describe, it, expect } from 'vitest';
import {
  cleanSegAction,
  isSegCloser,
  isHiddenFromTodayList,
  hiddenLabel,
  CLOSER_SNOOZE_MS,
  type LatestTouch,
} from './segDailyReview';

const HOY = '2026-05-26';
const AYER = '2026-05-25';
const NOW = new Date(`${HOY}T15:00:00Z`).getTime();

describe('cleanSegAction', () => {
  it('quita el prefijo SEG:/RESCUE: y espacios', () => {
    expect(cleanSegAction('SEG: Llamé')).toBe('Llamé');
    expect(cleanSegAction('RESCUE: Resuelto')).toBe('Resuelto');
    expect(cleanSegAction('WhatsApp')).toBe('WhatsApp');
    expect(cleanSegAction('')).toBe('');
  });
});

describe('isSegCloser', () => {
  it('reconoce los cierres nuevos y los labels viejos', () => {
    expect(isSegCloser('SEG: Resuelto')).toBe(true);
    expect(isSegCloser('Devolución')).toBe(true);
    expect(isSegCloser('Devolucion solicitada')).toBe(true); // label viejo
    expect(isSegCloser('Solicite devolucion')).toBe(true);   // label viejo
  });
  it('los métodos NO son cierre', () => {
    expect(isSegCloser('SEG: Llamé')).toBe(false);
    expect(isSegCloser('WhatsApp')).toBe(false);
    expect(isSegCloser('Reclamé transportadora')).toBe(false);
    expect(isSegCloser('Esperando respuesta')).toBe(false); // label viejo, gestión
  });
});

describe('isHiddenFromTodayList', () => {
  it('sin touchpoint → visible (no oculto)', () => {
    expect(isHiddenFromTodayList(null, NOW, HOY)).toBe(false);
    expect(isHiddenFromTodayList(undefined, NOW, HOY)).toBe(false);
  });

  it('gestión HOY → oculto (gestionado hoy)', () => {
    const t: LatestTouch = { action: 'SEG: Llamé', actionDate: HOY, whenMs: NOW - 3600000 };
    expect(isHiddenFromTodayList(t, NOW, HOY)).toBe(true);
  });

  it('gestión de AYER → visible (reapareció: revisión diaria)', () => {
    const t: LatestTouch = { action: 'SEG: WhatsApp', actionDate: AYER, whenMs: NOW - 24 * 3600000 };
    expect(isHiddenFromTodayList(t, NOW, HOY)).toBe(false);
  });

  it('cierre reciente (10 días) → oculto', () => {
    const t: LatestTouch = { action: 'SEG: Resuelto', actionDate: '2026-05-16', whenMs: NOW - 10 * 24 * 3600000 };
    expect(isHiddenFromTodayList(t, NOW, HOY)).toBe(true);
  });

  it('cierre viejo (40 días) → visible de nuevo (nuevo ciclo)', () => {
    const t: LatestTouch = { action: 'SEG: Devolución', actionDate: '2026-04-16', whenMs: NOW - 40 * 24 * 3600000 };
    expect(isHiddenFromTodayList(t, NOW, HOY)).toBe(false);
  });

  it('límite exacto de 30 días para cierre', () => {
    const justInside: LatestTouch = { action: 'Resuelto', actionDate: '', whenMs: NOW - (CLOSER_SNOOZE_MS - 1000) };
    const justOutside: LatestTouch = { action: 'Resuelto', actionDate: '', whenMs: NOW - (CLOSER_SNOOZE_MS + 1000) };
    expect(isHiddenFromTodayList(justInside, NOW, HOY)).toBe(true);
    expect(isHiddenFromTodayList(justOutside, NOW, HOY)).toBe(false);
  });
});

describe('hiddenLabel', () => {
  it('método → "Gestionado hoy"', () => {
    expect(hiddenLabel({ action: 'SEG: Llamé', actionDate: HOY, whenMs: NOW })).toBe('Gestionado hoy');
  });
  it('cierre → nombre del cierre', () => {
    expect(hiddenLabel({ action: 'SEG: Resuelto', actionDate: HOY, whenMs: NOW })).toBe('Resuelto');
    expect(hiddenLabel({ action: 'SEG: Devolución', actionDate: HOY, whenMs: NOW })).toBe('Devolución');
  });
});
