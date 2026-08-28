import { describe, it, expect, vi, afterEach } from 'vitest';
import { emitirGestion, onGestion, EVENTO_GESTION, type DetalleGestion } from './eventosGestion';
import { aplicarGestionEnVivo } from './gestionPorPedido';

const base = (over: Partial<DetalleGestion> = {}): DetalleGestion => ({
  phone: '0985437395',
  modulo: 'SEG',
  accion: 'Avisé: en oficina',
  operatorId: 'ana',
  at: '2026-08-27T20:00:00.000Z',
  ...over,
});

afterEach(() => { vi.restoreAllMocks(); });

describe('emitirGestion / onGestion', () => {
  it('el suscriptor recibe el detalle tal cual', () => {
    const visto: DetalleGestion[] = [];
    const off = onGestion((d) => visto.push(d));
    emitirGestion(base());
    off();
    expect(visto).toHaveLength(1);
    expect(visto[0].phone).toBe('0985437395');
    expect(visto[0].accion).toBe('Avisé: en oficina');
  });

  it('desuscribirse corta de verdad — un componente desmontado no sigue contando', () => {
    const visto: DetalleGestion[] = [];
    const off = onGestion((d) => visto.push(d));
    off();
    emitirGestion(base());
    expect(visto).toHaveLength(0);
  });

  it('sin teléfono NO se avisa: es la clave con la que Seguimiento cruza todo', () => {
    const visto: DetalleGestion[] = [];
    const off = onGestion((d) => visto.push(d));
    window.dispatchEvent(new CustomEvent(EVENTO_GESTION, { detail: { ...base(), phone: '' } }));
    off();
    expect(visto).toHaveLength(0);
  });
});

// ── El bug de doble conteo (auditoría del 27-ago-2026) ──────────────────────
// `aplicarGestionEnVivo` deduplica comparando el `at`. Los avisos que emiten
// los envíos de WhatsApp llevan la hora del NAVEGADOR (la fila la inserta la
// edge function y no vuelve), así que nunca coinciden con el `created_at` que
// trae el realtime: sin la marca `optimista`, un solo mensaje se contaba dos
// veces y la tarjeta decía "2 gestiones".
describe('⛔ optimista: por qué el intento no se cuenta dos veces', () => {
  const CLAVE = '0985437395';

  it('mismo `at` (viene de la base) → el realtime NO duplica el intento', () => {
    const at = '2026-08-27T20:00:00.000Z';
    let m = aplicarGestionEnVivo(new Map(), CLAVE, { at, por: 'ana', result: 'Avisé: en oficina' });
    m = aplicarGestionEnVivo(m, CLAVE, { at, por: 'ana', result: 'Avisé: en oficina' });
    expect(m.get(CLAVE)!.intentos).toBe(1);
  });

  it('`at` distinto (hora del navegador vs de la base) → SÍ contaría doble', () => {
    // Este es el hecho que obliga a la marca `optimista`: no es una precaución,
    // es la reproducción del bug.
    let m = aplicarGestionEnVivo(new Map(), CLAVE, { at: '2026-08-27T20:00:00.100Z', por: 'ana', result: 'Escribí por WhatsApp' });
    m = aplicarGestionEnVivo(m, CLAVE, { at: '2026-08-27T20:00:00.317Z', por: 'ana', result: 'Escribí por WhatsApp' });
    expect(m.get(CLAVE)!.intentos).toBe(2);
  });

  it('el detalle lleva la marca para que el consumidor pueda distinguirlos', () => {
    const visto: DetalleGestion[] = [];
    const off = onGestion((d) => visto.push(d));
    emitirGestion(base({ optimista: true }));
    emitirGestion(base({ at: '2026-08-27T20:05:00.000Z' }));
    off();
    expect(visto.map((d) => d.optimista === true)).toEqual([true, false]);
  });
});
