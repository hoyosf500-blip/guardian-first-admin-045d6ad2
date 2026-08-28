import { describe, it, expect } from 'vitest';
import { buildAdvisorVMs, sortByAttention, type BuildAdvisorsInput, type AdvisorRow, type AdvisorVM } from './advisorCardVM';
import type { AsesorScore } from './responsabilidadAsesor';
import { DEFAULT_SCHEDULE } from './inactivityWindow';

const row = (over: Partial<AdvisorRow> = {}): AdvisorRow => ({
  operator_id: 'a', display_name: 'Ana Pérez', confirmados: 0, cancelados: 0, noresp: 0,
  novedades_resueltas: 0, seg_acciones: 0, seg_resueltos: 0, rescate_acciones: 0,
  rescate_resueltos: 0, total_atendidos: 0, ...over,
});

const score = (over: Partial<AsesorScore> = {}): AsesorScore => ({
  operatorId: 'a', name: 'Ana Pérez', gestionados: 100, confirmados: 40, devoluciones: 4,
  evitables: 2, despachadosConSello: 20, despachadosEnRojo: 2, tasaDevolucion: 10,
  pctEnRojo: 10, nivelMeta: 'optimo', metaGestiones: 90, ...over,
});

const baseInput = (over: Partial<BuildAdvisorsInput> = {}): BuildAdvisorsInput => ({
  rows: [row()], workedByOp: new Map(), activityByOp: new Map(), inactivityByOp: new Map(),
  closingByOp: {}, closingError: false, mezcla: new Map(), scoresByOp: new Map(),
  liveByOp: new Map(), schedule: DEFAULT_SCHEDULE, nowMs: 1_700_000_000_000,
  entrantes: 0, isToday: true, confTarget: 85, ...over,
});

describe('buildAdvisorVMs — guardas de honestidad (nunca un 0 falso)', () => {
  it('sin datos medidos → todo en null y atención idle', () => {
    const [vm] = buildAdvisorVMs(baseInput());
    expect(vm.tasaDia).toBeNull();          // no atendió nada → no hay % que medir
    expect(vm.ritmoPorHora).toBeNull();     // sin horas trabajadas
    expect(vm.devoluciones).toBeNull();     // sin score → no medido, no 0
    expect(vm.detalle.tasaDevolucion).toBeNull();
    expect(vm.detalle.clientesHora).toBeNull();
    expect(vm.atencion).toBe('idle');
  });

  it('iniciales del nombre', () => {
    expect(buildAdvisorVMs(baseInput())[0].initials).toBe('AP');
  });

  it('% del día = confirmó ÷ trabajó, topado a 100', () => {
    const [vm] = buildAdvisorVMs(baseInput({ rows: [row({ confirmados: 37, cancelados: 4, noresp: 24, total_atendidos: 65 })] }));
    expect(vm.tasaDia).toBe(57);            // 37/65
    expect(vm.contestaron).toBe(41);        // 37+4
    expect(vm.noContesto).toBe(24);
    expect(vm.trabajo).toBe(65);
  });
});

describe('ritmo: el "19" viene con su conteo y su tiempo (no es 19 pedidos)', () => {
  const NOW = 1_700_000_000_000;
  const live = (over: Partial<import('./advisorCardVM').LiveLite> = {}): import('./advisorCardVM').LiveLite => ({
    estado: 'trabajando', ultimaAccion: 'confirmó', lastWorkMin: 1, enLinea: true,
    firstSignalMs: NOW - 5 * 3600 * 1000, hourly: [], total: 98, ...over,
  });

  it('hoy: expone las gestiones y los minutos que las produjeron', () => {
    const [vm] = buildAdvisorVMs(baseInput({
      nowMs: NOW, isToday: true,
      rows: [row({ confirmados: 60, cancelados: 8, noresp: 30, total_atendidos: 98 })],
      liveByOp: new Map([['a', live()]]),
    }));
    expect(vm.ritmoCount).toBe(98);          // el conteo real
    expect(vm.ritmoElapsedMin).toBe(300);    // 5 h desde la 1ª señal
    expect(vm.ritmoPorHora).toBeCloseTo(19.6, 1); // 98 ÷ 5 h = el RITMO, no "19 pedidos"
  });

  it('sin primera señal → ritmo sin medir, y el tiempo no se inventa', () => {
    const [vm] = buildAdvisorVMs(baseInput({
      nowMs: NOW, isToday: true,
      rows: [row({ confirmados: 3, total_atendidos: 3 })],
      liveByOp: new Map([['a', live({ firstSignalMs: null, total: 3 })]]),
    }));
    expect(vm.ritmoPorHora).toBeNull();
    expect(vm.ritmoElapsedMin).toBeNull();   // null, nunca un 0 que mienta
  });
});

