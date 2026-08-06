// Balance mensual + cruce de rendiciones.
//
// Los casos usan los NÚMEROS REALES de la tienda de Ecuador, mayo–julio 2026,
// los mismos que se conciliaron a mano contra la billetera de Dropi movimiento
// por movimiento (903 movimientos, cero sin clasificar). Si algún día estos
// tests fallan, o cambió la fórmula o cambió el significado de una columna —
// las dos cosas hay que mirarlas antes de tocar nada.
//
// El caso estrella es el del cargo repetido: "UGLY 06/07" por $500 se pagó el
// 19-jul y volvió a cobrarse el 23-jul. Nadie lo vio hasta poner las dos listas
// lado a lado a mano. Que eso lo encuentre el sistema es el motivo del módulo.

import { describe, it, expect } from 'vitest';
import {
  construirBalance,
  cruzarRendiciones,
  normalizarConcepto,
  mesesEntre,
  type MesCrudo,
  type Rendicion,
} from './balanceRendiciones';

/** Mayo, junio y julio 2026 de Ecuador, tal como los devolvería el RPC. */
const EC_MAY_JUL: MesCrudo[] = [
  { year_month: '2026-05', operativo: 2145.03, pauta: 2309.00, admin: 200, retirado: 2500, rendido: 2500, pedidos: 700,  entregados: 287, devueltos: 152 },
  { year_month: '2026-06', operativo: 3980.47, pauta: 3640.00, admin: 229, retirado: 3500, rendido: 3500, pedidos: 1100, entregados: 520, devueltos: 305 },
  { year_month: '2026-07', operativo: 4476.08, pauta: 2828.00, admin: 175, retirado: 3381.28, rendido: 2862.28, pedidos: 1206, entregados: 514, devueltos: 233 },
];

