import { describe, it, expect } from 'vitest';
import { bucketizeEstados, normalizeEstado, type EstadoRow } from './estadoBuckets';

const rows: EstadoRow[] = [
  { estado: 'ENTREGADO',             pedidos: 69, valor: 6_899_293, unidades: 86 },
  { estado: 'DEVOLUCION',            pedidos: 19, valor: 2_513_199, unidades: 22 },
  { estado: 'EN TRANSPORTE',         pedidos: 17, valor: 1_707_000, unidades: 20 },
  { estado: 'NOVEDAD',               pedidos: 4,  valor: 418_549,   unidades: 4 },
  { estado: 'PENDIENTE CONFIRMACION', pedidos: 9, valor: 1_200_000, unidades: 9 },
  { estado: 'PENDIENTE',             pedidos: 25, valor: 2_360_000, unidades: 28 },
  { estado: 'CANCELADO',             pedidos: 31, valor: 3_200_701, unidades: 33 },
  // los que antes caían en "Otros":
  { estado: 'GUIA_GENERADA',         pedidos: 20, valor: 2_000_000, unidades: 24 },
  { estado: 'CONFIRMADO',            pedidos: 12, valor: 1_200_000, unidades: 14 },
];

describe('normalizeEstado', () => {
  it('mayúsculas + underscore→espacio + colapsa espacios', () => {
    expect(normalizeEstado('guia_generada')).toBe('GUIA GENERADA');
    expect(normalizeEstado('  Pendiente   Confirmacion ')).toBe('PENDIENTE CONFIRMACION');
  });
});

describe('bucketizeEstados', () => {
  it('SIN HUECOS: Σ(buckets) + Σ(otros) === totals.pedidos', () => {
    const r = bucketizeEstados(rows);
    const sumaBuckets = Object.values(r.buckets).reduce((a, b) => a + b.pedidos, 0);
    const sumaOtros = r.otros.reduce((a, b) => a + b.pedidos, 0);
    expect(sumaBuckets + sumaOtros).toBe(r.totals.pedidos);
    expect(r.totals.pedidos).toBe(206);
  });

  it('GUIA_GENERADA y CONFIRMADO caen en preparacion (ya no en Otros)', () => {
    const r = bucketizeEstados(rows);
    expect(r.buckets.preparacion.pedidos).toBe(32); // 20 + 12
    expect(r.buckets.preparacion.valor).toBe(3_200_000);
    expect(r.otros).toHaveLength(0);
  });

  it('combina los dos pendientes en el bucket pendiente', () => {
    const r = bucketizeEstados(rows);
    expect(r.buckets.pendiente.pedidos).toBe(34); // 9 + 25
  });

  it('estado desconocido va a otros ITEMIZADO por nombre (no oculto)', () => {
    const r = bucketizeEstados([
      ...rows,
      { estado: 'ESTADO_INVENTADO_XYZ', pedidos: 3, valor: 500, unidades: 3 },
    ]);
    const otro = r.otros.find((o) => o.estado === 'ESTADO_INVENTADO_XYZ');
    expect(otro).toBeDefined();
    expect(otro!.pedidos).toBe(3);
    // el detector lo expone por nombre crudo
    expect(r.estadosSinMapear).toContain('ESTADO_INVENTADO_XYZ');
    // sigue cuadrando con el total
    const sumaBuckets = Object.values(r.buckets).reduce((a, b) => a + b.pedidos, 0);
    const sumaOtros = r.otros.reduce((a, b) => a + b.pedidos, 0);
    expect(sumaBuckets + sumaOtros).toBe(r.totals.pedidos);
  });

  it('suma valor y unidades por bucket', () => {
    const r = bucketizeEstados(rows);
    expect(r.buckets.entregado.valor).toBe(6_899_293);
    expect(r.buckets.entregado.unidades).toBe(86);
    expect(r.buckets.cancelado.pedidos).toBe(31);
  });

  it('rango vacío → todo en cero, sin crashear', () => {
    const r = bucketizeEstados([]);
    expect(r.totals.pedidos).toBe(0);
    expect(r.otros).toHaveLength(0);
    expect(r.buckets.entregado.pedidos).toBe(0);
  });

  it('REENVÍO con acento y variantes de devolución se mapean', () => {
    const r = bucketizeEstados([
      { estado: 'REENVÍO', pedidos: 2, valor: 100, unidades: 2 },
      { estado: 'DEVOLUCION EN TRANSITO', pedidos: 1, valor: 50, unidades: 1 },
    ]);
    expect(r.buckets.en_transito.pedidos).toBe(2);
    expect(r.buckets.devuelto.pedidos).toBe(1);
    expect(r.otros).toHaveLength(0);
  });

  it('mapea los 4 estados que antes caían en otros (3 tránsito + 1 novedad)', () => {
    const r = bucketizeEstados([
      { estado: 'DESPACHADA',         pedidos: 5, valor: 100, unidades: 5 },
      { estado: 'EN BODEGA DESTINO',  pedidos: 3, valor: 60,  unidades: 3 },
      { estado: 'EN PUNTO DROOP',     pedidos: 1, valor: 20,  unidades: 1 },
      { estado: 'RECLAME EN OFICINA', pedidos: 4, valor: 80,  unidades: 4 },
    ]);
    expect(r.buckets.en_transito.pedidos).toBe(9); // 5 + 3 + 1
    expect(r.buckets.novedad.pedidos).toBe(4);     // RECLAME EN OFICINA
    expect(r.otros).toHaveLength(0);
    expect(r.estadosSinMapear).toEqual([]);
  });

  it('estadosSinMapear lista el nombre CRUDO de los estados sin bucket', () => {
    const r = bucketizeEstados([
      { estado: 'ENTREGADO',          pedidos: 5, valor: 100, unidades: 5 },
      { estado: 'ESTADO_NUEVO_DROPI', pedidos: 2, valor: 40,  unidades: 2 },
    ]);
    expect(r.estadosSinMapear).toEqual(['ESTADO_NUEVO_DROPI']);
  });
});