describe('mostrar SIEMPRE a los asesores (roster): inactivos y apertura', () => {
  const NOW = 1_700_000_000_000;

  it('inactivo: sin actividad en el rango → días desde la última vez (no se esconde)', () => {
    const hace40dias = new Date(NOW - 40 * 86400000).toISOString();
    const [vm] = buildAdvisorVMs(baseInput({
      nowMs: NOW, isToday: true,
      rows: [row()],  // todo en cero
      rosterByOp: new Map([['a', { role: 'operator', lastActivityIso: hace40dias }]]),
    }));
    expect(vm.inactivoDias).toBe(40);
    expect(vm.ultimaVezIso).toBe(hace40dias);
    expect(vm.soloApertura).toBe(false);
    expect(vm.atencion).toBe('idle');
  });

  it('inactivo sin fecha conocida → días en null, nunca un 0 que mienta', () => {
    const [vm] = buildAdvisorVMs(baseInput({
      nowMs: NOW, isToday: true, rows: [row()],
      rosterByOp: new Map([['a', { role: 'operator', lastActivityIso: null }]]),
    }));
    expect(vm.inactivoDias).toBeNull();
    expect(vm.ultimaVezIso).toBeNull();
  });

  it('apertura: se activó hoy pero no marcó → soloApertura, NO inactivo', () => {
    const live = {
      estado: 'presente_sin_marcar' as const, ultimaAccion: null, lastWorkMin: null,
      enLinea: true, firstSignalMs: NOW - 3 * 3600 * 1000, hourly: [], total: 0,
    };
    const [vm] = buildAdvisorVMs(baseInput({
      nowMs: NOW, isToday: true, rows: [row()],
      liveByOp: new Map([['a', live]]),
      rosterByOp: new Map([['a', { role: 'operator', lastActivityIso: new Date(NOW - 2 * 86400000).toISOString() }]]),
    }));
    expect(vm.soloApertura).toBe(true);
    expect(vm.inactivoDias).toBeNull();   // presente hoy ⇒ no se cuenta como inactivo
    expect(vm.atencion).toBe('warn');     // presente pero sin marcar = a revisar
  });
});

describe('atención', () => {
  it('score rojo (lento) → atención bad + motivo en cristiano', () => {
    const s = score({ nivelMeta: 'lento' });
    const [vm] = buildAdvisorVMs(baseInput({
      rows: [row({ confirmados: 5, total_atendidos: 10 })],
      scoresByOp: new Map([['a', s]]),
    }));
    expect(vm.atencion).toBe('bad');
    expect(vm.motivos.join(' ')).toMatch(/lento/);
  });

  it('score verde + algo de trabajo → good', () => {
    const s = score({ nivelMeta: 'optimo', tasaDevolucion: 3, pctEnRojo: 5 });
    const [vm] = buildAdvisorVMs(baseInput({
      rows: [row({ confirmados: 30, total_atendidos: 34 })],
      scoresByOp: new Map([['a', s]]),
    }));
    expect(vm.atencion).toBe('good');
    expect(vm.motivos).toHaveLength(0);
  });
});

describe('sortByAttention', () => {
  it('bad → warn → good → idle; dentro de good por confirmados', () => {
    const mk = (id: string, atencion: AdvisorVM['atencion'], conf: number): AdvisorVM =>
      ({ operatorId: id, name: id, atencion, confirmados: conf } as AdvisorVM);
    const out = sortByAttention([
      mk('idle', 'idle', 0), mk('good1', 'good', 5), mk('bad', 'bad', 1),
      mk('good2', 'good', 20), mk('warn', 'warn', 3),
    ]);
    expect(out.map((v) => v.operatorId)).toEqual(['bad', 'warn', 'good2', 'good1', 'idle']);
  });
});