describe('construirBalance — la hoja RESUMEN', () => {
  const { meses, totales } = construirBalance(EC_MAY_JUL);

  it('mayo cierra en pérdida y julio en ganancia, como fue', () => {
    expect(meses[0].invertido).toBeCloseTo(2509.00, 2);
    expect(meses[0].utilidad).toBeCloseTo(-363.97, 2);   // el mes que se perdió
    expect(meses[2].utilidad).toBeCloseTo(1473.08, 2);   // el mes que levantó
  });

  it('el total da la utilidad conciliada de los 3 meses', () => {
    expect(totales.operativo).toBeCloseTo(10601.58, 2);
    expect(totales.invertido).toBeCloseTo(9381.00, 2);
    expect(totales.utilidad).toBeCloseTo(1220.58, 2);
  });

  it('el ROI de los 3 meses reales', () => {
    expect(totales.roi).toBeCloseTo(13.0, 1);
  });

  it('el ROI del total se recalcula, NO se promedian los mensuales', () => {
    // Con los 3 meses reales las dos formas dan casi lo mismo por casualidad, así
    // que el caso se arma con la forma que SÍ rompe: un mes chico y espectacular
    // al lado de uno grande y mediocre. Promediar porcentajes le da el mismo peso
    // a $10 que a $10.000 y devuelve una cifra que no le pasó a nadie.
    const desparejo: MesCrudo[] = [
      { year_month: '2026-01', operativo: 30,     pauta: 10,    admin: 0, retirado: 0, rendido: 0, pedidos: 0, entregados: 0, devueltos: 0 },
      { year_month: '2026-02', operativo: 10_500, pauta: 10_000, admin: 0, retirado: 0, rendido: 0, pedidos: 0, entregados: 0, devueltos: 0 },
    ];
    const { meses: m, totales: t } = construirBalance(desparejo);
    expect(m[0].roi).toBeCloseTo(200, 1);   // el mes chico: +200%
    expect(m[1].roi).toBeCloseTo(5, 1);     // el grande: +5%
    // Promediar daría ~102,5%, como si el negocio hubiera duplicado la plata.
    const promedioIngenuo = (m[0].roi! + m[1].roi!) / 2;
    expect(promedioIngenuo).toBeCloseTo(102.5, 1);
    // Lo real: $10.530 de operativo sobre $10.010 invertidos = +5,2%.
    expect(t.roi).toBeCloseTo(5.2, 1);
  });

  it('la tasa de entrega es la MADURA, no entregados ÷ pedidos', () => {
    // Julio: 514 de 747 concluidos = 68,8%. Sobre los 1.206 pedidos daría 42,6%,
    // que es el sesgo que se corrigió en /logistica el 2026-08-05.
    expect(meses[2].tasaEntrega).toBeCloseTo(68.8, 1);
    const cruda = (514 / 1206) * 100;
    expect(Math.abs(meses[2].tasaEntrega! - cruda)).toBeGreaterThan(20);
  });

  it('sin inversión no inventa un ROI', () => {
    const { meses: m } = construirBalance([
      { year_month: '2026-04', operativo: 500, pauta: 0, admin: 0, retirado: 0, rendido: 0, pedidos: 0, entregados: 0, devueltos: 0 },
    ]);
    expect(m[0].roi).toBeNull();          // no hay ROI de dividir por cero
    expect(m[0].tasaEntrega).toBeNull();  // ni tasa sin pedidos concluidos
    expect(m[0].utilidad).toBe(500);
  });

  it('un período vacío da ceros, no explota', () => {
    const { meses, totales } = construirBalance([]);
    expect(meses).toEqual([]);
    expect(totales.utilidad).toBe(0);
    expect(totales.roi).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/** Las tres rendiciones reales de julio, con el $500 repetido. */
const RENDICIONES_JULIO: Rendicion[] = [
  {
    id: 'r1', fecha: '2026-07-12', responsable: 'Evelyn', monto_retirado: 883.14, notas: null,
    items: [
      { id: 'i1', fecha: '2026-07-08', concepto: 'META 08/07', monto: 450.00, plataforma: 'meta' },
      { id: 'i2', fecha: '2026-07-10', concepto: 'META 10/07', monto: 433.14, plataforma: 'meta' },
    ],
  },
  {
    id: 'r2', fecha: '2026-07-19', responsable: 'Evelyn', monto_retirado: 1220.00, notas: null,
    items: [
      { id: 'i3', fecha: '2026-07-06', concepto: 'UGLY 06/07', monto: 500.00, plataforma: 'otro' },
      { id: 'i4', fecha: '2026-07-15', concepto: 'META 15/07', monto: 720.00, plataforma: 'meta' },
    ],
  },
  {
    id: 'r3', fecha: '2026-07-23', responsable: 'Evelyn', monto_retirado: 1278.14, notas: null,
    items: [
      // ── Este ya se cobró en r2. Es el $500 duplicado. ──
      { id: 'i5', fecha: '2026-07-06', concepto: 'ugly  06/07', monto: 500.00, plataforma: 'otro' },
      { id: 'i6', fecha: '2026-07-20', concepto: 'META 20/07', monto: 731.35, plataforma: 'meta' },
      { id: 'i7', fecha: '2026-07-22', concepto: 'COMISION 3.8%', monto: 46.79, plataforma: 'otro' },
    ],
  },
];

describe('cruzarRendiciones — encontrar el cobro repetido', () => {
  const r = cruzarRendiciones(RENDICIONES_JULIO);

  it('detecta el $500 de UGLY cobrado dos veces, pese a estar escrito distinto', () => {
    // En r3 va como 'ugly  06/07' (minúsculas, doble espacio) y en r2 como
    // 'UGLY 06/07'. Es el mismo cargo y se tiene que ver.
    expect(r.cantidadDuplicados).toBe(1);
    expect(r.totalDuplicado).toBeCloseTo(500, 2);
  });

  it('marca la SEGUNDA aparición, nunca la primera', () => {
    const r3 = r.cruzadas.find((x) => x.id === 'r3')!;
    const r2 = r.cruzadas.find((x) => x.id === 'r2')!;
    expect(r2.duplicados).toHaveLength(0);           // el cobro legítimo
    expect(r3.duplicados).toHaveLength(1);           // el repetido
    expect(r3.duplicados[0].yaCobradoEn).toBe('2026-07-19');
    expect(r3.duplicados[0].yaCobradoEnId).toBe('r2');
  });

  it('el orden en que se carguen no cambia quién es el duplicado', () => {
    // Se ordena por fecha, no por orden de carga: si se carga primero la del 23
    // y después la del 19, la repetida sigue siendo la del 23.
    const alReves = cruzarRendiciones([...RENDICIONES_JULIO].reverse());
    const r3 = alReves.cruzadas.find((x) => x.id === 'r3')!;
    expect(r3.duplicados).toHaveLength(1);
    expect(r3.duplicados[0].yaCobradoEn).toBe('2026-07-19');
  });

  it('calcula lo que falta justificar en cada retiro', () => {
    const r1 = r.cruzadas.find((x) => x.id === 'r1')!;
    expect(r1.totalRendido).toBeCloseTo(883.14, 2);
    expect(r1.diferencia).toBeCloseTo(0, 2);          // cuadra exacto
  });

  it('los totales del período cierran', () => {
    expect(r.totalRetirado).toBeCloseTo(3381.28, 2);
    expect(r.totalRendido).toBeCloseTo(3381.28, 2);
  });

  it('mismo concepto pero OTRO monto no es duplicado', () => {
    // Dos cargos del mismo proveedor en fechas distintas son legítimos. Acusar
    // de repetido a un cargo real es peor que dejar pasar uno.
    const distintos: Rendicion[] = [
      { id: 'a', fecha: '2026-07-01', responsable: null, monto_retirado: 100, notas: null,
        items: [{ id: 'x', fecha: null, concepto: 'META', monto: 100, plataforma: 'meta' }] },
      { id: 'b', fecha: '2026-07-08', responsable: null, monto_retirado: 200, notas: null,
        items: [{ id: 'y', fecha: null, concepto: 'META', monto: 200, plataforma: 'meta' }] },
    ];
    expect(cruzarRendiciones(distintos).cantidadDuplicados).toBe(0);
  });

  it('sin rendiciones no rompe', () => {
    const vacio = cruzarRendiciones([]);
    expect(vacio.cruzadas).toEqual([]);
    expect(vacio.totalRetirado).toBe(0);
    expect(vacio.cantidadDuplicados).toBe(0);
  });
});

describe('normalizarConcepto', () => {
  it('iguala mayúsculas, acentos y espacios repetidos', () => {
    expect(normalizarConcepto('  ugly   06/07 ')).toBe('UGLY 06/07');
    expect(normalizarConcepto('Comisión')).toBe('COMISION');
  });
  it('NO borra los números — distinguen dos cargos reales del mismo proveedor', () => {
    expect(normalizarConcepto('META 08/07')).not.toBe(normalizarConcepto('META 10/07'));
  });
});

describe('mesesEntre', () => {
  it('cubre el rango incluyendo las dos puntas', () => {
    expect(mesesEntre('2026-05', '2026-07')).toEqual(['2026-05', '2026-06', '2026-07']);
  });
  it('cruza el cambio de año', () => {
    expect(mesesEntre('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
  it('un rango al revés o mal escrito devuelve vacío, no meses inventados', () => {
    expect(mesesEntre('2026-07', '2026-05')).toEqual([]);
    expect(mesesEntre('julio', '2026-05')).toEqual([]);
  });
});
