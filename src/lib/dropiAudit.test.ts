import { describe, it, expect } from 'vitest';
import { findDivergences, mapDropiStatusToGuardian, type GuardianOrder, type DropiOrder } from './dropiAudit';

describe('mapDropiStatusToGuardian', () => {
  it('GENERADA → GUIA_GENERADA', () => {
    expect(mapDropiStatusToGuardian('GENERADA')).toBe('GUIA_GENERADA');
  });
  it('uppercases otros estados', () => {
    expect(mapDropiStatusToGuardian('entregado')).toBe('ENTREGADO');
  });
});

describe('findDivergences', () => {
  it('detecta GENERADA → GUIA_GENERADA con guía nueva', () => {
    const g: GuardianOrder[] = [{
      id: 'x', external_id: '5545005', estado: 'PENDIENTE', guia: '',
      transportadora: 'GINTRACOM', nombre: 'Ramón',
    }];
    const d = new Map<string, DropiOrder>([
      ['5545005', { id: '5545005', status: 'GENERADA', guia: 'D001655887', trans: 'GINTRACOM', name: 'Ramón' }],
    ]);
    const out = findDivergences(g, d);
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe('update');
    expect(out[0].after.estado).toBe('GUIA_GENERADA');
    expect(out[0].after.guia).toBe('D001655887');
  });

  it('marca huérfano pre-backfill (id < 5M) como cancel_orphan', () => {
    const g: GuardianOrder[] = [{
      id: 'x', external_id: '3453470', estado: 'GUIA_GENERADA', guia: '187204816',
      transportadora: 'SERVIENTREGA', nombre: 'Carlos',
    }];
    const d = new Map<string, DropiOrder>();
    const out = findDivergences(g, d);
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe('cancel_orphan');
    expect(out[0].after.estado).toBe('CANCELADO');
  });

  it('NO cancela huérfano post-backfill (id >= 5M)', () => {
    const g: GuardianOrder[] = [{
      id: 'x', external_id: '5575133', estado: 'PENDIENTE', guia: '',
      transportadora: 'LAARCOURIER', nombre: 'Soledad',
    }];
    const d = new Map<string, DropiOrder>();
    const out = findDivergences(g, d);
    expect(out).toHaveLength(0);
  });

  it('idéntico en ambos lados → sin divergencia', () => {
    const g: GuardianOrder[] = [{
      id: 'x', external_id: '5575197', estado: 'GUIA_GENERADA', guia: 'D001655606',
      transportadora: 'GINTRACOM', nombre: 'Diego',
    }];
    const d = new Map<string, DropiOrder>([
      ['5575197', { id: '5575197', status: 'GENERADA', guia: 'D001655606', trans: 'GINTRACOM', name: 'Diego' }],
    ]);
    const out = findDivergences(g, d);
    expect(out).toHaveLength(0);
  });

  it('detecta cambio solo de transportadora', () => {
    const g: GuardianOrder[] = [{
      id: 'x', external_id: '5600000', estado: 'GUIA_GENERADA', guia: 'D1',
      transportadora: 'SERVIENTREGA', nombre: 'A',
    }];
    const d = new Map<string, DropiOrder>([
      ['5600000', { id: '5600000', status: 'GENERADA', guia: 'D1', trans: 'GINTRACOM', name: 'A' }],
    ]);
    const out = findDivergences(g, d);
    expect(out).toHaveLength(1);
    expect(out[0].after.trans).toBe('GINTRACOM');
  });
});
