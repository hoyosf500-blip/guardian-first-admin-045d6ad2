import { describe, it, expect } from 'vitest';
import { conciliarDevoluciones, clasificarCobro, type CobroDevolucionRow } from './conciliacionDevoluciones';

function cobro(over: Partial<CobroDevolucionRow> = {}): CobroDevolucionRow {
  return {
    movimiento_id: 1,
    fecha_cobro: '2026-08-01T10:00:00Z',
    monto: 22000,
    external_id: '71014957',
    order_id: 'uuid-1',
    estado_guardian: 'DEVOLUCION',
    bucket_guardian: 'devuelto',
    total_periodo: null,
    plata_periodo: null,
    ...over,
  };
}

describe('clasificarCobro — tres problemas distintos, no uno', () => {
  it('con pedido devuelto → ok', () => {
    expect(clasificarCobro(cobro())).toBe('ok');
  });

  it('sin external_id → sin_referencia (NO "falta": es que no se puede verificar)', () => {
    expect(clasificarCobro(cobro({ external_id: null }))).toBe('sin_referencia');
    expect(clasificarCobro(cobro({ external_id: '   ' }))).toBe('sin_referencia');
  });

  it('con external_id pero sin pedido → no_esta (el sync nunca lo trajo)', () => {
    expect(clasificarCobro(cobro({ order_id: null, bucket_guardian: null }))).toBe('no_esta');
  });

  it('con pedido en otro estado → no_marcado (el caro: infla la tasa de entrega)', () => {
    expect(clasificarCobro(cobro({ estado_guardian: 'ENTREGADO', bucket_guardian: 'entregado' })))
      .toBe('no_marcado');
    expect(clasificarCobro(cobro({ estado_guardian: 'EN TRANSITO', bucket_guardian: 'en_transito' })))
      .toBe('no_marcado');
  });

  it('el orden de los checks importa: sin referencia gana aunque falte el pedido', () => {
    // Sin id no hay derecho a afirmar que el pedido falta.
    expect(clasificarCobro(cobro({ external_id: null, order_id: null }))).toBe('sin_referencia');
  });
});

describe('conciliarDevoluciones — la partición no puede perder cobros ni pesos', () => {
  it('INVARIANTE: los 4 grupos suman el total, en unidades y en plata', () => {
    const r = conciliarDevoluciones([
      cobro({ monto: 100 }),
      cobro({ monto: 200, external_id: null }),
      cobro({ monto: 300, external_id: '2', order_id: null, bucket_guardian: null }),
      cobro({ monto: 400, external_id: '3', bucket_guardian: 'entregado' }),
    ]);
    const cobros = r.ok.cobros + r.sinReferencia.cobros + r.noEsta.cobros + r.noMarcado.cobros;
    const plata = r.ok.plata + r.sinReferencia.plata + r.noEsta.plata + r.noMarcado.plata;
    expect(cobros).toBe(r.analizados);
    expect(cobros).toBe(4);
    expect(plata).toBe(1000);
  });

  it('sinRespaldo = no_esta + no_marcado, y NO incluye los sin referencia', () => {
    const r = conciliarDevoluciones([
      cobro({ monto: 200, external_id: null }),
      cobro({ monto: 300, external_id: '2', order_id: null, bucket_guardian: null }),
      cobro({ monto: 400, external_id: '3', bucket_guardian: 'entregado' }),
    ]);
    expect(r.sinRespaldo.cobros).toBe(2);
    expect(r.sinRespaldo.plata).toBe(700);
  });

  it('montos negativos cuentan por su magnitud (la billetera guarda el signo aparte)', () => {
    const r = conciliarDevoluciones([cobro({ monto: -22000, bucket_guardian: 'entregado' })]);
    expect(r.noMarcado.plata).toBe(22000);
  });

  it('sin filas: todo en cero y las tasas en null (no 0%, que sería afirmar algo)', () => {
    const r = conciliarDevoluciones([]);
    expect(r.analizados).toBe(0);
    expect(r.pctConRespaldoSobreVerificables).toBeNull();
    expect(r.pctVerificableSobreAnalizados).toBeNull();
    expect(r.externalIdsAReparar).toEqual([]);
  });
});

describe('la lista de reparación', () => {
  it('dedup: un pedido con DOS cobros se repesca UNA vez', () => {
    const r = conciliarDevoluciones([
      cobro({ external_id: '900', order_id: null, bucket_guardian: null, monto: 100 }),
      cobro({ external_id: '900', order_id: null, bucket_guardian: null, monto: 50 }),
    ]);
    expect(r.noEsta.cobros).toBe(2);          // los dos cobros se cuentan...
    expect(r.externalIdsAReparar).toEqual(['900']); // ...pero una sola llamada a Dropi
  });

  it('los sin referencia NO entran: no se puede repescar lo que no tiene id', () => {
    const r = conciliarDevoluciones([cobro({ external_id: null })]);
    expect(r.sinReferencia.cobros).toBe(1);
    expect(r.externalIdsAReparar).toEqual([]);
  });

  it('incluye tanto los que faltan como los desactualizados: la cura es la misma', () => {
    const r = conciliarDevoluciones([
      cobro({ external_id: '1', order_id: null, bucket_guardian: null }),
      cobro({ external_id: '2', bucket_guardian: 'entregado' }),
    ]);
    expect(r.externalIdsAReparar.sort()).toEqual(['1', '2']);
  });
});

describe('tasas y truncado', () => {
  it('NUNCA 100% con respaldo si queda un solo cobro sin respaldo', () => {
    const filas = Array.from({ length: 199 }, (_, i) => cobro({ external_id: `e${i}` }));
    filas.push(cobro({ external_id: 'malo', order_id: null, bucket_guardian: null }));
    const r = conciliarDevoluciones(filas);
    // 199/200 = 99.5 → floor 99. Con Math.round diría 100% teniendo un hueco real.
    expect(r.pctConRespaldoSobreVerificables).toBe(99);
  });

  it('100% solo cuando de verdad no falta ninguno (el caso Colombia medido)', () => {
    const r = conciliarDevoluciones(Array.from({ length: 77 }, (_, i) => cobro({ external_id: `c${i}` })));
    expect(r.pctConRespaldoSobreVerificables).toBe(100);
    expect(r.sinRespaldo.cobros).toBe(0);
  });

  it('la tasa de respaldo se mide sobre los VERIFICABLES, no sobre el total', () => {
    // 1 ok + 1 no_esta + 8 sin referencia: la tasa es 1 de 2, no 1 de 10.
    const filas = [
      cobro({ external_id: 'a' }),
      cobro({ external_id: 'b', order_id: null, bucket_guardian: null }),
      ...Array.from({ length: 8 }, () => cobro({ external_id: null })),
    ];
    const r = conciliarDevoluciones(filas);
    expect(r.verificables).toBe(2);
    expect(r.pctConRespaldoSobreVerificables).toBe(50);
    expect(r.pctVerificableSobreAnalizados).toBe(20);
  });

  it('parcial cuando el server truncó, usando su total real', () => {
    const r = conciliarDevoluciones([cobro({ total_periodo: 500, plata_periodo: 9_000_000 })]);
    expect(r.parcial).toBe(true);
    expect(r.totalPeriodo).toBe(500);
    expect(r.plataPeriodo).toBe(9_000_000);
  });

  it('si el server no manda total, se cae a lo analizado y NO se declara parcial', () => {
    const r = conciliarDevoluciones([cobro({ total_periodo: null })]);
    expect(r.totalPeriodo).toBe(1);
    expect(r.parcial).toBe(false);
  });
});
