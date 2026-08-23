import { describe, it, expect } from 'vitest';
import {
  summarizeCancelaciones,
  clasificarPerdida,
  bucketIntentos,
  nivelConfianza,
  mediana,
  percentil,
  tuvoGestion,
  diasHastaCancelar,
  horasAPrimerToque,
  EMPTY_RESUMEN,
  MIN_MUESTRA_OPERADORA,
  type CancelacionRow,
} from './cancelacionesResumen';

/** Fila con defaults sanos: gestionada, con motivo, de Guardian. */
function row(over: Partial<CancelacionRow> = {}): CancelacionRow {
  return {
    orderId: Math.random().toString(36).slice(2),
    externalId: '70001234',
    fecha: '2026-08-10',
    estado: 'CANCELADO',
    valor: 100_000,
    producto: 'Colágeno',
    ciudad: 'Bogotá',
    operatorId: 'op-1',
    operatorName: 'Ana',
    origen: 'guardian',
    motivo: 'Se arrepintió',
    canceladoAt: '2026-08-10T20:00:00-05:00',
    primerToqueAt: '2026-08-10T09:00:00-05:00',
    intentosPrevios: 1,
    intentosNoresp: 0,
    contactosPrevios: 0,
    reagendas: 0,
    ...over,
  };
}

