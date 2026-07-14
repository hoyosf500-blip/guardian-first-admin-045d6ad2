// src/lib/dropiSyncFailures.test.ts
import { describe, it, expect } from 'vitest';
import { isDuplicadoVivo, editAppliedEvidence, parseFirstOrderRef } from './dropiSyncFailures';

describe('isDuplicadoVivo', () => {
  it('nota de dropi-change-carrier con prefijo EDICIÓN: -> true', () => {
    expect(isDuplicadoVivo('EDICIÓN: <DUPLICADO VIVO en Dropi: #6110526 (PENDIENTE)>')).toBe(true);
  });

  it('nota que contiene DUPLICADO VIVO sin prefijo -> true', () => {
    expect(isDuplicadoVivo('DUPLICADO VIVO en Dropi: #123')).toBe(true);
  });

  // Los settles de settleAudit.ts escriben 'EDICIÓN falló:' / 'EDICIÓN INCIERTA'
  // — ediciones fallidas DE VERDAD, no alertas de duplicado.
  it("'EDICIÓN falló:' NO es duplicado vivo", () => {
    expect(isDuplicadoVivo('EDICIÓN falló: Dropi rechazó [404]')).toBe(false);
  });

  it("'EDICIÓN INCIERTA' NO es duplicado vivo", () => {
    expect(isDuplicadoVivo('EDICIÓN INCIERTA — no reintentar: x')).toBe(false);
  });

  // El guard de dropi-change-carrier también persiste con prefijo 'EDICIÓN: '
  // warnings de verificación INCIERTA (liveness unknown) — NO son duplicados
  // confirmados; matchearlos generaría un CTA "Cancelá el duplicado" sobre
  // una orden probablemente ya muerta. Por eso el helper exige el literal
  // 'DUPLICADO VIVO' y NO alcanza el prefijo.
  it("warning de verificación incierta con prefijo 'EDICIÓN: ' NO es duplicado vivo", () => {
    expect(isDuplicadoVivo(
      'EDICIÓN: No pude verificar si la orden vieja #6099111 quedó fuera de Dropi — revisala en el panel.',
    )).toBe(false);
  });

  it('nota vacía -> false', () => {
    expect(isDuplicadoVivo('')).toBe(false);
  });
});

describe('editAppliedEvidence', () => {
  const created = '2026-07-13T10:00:00.000Z';

  it('last_edit_sync_at posterior al created_at de la auditoría -> aplicada', () => {
    expect(editAppliedEvidence('edicion_orden', created, '2026-07-13T10:05:00.000Z')).toBe(true);
  });

  it('last_edit_sync_at igual al created_at -> aplicada (>=)', () => {
    expect(editAppliedEvidence('cambio_valor', created, created)).toBe(true);
  });

  it('last_edit_sync_at ANTERIOR (edición vieja, no esta) -> false', () => {
    expect(editAppliedEvidence('edicion_orden', created, '2026-07-13T09:00:00.000Z')).toBe(false);
  });

  it('sin last_edit_sync_at (null/undefined) -> false', () => {
    expect(editAppliedEvidence('edicion_orden', created, null)).toBe(false);
    expect(editAppliedEvidence('edicion_orden', created, undefined)).toBe(false);
  });

  it('last_edit_sync_at no parseable -> false', () => {
    expect(editAppliedEvidence('edicion_orden', created, 'no-es-fecha')).toBe(false);
  });

  it('result que no es edición (conf/canc) -> false aunque haya timestamp', () => {
    expect(editAppliedEvidence('conf', created, '2026-07-13T10:05:00.000Z')).toBe(false);
    expect(editAppliedEvidence('canc', created, '2026-07-13T10:05:00.000Z')).toBe(false);
  });
});

describe('parseFirstOrderRef', () => {
  it('extrae el primer #id de 5+ dígitos', () => {
    expect(parseFirstOrderRef('EDICIÓN: <DUPLICADO VIVO en Dropi: #6110526 (PENDIENTE)>')).toBe('6110526');
  });

  it('sin match -> null', () => {
    expect(parseFirstOrderRef('sin referencias acá')).toBe(null);
  });

  it('id corto (#123) no cuenta como referencia de pedido -> null', () => {
    expect(parseFirstOrderRef('reintento #123 fallido')).toBe(null);
  });
});
