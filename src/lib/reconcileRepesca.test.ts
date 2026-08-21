// Repesca de fantasmas rezagados (supabase/functions/_shared/reconcileRepesca.ts).
//
// Los casos usan los datos REALES medidos el 2026-08-05 contra la API de Dropi:
// 11 pedidos de Ecuador del 2 al 5 de julio, todos en PENDIENTE, todos con
// transportadora pero sin guía, y los 11 respondiendo "esta guía no existe en
// nuestro sistema". Habían quedado entre uno y cuatro días afuera de la ventana
// de 30 días del barrido, y por eso no se iban a detectar nunca.
//
// Lo que estas pruebas protegen es sobre todo el lado FAIL-CLOSED: archivar un
// pedido vivo lo saca de los tableros de la operación, así que ante cualquier
// duda la respuesta correcta es no tocar nada.

import { describe, it, expect } from 'vitest';
import {
  planRepesca,
  decidirArchivado,
  finDeMes,
  REPESCA_MAX_ARCHIVE_PER_RUN,
  type RepescaRow,
} from '../../supabase/functions/_shared/reconcileRepesca.ts';

const AHORA = Date.parse('2026-08-05T23:00:00Z');
const MIN_AGE = 48 * 3600 * 1000;

/** Los 11 fantasmas reales de Ecuador, verificados uno por uno contra Dropi. */
const FANTASMAS_EC: RepescaRow[] = [
  { id: 'a1', estado: null, external_id: '5968413', fecha: '2026-07-02', created_at: '2026-07-02T15:52:01Z' },
  { id: 'a2', estado: null, external_id: '5985197', fecha: '2026-07-03', created_at: '2026-07-03T20:25:12Z' },
  { id: 'a3', estado: null, external_id: '5988261', fecha: '2026-07-03', created_at: '2026-07-04T02:07:02Z' },
  { id: 'a4', estado: null, external_id: '5991596', fecha: '2026-07-04', created_at: '2026-07-04T13:02:03Z' },
  { id: 'a5', estado: null, external_id: '5995294', fecha: '2026-07-04', created_at: '2026-07-04T18:17:06Z' },
  { id: 'a6', estado: null, external_id: '5997396', fecha: '2026-07-04', created_at: '2026-07-04T23:07:03Z' },
  { id: 'a7', estado: null, external_id: '5998320', fecha: '2026-07-04', created_at: '2026-07-05T01:07:03Z' },
  { id: 'a8', estado: null, external_id: '5998357', fecha: '2026-07-04', created_at: '2026-07-05T01:12:02Z' },
  { id: 'a9', estado: null, external_id: '5999542', fecha: '2026-07-04', created_at: '2026-07-05T03:32:03Z' },
  { id: 'a10', estado: null, external_id: '6001614', fecha: '2026-07-05', created_at: '2026-07-05T13:22:02Z' },
  { id: 'a11', estado: null, external_id: '6002104', fecha: '2026-07-05', created_at: '2026-07-05T14:17:03Z' },
];

const barridoSano = (ids: string[], total: number) => ({
  ids: new Set(ids), complete: true, total,
});

describe('finDeMes', () => {
  it('resuelve meses de 30, 31 y el febrero bisiesto', () => {
    expect(finDeMes('2026-07')).toBe('2026-07-31');
    expect(finDeMes('2026-04')).toBe('2026-04-30');
    expect(finDeMes('2026-02')).toBe('2026-02-28');
    expect(finDeMes('2024-02')).toBe('2024-02-29');
    expect(finDeMes('2025-12')).toBe('2025-12-31');
  });
});