describe('helpers numéricos', () => {
  it('mediana: impar toma el del medio, par promedia', () => {
    expect(mediana([5, 1, 3])).toBe(3);
    expect(mediana([1, 2, 3, 4])).toBe(2.5);
    expect(mediana([7])).toBe(7);
  });

  it('mediana de lista vacía es null, NO 0', () => {
    expect(mediana([])).toBeNull();
  });

  it('un outlier gigante no mueve la mediana (por eso no se usa promedio)', () => {
    expect(mediana([1, 2, 3, 4, 10_000])).toBe(3);
  });

  it('percentil 90 se va a la cola', () => {
    expect(percentil([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 90)).toBe(9);
    expect(percentil([], 90)).toBeNull();
  });

  it('nivelConfianza respeta los bordes exactos', () => {
    expect(nivelConfianza(0.7)).toBe('alta');
    expect(nivelConfianza(0.699)).toBe('media');
    expect(nivelConfianza(0.4)).toBe('media');
    expect(nivelConfianza(0.399)).toBe('baja');
    expect(nivelConfianza(0)).toBe('nula');
    expect(nivelConfianza(null)).toBe('nula');
  });
});

describe('cobertura del dato — el KPI cero', () => {
  it('sin filas devuelve el resumen vacío, con pct null y no 0', () => {
    const r = summarizeCancelaciones([]);
    expect(r.totalCancelados).toBe(0);
    expect(r.cobertura.pctConMotivo).toBeNull();
    expect(r.cobertura.nivel).toBe('nula');
  });

  it('null/undefined no rompen', () => {
    expect(summarizeCancelaciones(null).totalCancelados).toBe(0);
    expect(summarizeCancelaciones(undefined).totalCancelados).toBe(0);
  });

  it('separa el origen: 2 de guardian con motivo + 3 de Dropi sin motivo = 40%', () => {
    // La cobertura global baja NO siempre es indisciplina de la asesora. El
    // desglose por origen es la explicación, y cambia la acción por completo.
    const r = summarizeCancelaciones([
      row(), row(),
      row({ origen: 'externo', motivo: null, operatorId: null, operatorName: null }),
      row({ origen: 'externo', motivo: null, operatorId: null, operatorName: null }),
      row({ origen: 'externo', motivo: null, operatorId: null, operatorName: null }),
    ]);
    expect(r.cobertura.pctConMotivo).toBeCloseTo(0.4);
    expect(r.cobertura.porOrigen.find(o => o.origen === 'guardian')!.pctConMotivo).toBe(1);
    expect(r.cobertura.porOrigen.find(o => o.origen === 'externo')!.pctConMotivo).toBe(0);
  });

  it('la basura NO cuenta como motivo (si contara, la cobertura mentiría al alza)', () => {
    const r = summarizeCancelaciones([row({ motivo: '.' }), row({ motivo: 'x' }), row()]);
    expect(r.cobertura.conMotivo).toBe(1);
  });
});

describe('plata — la partición no puede perder pesos', () => {
  it('INVARIANTE: los 4 tipos suman el total, en unidades y en pesos', () => {
    const rows = [
      row({ valor: 100 }),
      row({ valor: 200, motivo: 'Duplicado' }),
      row({ valor: 300, intentosPrevios: 0, contactosPrevios: 0 }),
      row({ valor: 400, motivo: 'está de viaje' }),
      row({ valor: 500, motivo: 'blablablá que nadie mapeó' }),
      row({ valor: 600, origen: 'externo', motivo: null }),
    ];
    const { plata, totalCancelados, valorCancelado } = summarizeCancelaciones(rows);
    const n = plata.evitable.cancelados + plata.inevitable.cancelados
      + plata.ahorro.cancelados + plata.sinClasificar.cancelados;
    const v = plata.evitable.valor + plata.inevitable.valor
      + plata.ahorro.valor + plata.sinClasificar.valor;
    expect(n).toBe(totalCancelados);
    expect(v).toBe(valorCancelado);
  });

  it('un valor null suma 0, no NaN', () => {
    const r = summarizeCancelaciones([row({ valor: null }), row({ valor: 50 })]);
    expect(r.valorCancelado).toBe(50);
    expect(Number.isNaN(r.plata.evitable.valor)).toBe(false);
  });

  it('PRECEDENCIA 1: una cancelación sana es AHORRO aunque nadie la llamara', () => {
    // No había a quién llamar: es un duplicado.
    const { tipo } = clasificarPerdida(row({ motivo: 'Duplicado', intentosPrevios: 0, contactosPrevios: 0 }));
    expect(tipo).toBe('ahorro');
  });

  it('PRECEDENCIA 2: sin gestión es EVITABLE aunque el motivo culpe al cliente', () => {
    // La regla discutible, sostenida a propósito: nadie verificó ese motivo.
    const c = clasificarPerdida(row({ motivo: 'Se arrepintió', intentosPrevios: 0, contactosPrevios: 0 }));
    expect(c.tipo).toBe('evitable');
    expect(c.motivo).toBe('sin_gestion');
  });

  it('un contacto por WhatsApp cuenta como gestión', () => {
    expect(tuvoGestion(row({ intentosPrevios: 0, contactosPrevios: 2 }))).toBe(true);
    expect(tuvoGestion(row({ intentosPrevios: 0, contactosPrevios: 0 }))).toBe(false);
  });

  it('gestionado pero sin motivo clasificable NO se culpa a nadie: sin_clasificar', () => {
    const c = clasificarPerdida(row({ motivo: 'texto rarísimo sin regla', intentosPrevios: 2 }));
    expect(c.tipo).toBe('sin_clasificar');
  });

  it('cuenta aparte cuántas evitables lo son SOLO porque nadie llamó', () => {
    const r = summarizeCancelaciones([
      row({ valor: 10, intentosPrevios: 0, contactosPrevios: 0 }),
      row({ valor: 20, intentosPrevios: 0, contactosPrevios: 0 }),
      row({ valor: 30, motivo: 'muy caro', intentosPrevios: 3 }),
    ]);
    expect(r.plata.evitable.cancelados).toBe(3);
    expect(r.plata.evitablesPorSinGestion).toBe(2);
    expect(r.plata.valorEvitablePorSinGestion).toBe(30);
  });

  it('el ahorro NO entra en perdidoBruto', () => {
    const r = summarizeCancelaciones([
      row({ valor: 100, motivo: 'muy caro', intentosPrevios: 1 }),
      row({ valor: 900, motivo: 'Duplicado', intentosPrevios: 1 }),
    ]);
    expect(r.plata.perdidoBruto).toBe(100);
    expect(r.plata.ahorro.valor).toBe(900);
  });
});

describe('top motivos — el denominador que decide si el reporte sirve', () => {
  it('EL TEST CLAVE: se calcula sobre los que TIENEN motivo, no sobre el total', () => {
    // 10 filas, 5 con motivo, 3 de ellas "precio" → 60%, no 30%.
    const rows = [
      ...Array.from({ length: 3 }, () => row({ motivo: 'muy caro' })),
      row({ motivo: 'Duplicado' }),
      row({ motivo: 'está de viaje' }),
      ...Array.from({ length: 5 }, () => row({ origen: 'externo' as const, motivo: null })),
    ];
    const r = summarizeCancelaciones(rows);
    expect(r.cobertura.conMotivo).toBe(5);
    const precio = r.topMotivos.find(m => m.categoria === 'precio_flete')!;
    expect(precio.cancelados).toBe(3);
    expect(precio.pctSobreConMotivo).toBeCloseTo(0.6);
  });

  it('guarda hasta 3 ejemplos crudos, deduplicados pero con la grafía original', () => {
    const r = summarizeCancelaciones([
      row({ motivo: 'MUY CARO' }), row({ motivo: 'muy caro' }),
      row({ motivo: 'le pareció caro' }), row({ motivo: 'está caro el flete' }),
      row({ motivo: 'caro caro caro' }),
    ]);
    const m = r.topMotivos.find(x => x.categoria === 'precio_flete')!;
    expect(m.ejemplos.length).toBeLessThanOrEqual(3);
    expect(m.ejemplos).toContain('MUY CARO');
  });

  it('los textos sin clasificar quedan listados: son la próxima iteración', () => {
    const r = summarizeCancelaciones([
      row({ motivo: 'se le chispoteó' }),
      row({ motivo: 'se le chispoteó' }),
      row({ motivo: 'muy caro' }),
    ]);
    expect(r.motivosCrudos[0].texto).toBe('se le chispoteó');
    expect(r.motivosCrudos[0].veces).toBe(2);
    expect(r.motivosCrudos.some(m => m.texto === 'muy caro')).toBe(false);
  });

  it('el orden es determinista ante empates', () => {
    const rows = [row({ motivo: 'muy caro', valor: 1 }), row({ motivo: 'está de viaje', valor: 1 })];
    const a = summarizeCancelaciones(rows).topMotivos.map(m => m.categoria);
    const b = summarizeCancelaciones([...rows].reverse()).topMotivos.map(m => m.categoria);
    expect(a).toEqual(b);
  });
});

describe('por culpa — el dato faltante ocupa su tamaño real', () => {
  it('incluye la fila genérica y todas suman el total', () => {
    // Un gráfico de culpas que solo muestra las conocidas cuando el 50% no tiene
    // motivo es un gráfico que miente por omisión.
    const r = summarizeCancelaciones([
      row({ motivo: 'muy caro' }),
      row({ origen: 'externo', motivo: null }),
      row({ origen: 'externo', motivo: null }),
    ]);
    expect(r.porCulpa.find(c => c.culpa === 'generica')!.cancelados).toBe(2);
    expect(r.porCulpa.reduce((s, c) => s + c.cancelados, 0)).toBe(3);
  });
});

describe('gestión — la sección incómoda', () => {
  it('bucketIntentos agrupa bien y 3+ absorbe la cola', () => {
    expect(bucketIntentos(row({ intentosPrevios: 0 }))).toBe('0');
    expect(bucketIntentos(row({ intentosPrevios: 1 }))).toBe('1');
    expect(bucketIntentos(row({ intentosPrevios: 2 }))).toBe('2');
    expect(bucketIntentos(row({ intentosPrevios: 9 }))).toBe('3+');
  });

  it('la distribución de intentos suma el total', () => {
    const rows = [0, 0, 1, 2, 5, 7].map(n => row({ intentosPrevios: n }));
    const r = summarizeCancelaciones(rows);
    expect(r.gestion.distribucionIntentos.reduce((s, b) => s + b.cancelados, 0)).toBe(6);
    expect(r.gestion.distribucionIntentos.find(b => b.bucket === '0')!.cancelados).toBe(2);
    expect(r.gestion.distribucionIntentos.find(b => b.bucket === '3+')!.cancelados).toBe(2);
  });

  it('el titular: cancelados sin una sola llamada, con su plata', () => {
    const r = summarizeCancelaciones([
      row({ valor: 1000, intentosPrevios: 0, contactosPrevios: 0 }),
      row({ valor: 2000, intentosPrevios: 0, contactosPrevios: 0 }),
      row({ valor: 5000, intentosPrevios: 2 }),
    ]);
    expect(r.gestion.sinGestion).toBe(2);
    expect(r.gestion.sinGestionValor).toBe(3000);
    expect(r.gestion.pctSinGestion).toBeCloseTo(2 / 3);
  });

  it('el tiempo al primer toque expone su `n`: nunca una mediana suelta', () => {
    const r = summarizeCancelaciones([
      row({ primerToqueAt: '2026-08-10T02:00:00-05:00' }),   // 2 h
      row({ primerToqueAt: '2026-08-10T06:00:00-05:00' }),   // 6 h
      row({ primerToqueAt: null }),
    ]);
    expect(r.gestion.ttfcMedianaHoras).toBe(4);
    expect(r.gestion.ttfcMedidos).toBe(2);
    expect(r.gestion.ttfcNunca).toBe(1);
  });

  it('un primer toque anterior al pedido se clampa a 0 en vez de descartarse', () => {
    // El pedido SÍ se tocó; tirar la fila movería la mediana.
    expect(horasAPrimerToque(row({ fecha: '2026-08-10', primerToqueAt: '2026-08-09T10:00:00-05:00' }))).toBe(0);
  });

  it('cuenta las reagendas quemadas', () => {
    const r = summarizeCancelaciones([row({ reagendas: 2 }), row({ reagendas: 0 })]);
    expect(r.gestion.reagendasQuemadas).toBe(1);
  });
});

describe('por operadora — no rankear por volumen de trabajo', () => {
  it('ordena por sin-gestión, no por cantidad de cancelaciones', () => {
    // La que más pedidos atiende siempre cancela más; eso no dice nada.
    const rows = [
      ...Array.from({ length: 10 }, () => row({ operatorId: 'a', operatorName: 'Ana', intentosPrevios: 3 })),
      ...Array.from({ length: 3 }, () => row({ operatorId: 'b', operatorName: 'Bea', intentosPrevios: 0, contactosPrevios: 0 })),
    ];
    const r = summarizeCancelaciones(rows);
    expect(r.porOperadora[0].name).toBe('Bea');
  });

  it('el bucket sin operadora agrupa lo cancelado en Dropi', () => {
    const r = summarizeCancelaciones([
      row({ origen: 'externo', motivo: null, operatorId: null, operatorName: null }),
      row({ origen: 'externo', motivo: null, operatorId: null, operatorName: null }),
    ]);
    expect(r.porOperadora).toHaveLength(1);
    expect(r.porOperadora[0].operatorId).toBeNull();
  });

  it('marca la muestra insuficiente para que la UI no pinte rojo con 2 datos', () => {
    const pocas = summarizeCancelaciones(Array.from({ length: MIN_MUESTRA_OPERADORA - 1 }, () => row()));
    expect(pocas.porOperadora[0].muestraSuficiente).toBe(false);
    const suficientes = summarizeCancelaciones(Array.from({ length: MIN_MUESTRA_OPERADORA }, () => row()));
    expect(suficientes.porOperadora[0].muestraSuficiente).toBe(true);
  });
});

describe('producto y ciudad', () => {
  it('los sin dato NO se descartan: van a "(sin dato)"', () => {
    const r = summarizeCancelaciones([row({ producto: null }), row({ producto: '  ' })]);
    expect(r.porProducto[0].key).toBe('(sin dato)');
    expect(r.porProducto[0].cancelados).toBe(2);
  });

  it('el motivo dominante es lo que convierte un ranking en una acción', () => {
    const r = summarizeCancelaciones([
      row({ ciudad: 'Cali', motivo: 'muy caro' }),
      row({ ciudad: 'Cali', motivo: 'muy caro' }),
      row({ ciudad: 'Cali', motivo: 'está de viaje' }),
    ]);
    expect(r.porCiudad[0].topMotivo).toBe('precio_flete');
    expect(r.porCiudad[0].topMotivoCancelados).toBe(2);
  });

  it('sin ningún motivo, topMotivo es null (no se inventa "otro")', () => {
    const r = summarizeCancelaciones([row({ ciudad: 'Cali', origen: 'externo', motivo: null })]);
    expect(r.porCiudad[0].topMotivo).toBeNull();
  });

  // GUARDIANA (auditoría 20-ago-2026): "GOTAS RELAX", "Gotas  Relax" y
  // "gotas relax" son EL MISMO producto. Partido en tres filas, el ranking
  // "cuál se cancela más" corona al producto equivocado.
  it('mayúsculas, tildes y espacios dobles NO parten un producto en dos filas', () => {
    const r = summarizeCancelaciones([
      row({ producto: 'GOTAS RELAX' }),
      row({ producto: 'Gotas  Relax' }),
      row({ producto: 'gotas relax' }),
      row({ producto: 'Otro Producto' }),
    ]);
    expect(r.porProducto).toHaveLength(2);
    expect(r.porProducto[0].cancelados).toBe(3);
    // La etiqueta visible conserva la PRIMERA grafía vista, no el upper plano.
    expect(r.porProducto[0].key).toBe('GOTAS RELAX');
  });

  it('la ciudad tipeada por el cliente agrupa igual: "BOGOTA" y "Bogotá" son una', () => {
    const r = summarizeCancelaciones([
      row({ ciudad: 'BOGOTA' }),
      row({ ciudad: 'Bogotá' }),
    ]);
    expect(r.porCiudad).toHaveLength(1);
    expect(r.porCiudad[0].cancelados).toBe(2);
  });
});

describe('antigüedad', () => {
  it('cancelar el mismo día es fresco, no arrastre (trampa de zona horaria)', () => {
    // 8 pm del MISMO día = 0 días. Si esto diera 1, la métrica mentiría en la
    // mitad de las filas.
    expect(diasHastaCancelar(row({ fecha: '2026-08-10', canceladoAt: '2026-08-10T20:00:00-05:00' }))).toBe(0);
  });

  it('separa frescos de arrastre y no contamina la mediana con los sin fecha', () => {
    const r = summarizeCancelaciones([
      row({ fecha: '2026-08-10', canceladoAt: '2026-08-10T20:00:00-05:00', valor: 10 }),
      row({ fecha: '2026-08-10', canceladoAt: '2026-08-19T10:00:00-05:00', valor: 90 }),
      row({ fecha: null, canceladoAt: null }),
    ]);
    expect(r.antiguedad.frescos).toBe(1);
    expect(r.antiguedad.arrastre).toBe(1);
    expect(r.antiguedad.sinFecha).toBe(1);
    expect(r.antiguedad.valorArrastre).toBe(90);
  });
});

describe('tasa de cancelación — un solo denominador, y si no cierra no se imprime', () => {
  it('sin `generados` la tasa es null, jamás derivada de las filas', () => {
    expect(summarizeCancelaciones([row(), row()]).tasaCancelacion).toBeNull();
  });

  it('con generados calcula cancelados ÷ generados', () => {
    const r = summarizeCancelaciones([row(), row()], { generados: 10, totalPeriodo: 2 });
    expect(r.tasaCancelacion).toBeCloseTo(0.2);
  });

  it('usa el total del PERÍODO, no la muestra, cuando vino truncado', () => {
    const r = summarizeCancelaciones([row(), row()], { generados: 100, totalPeriodo: 40 });
    expect(r.truncado).toBe(true);
    expect(r.tasaCancelacion).toBeCloseTo(0.4);
  });

  it('generados < cancelados marca incoherencia y NO imprime un 340%', () => {
    const r = summarizeCancelaciones([row(), row()], { generados: 1, totalPeriodo: 2 });
    expect(r.universoInconsistente).toBe(true);
    expect(r.tasaCancelacion).toBeNull();
  });

  it('generados 0 no produce Infinity', () => {
    const r = summarizeCancelaciones([row()], { generados: 0, totalPeriodo: 1 });
    expect(r.tasaCancelacion).toBeNull();
  });
});

describe('pureza y contrato', () => {
  it('dos llamadas con el mismo input dan el mismo resultado', () => {
    const rows = [row({ motivo: 'muy caro' }), row({ motivo: 'Duplicado' })];
    expect(summarizeCancelaciones(rows)).toEqual(summarizeCancelaciones(rows));
  });

  it('no muta las filas de entrada', () => {
    const rows = [row({ valor: 5 })];
    const snap = JSON.stringify(rows);
    summarizeCancelaciones(rows);
    expect(JSON.stringify(rows)).toBe(snap);
  });

  it('EMPTY_RESUMEN tiene tasas en null, no en cero', () => {
    expect(EMPTY_RESUMEN.tasaCancelacion).toBeNull();
    expect(EMPTY_RESUMEN.cobertura.pctConMotivo).toBeNull();
    expect(EMPTY_RESUMEN.gestion.ttfcMedianaHoras).toBeNull();
  });
});

describe('REGRESIÓN: la auditoría real de julio en Ecuador', () => {
  // 345 cancelados, 68 sin ninguna gestión registrada. Si algún día el
  // resumidor deja de poder reproducir esos números, se rompió algo.
  it('reproduce 345 cancelados con 68 sin gestión', () => {
    const rows = [
      ...Array.from({ length: 68 }, () => row({ valor: 50_000, intentosPrevios: 0, contactosPrevios: 0 })),
      ...Array.from({ length: 277 }, () => row({ valor: 50_000, intentosPrevios: 2 })),
    ];
    const r = summarizeCancelaciones(rows, { generados: 1200, totalPeriodo: 345 });
    expect(r.totalCancelados).toBe(345);
    expect(r.gestion.sinGestion).toBe(68);
    expect(r.plata.evitablesPorSinGestion).toBe(68);
    expect(r.plata.valorEvitablePorSinGestion).toBe(68 * 50_000);
    expect(r.tasaCancelacion).toBeCloseTo(345 / 1200);
  });
});

// ── GUARDIÁN ──────────────────────────────────────────────────────────
// Un pedido que se RECREÓ no se perdió: se rehizo con otro `external_id`.
// Contarlo como cancelación cuenta la misma venta dos veces — una como
// perdida y otra como nueva.
//
// `cuentaEnTasa` existía en la taxonomía desde el 15-ago-2026 y **no lo leía
// nadie**: era documentación ejecutable sin ejecutor. Medido en agosto-EC:
// 19 pedidos, ~1,6 puntos de tasa que no eran pérdidas de nadie.
describe('GUARDIÁN: los recreados no inflan la tasa', () => {
  const cambioTrans = 'Cambio de transportadora — se recreó el pedido';
  const edicion = 'Recreado por edición del pedido';

  it('cuenta los recreados aparte y los descuenta de la tasa real', () => {
    const r = summarizeCancelaciones(
      [
        row({ motivo: cambioTrans, valor: 50_000 }),
        row({ motivo: edicion, valor: 30_000 }),
        row({ motivo: 'Se arrepintió' }),
        row({ motivo: 'No contesta' }),
      ],
      { generados: 100, totalPeriodo: 4 },
    );
    expect(r.recreados).toBe(2);
    expect(r.valorRecreados).toBe(80_000);
    expect(r.tasaCancelacion).toBeCloseTo(0.04);      // lo que se ve hoy
    expect(r.tasaCancelacionReal).toBeCloseTo(0.02);  // sin los recreados
  });

  it('sin recreados, las dos tasas coinciden', () => {
    const r = summarizeCancelaciones(
      [row({ motivo: 'Se arrepintió' }), row({ motivo: 'No contesta' })],
      { generados: 50, totalPeriodo: 2 },
    );
    expect(r.recreados).toBe(0);
    expect(r.tasaCancelacionReal).toBe(r.tasaCancelacion);
  });

  it('con la consulta truncada NO se publica la tasa real', () => {
    // `recreados` sale de las filas cargadas y `totalPeriodo` del período
    // entero: restar una cuenta parcial de un total completo da un número
    // peor que no dar ninguno.
    const r = summarizeCancelaciones(
      [row({ motivo: cambioTrans })],
      { generados: 100, totalPeriodo: 40 },
    );
    expect(r.truncado).toBe(true);
    expect(r.tasaCancelacion).not.toBeNull();
    expect(r.tasaCancelacionReal).toBeNull();
  });

  it('sin denominador tampoco se inventa', () => {
    const r = summarizeCancelaciones([row({ motivo: cambioTrans })], {});
    expect(r.tasaCancelacion).toBeNull();
    expect(r.tasaCancelacionReal).toBeNull();
    expect(r.recreados).toBe(1);
  });

  it('un recreado NO es pérdida — pero tampoco es "ahorro"', () => {
    // Antes caía en el bucket `ahorro`, cuya tarjeta dice "estuvo bien
    // cancelar" y cuyo pie nombra "duplicados / mal historial". Un pedido
    // rehecho no evitó ninguna devolución: no ahorró nada. Ahora tiene bucket
    // propio y el de ahorro vuelve a nombrar solo a su población.
    const r = summarizeCancelaciones([row({ motivo: cambioTrans })], { generados: 10, totalPeriodo: 1 });
    expect(r.plata.recreado.cancelados).toBe(1);
    expect(r.plata.ahorro.cancelados).toBe(0);
    expect(r.plata.perdidoBruto).toBe(0);
  });

  it('un recreado NO engorda la barra "Nosotros" de la portada', () => {
    // Lleva `culpa:'operacion'` (es la operación la que rehace el pedido), así
    // que sin filtrar se sumaba a la culpa que manda a revisar la cola de
    // Confirmar — por pedidos que no son falla de nadie.
    const r = summarizeCancelaciones([row({ motivo: cambioTrans })], { generados: 10, totalPeriodo: 1 });
    expect(r.porCulpa.find(c => c.culpa === 'operacion')).toBeUndefined();
  });

  it('un recreado tampoco compite en el top de motivos', () => {
    const r = summarizeCancelaciones([row({ motivo: cambioTrans })], { generados: 10, totalPeriodo: 1 });
    expect(r.topMotivos.some(m => m.categoria === 'cambio_transportadora')).toBe(false);
  });
});

describe('el motivo dominante por ciudad/producto no nombra lo que el resto excluye', () => {
  // Medido en pantalla el 22-ago-2026: Quito salia como "32 cancelaciones ·
  // Pedido rehecho" cuando en TODO el periodo hubo 19 rehechos. El motivo
  // dominante se calculaba sobre las filas clasificadas y se leia como si
  // describiera las 32 — nombrando ademas una categoria que el desglose global
  // de motivos excluye a proposito.
  const fila = (over) => ({
    orderId: `o${Math.random()}`, externalId: null, fecha: '2026-08-10', estado: 'CANCELADO',
    valor: 100, producto: 'P', ciudad: 'QUITO', operatorId: null, operatorName: null,
    origen: 'guardian', motivo: null, canceladoAt: null, primerToqueAt: null,
    intentosPrevios: 0, intentosNoresp: 0, contactosPrevios: 0, reagendas: 0,
    ...over,
  });

  it('un pedido rehecho NO puede ser el motivo dominante de una ciudad', () => {
    const r = summarizeCancelaciones([
      fila({ recreado: true }),
      fila({ recreado: true }),
      fila({ motivo: 'se arrepintio' }),
    ], { generados: 100, totalPeriodo: 3 });
    const quito = r.porCiudad.find(c => c.key === 'QUITO');
    expect(quito?.cancelados).toBe(3);
    expect(quito?.topMotivo).not.toBe('cambio_transportadora');
    expect(quito?.topMotivo).toBe('arrepentido');
  });

  it('si TODO lo clasificado son rehechos, la ciudad queda sin motivo dominante', () => {
    // Mejor sin motivo que con uno que el resto de la pantalla no cuenta.
    const r = summarizeCancelaciones(
      [fila({ recreado: true }), fila({ recreado: true })],
      { generados: 100, totalPeriodo: 2 },
    );
    const quito = r.porCiudad.find(c => c.key === 'QUITO');
    expect(quito?.cancelados).toBe(2);
    expect(quito?.topMotivo).toBeNull();
  });
});

describe('cobertura: "motivo anotado" tiene que ser texto que alguien escribió', () => {
  // Auditoría 23-ago-2026. La cobertura se calculaba desde la CATEGORÍA
  // (`!== 'sin_motivo' && !== 'externo_dropi'`), y dos categorías llegan sin que
  // nadie haya escrito nada: `sin_whatsapp` (sale de `chat_riesgo`, señal
  // automática) y `recreado_externo` (sale de detectar que el pedido se rehizo).
  // Las dos inflaban el % de la portada y le regalaban disciplina de registro a
  // una operadora que no anotó una línea.
  it('un cancelado que nunca escribió por WhatsApp NO cuenta como motivo anotado', () => {
    const r = summarizeCancelaciones([
      row({ motivo: null, riesgoChat: 'mudo' }),
      row({ motivo: null, riesgoChat: 'mudo' }),
      row({ motivo: 'Precio muy alto' }),
    ]);
    expect(r.cobertura.total).toBe(3);
    expect(r.cobertura.conMotivo).toBe(1);
    expect(r.cobertura.sinMotivo).toBe(2);
  });

  it('un pedido recreado sin motivo escrito tampoco cuenta', () => {
    const r = summarizeCancelaciones([
      row({ motivo: null, recreado: true }),
      row({ motivo: 'Se arrepintió' }),
    ]);
    expect(r.cobertura.conMotivo).toBe(1);
  });

  it('la operadora no recibe disciplina de registro por una señal automática', () => {
    const r = summarizeCancelaciones([
      row({ operatorId: 'op-9', operatorName: 'Sol', motivo: null, riesgoChat: 'mudo' }),
      row({ operatorId: 'op-9', operatorName: 'Sol', motivo: null, riesgoChat: 'mudo' }),
    ]);
    const sol = r.porOperadora.find(o => o.operatorId === 'op-9');
    expect(sol?.cancelados).toBe(2);
    expect(sol?.conMotivo).toBe(0);
  });

  it('sigue contando igual lo que la asesora SÍ escribió', () => {
    const r = summarizeCancelaciones([
      row({ motivo: 'No tiene la plata' }),
      row({ motivo: 'Pidió otro color' }),
      row({ origen: 'externo', motivo: null }),
    ]);
    expect(r.cobertura.conMotivo).toBe(2);
  });
});