describe('carril — las cuatro cajas tienen que mostrar el trabajo que la persona hizo', () => {
  // Queja del dueño (28-ago-2026): "Roberto se ha dedicado a Seguimiento y la
  // tabla no bajó para nada ni se contó en productividad". Las cajas salían de
  // columnas que filtran module='confirmar', así que le mostraban 0 · 0 · 0.

  it('⛔ quien SOLO hizo Seguimiento NO cae en las cajas de Confirmar', () => {
    const [vm] = buildAdvisorVMs(baseInput({
      rows: [row({ seg_acciones: 51, seg_resueltos: 9, seg_pedidos: 46, seg_resueltos_dist: 8 })],
    }));
    expect(vm.carril).toBe('seguimiento');
    // Su trabajo tiene que estar visible en alguna parte del VM.
    expect(vm.detalle.segAcciones).toBe(51);
    expect(vm.segPedidos).toBe(46);
    // Y las cajas de Confirmar, que darían cero, NO son las suyas.
    expect(vm.trabajo).toBe(0);
    expect(vm.soloOtroTrabajo).toBe(true);
  });

  it('quien hizo los dos carriles los muestra ambos', () => {
    const [vm] = buildAdvisorVMs(baseInput({
      rows: [row({ confirmados: 30, cancelados: 5, noresp: 10, total_atendidos: 45, seg_acciones: 12 })],
    }));
    expect(vm.carril).toBe('ambos');
  });

  it('quien solo hizo Confirmar sigue como siempre', () => {
    const [vm] = buildAdvisorVMs(baseInput({
      rows: [row({ confirmados: 30, cancelados: 5, noresp: 10, total_atendidos: 45 })],
    }));
    expect(vm.carril).toBe('confirmar');
  });

  it('sin actividad cae en Confirmar: la tarjeta vacía se ve como siempre', () => {
    expect(buildAdvisorVMs(baseInput())[0].carril).toBe('ninguno');
  });

  it('⛔ solo RESCATE también es carril de Seguimiento (si no, vuelve a ver ceros)', () => {
    const [vm] = buildAdvisorVMs(baseInput({ rows: [row({ rescate_acciones: 7 })] }));
    expect(vm.carril).toBe('seguimiento');
    expect(vm.detalle.rescateAcciones).toBe(7);
  });

  it('sin la columna nueva de la RPC, "pedidos" queda en null → la UI pinta "—", nunca 0', () => {
    // Lovable no auto-aplica migraciones: la RPC desplegada puede no devolver
    // `seg_pedidos` todavía. Un 0 ahí sería una acusación inventada.
    const [vm] = buildAdvisorVMs(baseInput({ rows: [row({ seg_acciones: 20 })] }));
    expect(vm.segPedidos).toBeNull();
  });
});

describe('el aro grande también sigue al carril', () => {
  // "ya marca pero la barra no se mueve como Estefano" (dueño, 28-ago-2026):
  // el aro salía de tasaDia, que es confirmar-only, así que a Roberto le quedaba
  // vacío al lado de una tarjeta con 61 gestiones.

  it('Seguimiento: el aro muestra resueltos ÷ pedidos, no un "—"', () => {
    const [vm] = buildAdvisorVMs(baseInput({
      rows: [row({ seg_acciones: 61, seg_resueltos: 7, seg_pedidos: 43, seg_resueltos_dist: 7 })],
    }));
    expect(vm.anilloPct).toBe(16);            // 7/43
    expect(vm.anilloEtiqueta).toBe('resueltos');
  });

  it('Confirmar: el aro no cambia', () => {
    const [vm] = buildAdvisorVMs(baseInput({
      rows: [row({ confirmados: 37, cancelados: 4, noresp: 24, total_atendidos: 65 })],
    }));
    expect(vm.anilloPct).toBe(vm.tasaDia);
    expect(vm.anilloEtiqueta).toBe('del día');
  });

  it('sin nada que medir sigue en null → la tarjeta pinta "—"', () => {
    expect(buildAdvisorVMs(baseInput())[0].anilloPct).toBeNull();
  });
});