describe('planRepesca — elegir qué mes barrer', () => {
  it('sin rezagados no hay plan (y por lo tanto ni un request a Dropi)', () => {
    expect(planRepesca([], { ahoraMs: AHORA, minAgeMs: MIN_AGE })).toBeNull();
  });

  it('arma la ventana del mes de los 11 fantasmas de Ecuador', () => {
    const plan = planRepesca(FANTASMAS_EC, { ahoraMs: AHORA, minAgeMs: MIN_AGE });
    expect(plan).not.toBeNull();
    expect(plan!.yearMonth).toBe('2026-07');
    expect(plan!.from).toBe('2026-07-01');
    expect(plan!.to).toBe('2026-07-31');
    expect(plan!.candidatos).toHaveLength(11);
    // Corte temprano del paginado: el menor id de los candidatos.
    expect(plan!.stopBeforeId).toBe(5968413);
    expect(plan!.mesesRestantes).toBe(0);
  });

  it('toma el mes MÁS VIEJO primero y avisa cuántos quedan', () => {
    // Caso real de Colombia: rezagados desde abril hasta junio.
    const mezcla: RepescaRow[] = [
      { id: 'c1', estado: null, external_id: '78000001', fecha: '2026-06-20', created_at: '2026-06-20T10:00:00Z' },
      { id: 'c2', estado: null, external_id: '77000001', fecha: '2026-04-15', created_at: '2026-04-15T10:00:00Z' },
      { id: 'c3', estado: null, external_id: '77500001', fecha: '2026-05-02', created_at: '2026-05-02T10:00:00Z' },
      { id: 'c4', estado: null, external_id: '77000002', fecha: '2026-04-28', created_at: '2026-04-28T10:00:00Z' },
    ];
    const plan = planRepesca(mezcla, { ahoraMs: AHORA, minAgeMs: MIN_AGE });
    expect(plan!.yearMonth).toBe('2026-04');
    expect(plan!.candidatos.map(r => r.id).sort()).toEqual(['c2', 'c4']);
    // Mayo y junio quedan para las próximas dos noches — un mes por corrida.
    expect(plan!.mesesRestantes).toBe(2);
  });

  it('descarta lo que no se puede verificar en vez de arrastrarlo', () => {
    const basura: RepescaRow[] = [
      { id: 'x1', estado: null, external_id: null,      fecha: '2026-04-10', created_at: '2026-04-10T10:00:00Z' },
      { id: 'x2', estado: null, external_id: 'ABC-123', fecha: '2026-04-10', created_at: '2026-04-10T10:00:00Z' },
      { id: 'x3', estado: null, external_id: '77000009', fecha: null,        created_at: '2026-04-10T10:00:00Z' },
      { id: 'x4', estado: null, external_id: '77000010', fecha: '10/04/2026', created_at: '2026-04-10T10:00:00Z' },
    ];
    expect(planRepesca(basura, { ahoraMs: AHORA, minAgeMs: MIN_AGE })).toBeNull();
  });

  it('no toca pedidos recién dados de alta — puede ser lag del sync, no un fantasma', () => {
    const recien: RepescaRow[] = [
      { id: 'r1', estado: null, external_id: '6100000', fecha: '2026-06-01', created_at: '2026-08-05T22:00:00Z' },
    ];
    expect(planRepesca(recien, { ahoraMs: AHORA, minAgeMs: MIN_AGE })).toBeNull();
  });
});

describe('decidirArchivado — fail-closed ante cualquier duda', () => {
  const plan = planRepesca(FANTASMAS_EC, { ahoraMs: AHORA, minAgeMs: MIN_AGE })!;

  it('archiva los ausentes cuando el barrido vino completo', () => {
    // Dropi devolvió los 1.206 de julio y ninguno de los 11 está entre ellos.
    const d = decidirArchivado(plan, barridoSano(['6390534', '6390535'], 1206));
    expect(d.archivar).toHaveLength(11);
    expect(d.motivo).toContain('ARCHIVADO GHOST');
  });

  it('un barrido truncado por throttle NO archiva nada', () => {
    // Este es el caso que más importa: media lista faltante se lee igual que
    // "borrados" y archivaría medio mes de pedidos vivos.
    const d = decidirArchivado(plan, { ids: new Set(), complete: false, total: 300 });
    expect(d.archivar).toEqual([]);
    expect(d.motivo).toContain('INCOMPLETO');
  });

  it('un barrido vacío NO archiva nada aunque diga estar completo', () => {
    const d = decidirArchivado(plan, { ids: new Set(), complete: true, total: 0 });
    expect(d.archivar).toEqual([]);
    expect(d.motivo).toContain('VACÍO');
  });

  it('si el candidato SÍ está en Dropi no se toca — estaba vivo', () => {
    const todosVivos = barridoSano(FANTASMAS_EC.map(r => r.external_id!), 1206);
    const d = decidirArchivado(plan, todosVivos);
    expect(d.archivar).toEqual([]);
    expect(d.motivo).toContain('SÍ existen');
  });

  it('archiva solo los ausentes cuando hay mezcla de vivos y muertos', () => {
    const mitadViva = barridoSano(
      FANTASMAS_EC.slice(0, 6).map(r => r.external_id!), 1206,
    );
    const d = decidirArchivado(plan, mitadViva);
    expect(d.archivar.map(r => r.id)).toEqual(['a7', 'a8', 'a9', 'a10', 'a11']);
  });

  it('el tope por corrida frena una corrida desbocada en vez de barrer la base', () => {
    const muchos: RepescaRow[] = Array.from({ length: 500 }, (_, i) => ({
      id: 'm' + i,
      external_id: String(7000000 + i),
      estado: null,
      fecha: '2026-04-10',
      created_at: '2026-04-10T10:00:00Z',
    }));
    const planGrande = planRepesca(muchos, { ahoraMs: AHORA, minAgeMs: MIN_AGE })!;
    const d = decidirArchivado(planGrande, barridoSano(['999'], 1200));
    expect(d.archivar).toEqual([]);
    expect(d.motivo).toContain('supera el tope');
    expect(REPESCA_MAX_ARCHIVE_PER_RUN).toBe(200);
  });
});
