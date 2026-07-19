import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  ClipboardList, Download, Loader2, Users, AlertTriangle, CalendarRange,
  Inbox, CheckCircle2, XCircle, PhoneOff, Clock, Activity,
} from 'lucide-react';
import { motion } from 'framer-motion';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ResponsiveContainer,
} from 'recharts';
import PresetDateRangePicker from '@/components/PresetDateRangePicker';
import { confRateByCohort, CONF_DIA_TARGET_PCT } from '@/lib/confirmationRate';
import CancelledReasonsModal from '@/components/admin/CancelledReasonsModal';
import { TiltCard, StatTile, GaugeRing } from '@/components/ui3d';
import {
  CHART_TOOLTIP_STYLE, CHART_GRID_PROPS, CHART_BAR_CURSOR, fmtDay,
} from '@/components/logistics/charts/chartTokens';

const hsl = (v: string) => `hsl(var(${v}))`;
const C_SUCCESS = hsl('--success');
const C_DANGER = hsl('--danger');
const C_WARNING = hsl('--warning');
const C_MUTED = hsl('--muted-foreground');
const C_ACCENT = hsl('--accent');
const C_CYAN = hsl('--cyan');
const C_BG = hsl('--background');

/** Glow del trazo: 8px líneas/áreas, 6px barras. Es la firma del DS. */
const lineGlow = (color: string) => ({ filter: `drop-shadow(0 0 8px ${color})` });

/** Entrada escalonada: la pantalla se arma de arriba abajo. */
const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

/** Degradado vertical por serie. Los ids de `<defs>` son GLOBALES al documento
 *  → `prefix` obligatorio para no pisar los de otra card de la pantalla. */
function BarGradientDefs({ prefix, entries }: { prefix: string; entries: { slug: string; color: string }[] }) {
  return (
    <>
      {entries.map(e => (
        <linearGradient key={e.slug} id={`${prefix}-${e.slug}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={e.color} stopOpacity={0.95} />
          <stop offset="100%" stopColor={e.color} stopOpacity={0.5} />
        </linearGradient>
      ))}
    </>
  );
}

/** Leyenda manual: swatch CUADRADO de 10px (nunca círculo). */
function SwatchLegend({ items, className = '' }: { items: { color: string; label: string }[]; className?: string }) {
  return (
    <div className={`flex items-center gap-3 flex-wrap ${className}`}>
      {items.map(l => (
        <span key={l.label} className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: l.color }} aria-hidden="true" />
          {l.label}
        </span>
      ))}
    </div>
  );
}

/** Series apiladas del día — el orden ES el embudo, de abajo hacia arriba. */
const DAY_STACK = [
  { key: 'Confirmados', slug: 'conf', color: C_SUCCESS },
  { key: 'Cancelados', slug: 'canc', color: C_DANGER },
  { key: 'No Respondió', slug: 'noresp', color: C_MUTED },
  { key: 'Pendientes', slug: 'pend', color: C_WARNING },
] as const;

// Panel de "Reportes diarios" con DOS vistas:
//
//   1. Vista por día (cohort): 1 fila por fecha con métrica de negocio.
//      Pedidos creados ese día y cómo terminaron. % siempre ≤ 100%.
//      Fuente: admin_daily_reports_range (migration 20260505230000).
//
//   2. Detalle apertura/cierre por operadora: filas por operadora con
//      lo que reportó al abrir/cerrar turno + notas.
//      Fuente: admin_operator_shifts_range (migration 20260505240000).
//
// Ambas vistas comparten el rango de fechas (Desde/Hasta) y se cargan
// en paralelo con un solo Promise.all.

interface DayRow {
  fecha: string;
  entrantes: number;
  confirmados: number;
  cancelados: number;
  noresp: number;
  pendientes: number;
  pct_confirmacion: number;
  pct_cancelados: number;
}

interface ShiftRow {
  fecha: string;
  tipo: 'apertura' | 'cierre';
  operadora: string;
  hora: string | null;
  pedidos_nuevos: number | null;
  guias_apertura: number | null;
  pendientes_ayer: number | null;
  confirmados: number | null;
  noresp: number | null;
  cancelados: number | null;
  total_gestionados: number | null;
  pendientes_manana: number | null;
  notas: string | null;
}

interface ActionRow {
  fecha: string;
  operadora: string;
  conf: number;
  canc: number;
  noresp: number;
  atendidos: number;
}

function isoDate(d: Date) { return d.toISOString().split('T')[0]; }

interface DayMetrics {
  resueltos: number;        // confirmados + cancelados
  pctProcesado: number;     // (conf + canc) ÷ entrantes — qué tan trabajado está el día
  // Tasas del DÍA sobre lo que ENTRÓ (÷inflow) — así %PROC = %CONF + %CANC y todo
  // reconcilia sobre el mismo denominador (decisión del dueño 2026-07-03: no inflar).
  tasaConfDia: number | null;  // conf ÷ entrantes — "confirmación del día", meta ~55%
  tasaCancDia: number | null;  // canc ÷ entrantes
  // Efectividad de cierre (÷resueltos) — se muestra en el tooltip, meta 85%.
  tasaConf: number | null;  // conf ÷ (conf + canc)
  tasaCanc: number | null;  // canc ÷ (conf + canc)
  inmaduro: boolean;        // pctProcesado < umbral → no concluyente
}

// Delegamos en la fuente ÚNICA de la tasa (src/lib/confirmationRate.ts) para que
// la fórmula no vuelva a divergir entre pantallas.
function deriveDayMetrics(conf: number, canc: number, entrantes: number): DayMetrics {
  const r = confRateByCohort(conf, canc, entrantes);
  return {
    resueltos: r.resueltos,
    pctProcesado: r.pctProcesado,
    tasaConfDia: r.tasaDia,                                        // conf ÷ entrantes
    tasaCancDia: entrantes > 0 ? Math.round((Math.max(0, canc) / entrantes) * 100) : null, // canc ÷ entrantes
    tasaConf: r.tasa,                                             // conf ÷ resueltos (efectividad)
    tasaCanc: r.tasaCanc,                                         // canc ÷ resueltos
    inmaduro: r.inmaduro,
  };
}

export default function DailyReportsView() {
  const today = useMemo(() => new Date(), []);
  const sevenAgo = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 6); return d; }, []);

  const [from, setFrom] = useState(isoDate(sevenAgo));
  const [to, setTo] = useState(isoDate(today));
  const [days, setDays] = useState<DayRow[]>([]);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Popup de motivos de cancelación (celda "Cancelados" clickeable).
  const [cancelDetail, setCancelDetail] = useState<{ operadora: string; fecha: string } | null>(null);
  // errMsg expone errores de RPC en pantalla. Antes solo iban a console.error
  // → el usuario veía "0 filas" sin pista de la causa real (Solo admins,
  // function does not exist, signature mismatch, etc.). Surface inline.
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErrMsg(null);
    // .bind(supabase) es OBLIGATORIO: si solo hacés `const rpc = supabase.rpc`
    // se pierde el `this` y al invocarse el método tira
    // `Cannot read properties of undefined (reading 'rest')` desde dentro de
    // supabase-js. El cast `as unknown as` solo cambia tipos, no preserva
    // el binding — por eso bindeamos primero y casteamos después.
    const rpc = supabase.rpc.bind(supabase) as unknown as (
      fn: string, args: Record<string, unknown>
    ) => Promise<{ data: Array<Record<string, unknown>> | null; error: { message?: string } | null }>;

    // Defensive: si una RPC throwea (red caída, función no existe en
    // un caso que rompe la promise en vez de resolver con error), el
    // try/finally garantiza que el spinner termina y la UI no queda
    // colgada. Sin esto, si admin_operator_shifts_range falla con un
    // throw (no un error response), setLoading(false) nunca corría.
    try {
      // Promise.resolve(...) es OBLIGATORIO: supabase.rpc() devuelve un
      // PostgrestFilterBuilder (thenable con .then) pero NO una Promise
      // nativa — no tiene .catch. Sin el wrap, llamar .catch directo tira
      // "TypeError: r(...).catch is not a function". Promise.resolve adopta
      // cualquier thenable y devuelve una Promise real con .catch.
      // El scope por tienda lo resuelve cada RPC server-side vía
      // _resolve_scope_store() (admin → su tienda activa). No pasamos p_store_id
      // para no depender de que la migration del parámetro esté aplicada.
      const [daysRes, shiftsRes, actionsRes] = await Promise.all([
        Promise.resolve(rpc('admin_daily_reports_range', { p_from: from, p_to: to })).catch(
          (err: unknown) => ({ data: null, error: { message: String(err) } } as const)
        ),
        Promise.resolve(rpc('admin_operator_shifts_range', { p_from: from, p_to: to })).catch(
          (err: unknown) => ({ data: null, error: { message: String(err) } } as const)
        ),
        Promise.resolve(rpc('admin_operator_actions_per_day', { p_from: from, p_to: to })).catch(
          (err: unknown) => ({ data: null, error: { message: String(err) } } as const)
        ),
      ]);

      if (daysRes.error) {
        const msg = `admin_daily_reports_range: ${daysRes.error.message ?? 'unknown'}`;
        console.error(msg);
        setErrMsg(msg);
        setDays([]);
      } else {
        setDays((daysRes.data || []).map((r) => ({
          fecha: String(r.fecha),
          entrantes: Number(r.entrantes) || 0,
          confirmados: Number(r.confirmados) || 0,
          cancelados: Number(r.cancelados) || 0,
          noresp: Number(r.noresp) || 0,
          pendientes: Number(r.pendientes) || 0,
          pct_confirmacion: Number(r.pct_confirmacion) || 0,
          pct_cancelados: Number(r.pct_cancelados) || 0,
        })));
      }

      if (shiftsRes.error) {
        const msg = `admin_operator_shifts_range: ${shiftsRes.error.message ?? 'unknown'}`;
        console.error(msg);
        setErrMsg((prev) => (prev ? `${prev} | ${msg}` : msg));
        setShifts([]);
      } else {
        setShifts((shiftsRes.data || []).map((r) => ({
          fecha: String(r.fecha),
          tipo: (r.tipo as 'apertura' | 'cierre'),
          operadora: String(r.operadora),
          hora: r.hora ? String(r.hora) : null,
          pedidos_nuevos: r.pedidos_nuevos as number | null,
          guias_apertura: r.guias_apertura as number | null,
          pendientes_ayer: r.pendientes_ayer as number | null,
          confirmados: r.confirmados as number | null,
          noresp: r.noresp as number | null,
          cancelados: r.cancelados as number | null,
          total_gestionados: r.total_gestionados as number | null,
          pendientes_manana: r.pendientes_manana as number | null,
          notas: r.notas as string | null,
        })));
      }

      if (actionsRes.error) {
        const msg = `admin_operator_actions_per_day: ${actionsRes.error.message ?? 'unknown'}`;
        console.error(msg);
        setErrMsg((prev) => (prev ? `${prev} | ${msg}` : msg));
        setActions([]);
      } else {
        setActions((actionsRes.data || []).map((r) => ({
          fecha: String(r.fecha),
          operadora: String(r.operadora),
          conf: Number(r.conf) || 0,
          canc: Number(r.canc) || 0,
          noresp: Number(r.noresp) || 0,
          atendidos: Number(r.atendidos) || 0,
        })));
      }
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { void load(); }, [load]);

  // Totales del rango — en footer de la tabla por día.
  const totals = useMemo(() => {
    const t = days.reduce(
      (acc, r) => ({
        entrantes: acc.entrantes + r.entrantes,
        confirmados: acc.confirmados + r.confirmados,
        cancelados: acc.cancelados + r.cancelados,
        noresp: acc.noresp + r.noresp,
        pendientes: acc.pendientes + r.pendientes,
      }),
      { entrantes: 0, confirmados: 0, cancelados: 0, noresp: 0, pendientes: 0 },
    );
    // Tasas del agregado. %Conf/%Canc se muestran ÷inflow (sobre lo que entró);
    // la efectividad ÷resueltos queda en el tooltip. El total se pinta con color
    // normal: es un KPI agregado robusto (el gris "inmaduro" es señal por-día).
    const m = deriveDayMetrics(t.confirmados, t.cancelados, t.entrantes);
    return { ...t, ...m };
  }, [days]);

  // Mismos datos de la tabla, dibujados: una columna por día (embudo apilado)
  // más la línea de % confirmación. NO recalcula nada — reusa deriveDayMetrics,
  // y `pctConf` queda en null cuando no hay denominador (la línea se corta,
  // no se aplasta a 0).
  const chartRows = useMemo(
    () => days.map(r => {
      const m = deriveDayMetrics(r.confirmados, r.cancelados, r.entrantes);
      return {
        fecha: r.fecha,
        Confirmados: r.confirmados,
        Cancelados: r.cancelados,
        'No Respondió': r.noresp,
        Pendientes: r.pendientes,
        pctConf: m.tasaConfDia,
      };
    }),
    [days],
  );

  // Radio SOLO en el segmento más alto que realmente tiene volumen: ponérselo a
  // una serie vacía deja el tope de la columna cuadrado.
  const topStackSlug = useMemo(() => {
    const withData = DAY_STACK.filter(s => chartRows.some(r => (r[s.key] as number) > 0));
    return withData.length > 0 ? withData[withData.length - 1].slug : null;
  }, [chartRows]);

  const fmtHora = (h: string | null) =>
    h ? new Date(h).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: true }) : '';

  function exportDaysCsv() {
    const headers = [
      'Fecha', 'Entrantes', 'Confirmados', 'Cancelados',
      'No Respondió', 'Pendientes', '% Procesado',
      '% Confirmación del día (÷entró)', '% Cancelación del día (÷entró)',
      '% Efectividad cierre (÷resueltos)', 'Concluyente',
    ];
    const escape = (v: unknown) => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const csvRows = days.map(r => {
      const m = deriveDayMetrics(r.confirmados, r.cancelados, r.entrantes);
      return [
        r.fecha,
        r.entrantes, r.confirmados, r.cancelados, r.noresp, r.pendientes,
        `${m.pctProcesado}%`,
        m.tasaConfDia == null ? 'N/A' : `${m.tasaConfDia}%`,
        m.tasaCancDia == null ? 'N/A' : `${m.tasaCancDia}%`,
        m.tasaConf == null ? 'N/A' : `${m.tasaConf}%`,
        m.inmaduro ? 'no' : 'sí',
      ].map(escape).join(',');
    });
    const csv = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `reportes_dia_${from}_a_${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  function exportShiftsCsv() {
    const headers = [
      'Fecha', 'Tipo', 'Operadora', 'Hora',
      'Pedidos Nuevos', 'Guías Apertura', 'Pendientes Ayer',
      'Confirmados', 'No Respondió', 'Cancelados', 'Total',
      'Pendientes Mañana', 'Notas',
    ];
    const escape = (v: unknown) => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const csvRows = shifts.map(r => [
      r.fecha, r.tipo, r.operadora, fmtHora(r.hora),
      r.pedidos_nuevos ?? '', r.guias_apertura ?? '', r.pendientes_ayer ?? '',
      r.confirmados ?? '', r.noresp ?? '', r.cancelados ?? '', r.total_gestionados ?? '',
      r.pendientes_manana ?? '', r.notas ?? '',
    ].map(escape).join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `turnos_operadoras_${from}_a_${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const cellBase = 'px-3 py-2 text-xs font-mono whitespace-nowrap';

  // %CONF es ÷inflow (confirmación del día) → se compara contra la meta del día
  // (~55%), NO contra el 85% (esa es la efectividad ÷resueltos, va en el tooltip).
  // Verde en meta; ámbar en la banda "cerca" (5 pts por debajo); rojo debajo.
  function pctConfClass(p: number) {
    if (p >= CONF_DIA_TARGET_PCT) return 'text-success';
    if (p >= CONF_DIA_TARGET_PCT - 5) return 'text-warning';
    return 'text-danger';
  }

  return (
    <div className="space-y-5">
      {/* Filtros de rango compartidos por las dos vistas */}
      <motion.div
        {...fadeUp(0)}
        className="bg-card/40 rounded-2xl border border-border shadow-card3d hairline-top p-3 flex flex-wrap items-center justify-between gap-3"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-9 h-9 rounded-xl bg-info/14 border border-info/30 text-info glow-info flex items-center justify-center shrink-0" aria-hidden="true">
            <CalendarRange size={17} />
          </span>
          <div className="text-xs text-muted-foreground">
            Reportes diarios — rango compartido por las dos vistas
          </div>
        </div>
        <PresetDateRangePicker
          value={{ from, to }}
          onChange={({ from: f, to: t }) => { setFrom(f); setTo(t); }}
          align="end"
        />
      </motion.div>

      {/* Banner de error de RPC. Se muestra arriba de las dos tablas cuando
          alguna RPC falla (auth, función inexistente, signature mismatch).
          Texto en mono+wrap para no truncar el mensaje crudo de PostgREST. */}
      {errMsg && (
        <div className="relative flex flex-col sm:flex-row sm:items-start gap-3 rounded-2xl border border-danger/30 bg-danger/10 px-4 pl-5 py-3 shadow-card3d">
          <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-danger" aria-hidden="true" />
          <div className="w-9 h-9 rounded-xl bg-danger/20 glow-danger flex items-center justify-center flex-shrink-0 text-danger">
            <AlertTriangle size={17} aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0 text-xs font-mono whitespace-pre-wrap break-all text-danger">
            <span className="font-sans font-semibold text-danger mr-2">Error:</span>
            {errMsg}
          </div>
        </div>
      )}

      {loading && (
        <div className="bg-card/40 rounded-2xl border border-border shadow-card3d hairline-top flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-muted-foreground" />
        </div>
      )}

      {/* ── Titular del rango: el mismo total del pie de la tabla, dibujado ── */}
      {!loading && days.length > 0 && (
        <motion.div {...fadeUp(0.06)} className="grid grid-cols-1 md:grid-cols-12 gap-4">
          <TiltCard
            sheen
            brackets
            wrapperClassName="md:col-span-5"
            className="bg-card/40 border border-border rounded-3xl p-6 shadow-card3d-lg h-full flex flex-col justify-between"
          >
            <div className="flex items-center justify-between gap-3 tilt-layer-2">
              <div className="hud-label" title="Confirmados ÷ lo que ENTRÓ en el rango.">
                Confirmación del rango
              </div>
              <span className="inline-flex items-center px-2 py-1 rounded-lg text-[11px] font-semibold font-mono tabular-nums bg-card/40 border border-border text-muted-foreground whitespace-nowrap">
                {days.length} día{days.length === 1 ? '' : 's'}
              </span>
            </div>

            {/* Sin denominador NO hay tasa: se muestra el guion, nunca un 0%. */}
            <div className="flex justify-center py-4 tilt-layer-3">
              {totals.tasaConfDia == null ? (
                <div className="flex flex-col items-center justify-center gap-2 h-[190px] text-muted-foreground">
                  <span className="text-[38px] font-bold font-mono leading-none">—</span>
                  <span className="text-xs">Sin pedidos que entraran en el rango</span>
                </div>
              ) : (
                <GaugeRing
                  value={totals.tasaConfDia}
                  label="del rango"
                  size={190}
                  tone={
                    totals.tasaConfDia >= CONF_DIA_TARGET_PCT
                      ? 'success'
                      : totals.tasaConfDia >= CONF_DIA_TARGET_PCT - 5
                        ? 'warning'
                        : 'danger'
                  }
                />
              )}
            </div>

            <div className="tilt-layer-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
                <span>Procesado</span>
                <span className="font-mono tabular-nums text-foreground">
                  <b>{totals.resueltos}</b> / {totals.entrantes}
                </span>
              </div>
              <div className="relative h-2 rounded-full bg-foreground/10 overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent-gradient transition-[width] duration-700"
                  style={{ width: `${Math.max(0, Math.min(100, totals.pctProcesado))}%` }}
                  aria-hidden="true"
                />
                <span
                  className="absolute top-0 bottom-0 w-px bg-foreground/40"
                  style={{ left: `${CONF_DIA_TARGET_PCT}%` }}
                  aria-hidden="true"
                  title={`Meta del día ~${CONF_DIA_TARGET_PCT}%`}
                />
              </div>
            </div>
          </TiltCard>

          <div className="md:col-span-7 grid grid-cols-1 min-[390px]:grid-cols-2 gap-4">
            <StatTile icon={Inbox} label="Entrantes" value={totals.entrantes} tone="accent"
              title="Pedidos creados en el rango que entraron al flujo de confirmación." />
            <StatTile icon={CheckCircle2} label="Confirmados" value={totals.confirmados} tone="success"
              title="Pedidos del cohort que terminaron confirmados." />
            <StatTile icon={XCircle} label="Cancelados" value={totals.cancelados} tone="danger"
              title="Pedidos del cohort que terminaron cancelados." />
            <StatTile icon={PhoneOff} label="No Respondió" value={totals.noresp} tone="neutral"
              title="Pedidos del cohort que tuvieron noresp y nunca terminaron en conf/canc."
              extra={
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg border border-warning/30 bg-warning/14 text-warning text-[10px] font-semibold whitespace-nowrap">
                  <Clock size={10} aria-hidden="true" />
                  <span className="font-mono tabular-nums">{totals.pendientes}</span> pendientes
                </span>
              } />
          </div>
        </motion.div>
      )}

      {/* ── Curva del rango: una columna por día + la línea de % Conf ── */}
      {!loading && chartRows.length > 0 && (
        <motion.div
          {...fadeUp(0.12)}
          className="hairline-top bg-card/40 border border-border rounded-2xl p-5 shadow-card3d transition-colors duration-200 hover:border-border-strong"
        >
          <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Activity size={14} className="text-accent" aria-hidden="true" />
              Cómo terminó cada día
            </h3>
            <SwatchLegend
              items={[
                ...DAY_STACK.map(s => ({ color: s.color, label: s.key })),
                { color: C_ACCENT, label: '% Conf' },
              ]}
            />
          </div>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartRows} margin={{ top: 8, right: 10, bottom: 5, left: -10 }}>
                <defs>
                  <BarGradientDefs prefix="repDia" entries={DAY_STACK.map(s => ({ slug: s.slug, color: s.color }))} />
                  <linearGradient id="repDiaLine" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor={C_ACCENT} />
                    <stop offset="100%" stopColor={C_CYAN} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...CHART_GRID_PROPS} />
                <XAxis
                  dataKey="fecha" tickFormatter={fmtDay}
                  stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false}
                />
                <YAxis
                  yAxisId="left"
                  stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false}
                  width={36} allowDecimals={false}
                />
                <YAxis
                  yAxisId="right" orientation="right" domain={[0, 100]} unit="%"
                  stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false}
                  width={40}
                />
                <RTooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={CHART_BAR_CURSOR} />
                {DAY_STACK.map(s => (
                  <Bar
                    key={s.slug}
                    yAxisId="left"
                    dataKey={s.key}
                    stackId="dia"
                    fill={`url(#repDia-${s.slug})`}
                    radius={s.slug === topStackSlug ? [6, 6, 0, 0] : [0, 0, 0, 0]}
                    style={s.slug === 'conf' ? { filter: `drop-shadow(0 0 6px ${C_SUCCESS})` } : undefined}
                  />
                ))}
                {/* connectNulls={false} a propósito: un día sin entrantes NO tiene
                    tasa — la línea se corta en vez de fingir un 0%. */}
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="pctConf"
                  name="% Conf"
                  connectNulls={false}
                  stroke="url(#repDiaLine)"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  style={lineGlow(C_ACCENT)}
                  dot={(p: { cx?: number; cy?: number; index?: number }) =>
                    p.index === chartRows.length - 1
                      ? <circle key={`dot-${p.index}`} cx={p.cx} cy={p.cy} r={5}
                          fill={C_BG} stroke={C_CYAN} strokeWidth={2}
                          style={lineGlow(C_CYAN)} />
                      : <circle key={`dot-${p.index}`} cx={p.cx} cy={p.cy} r={2} fill={C_ACCENT} />}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: C_BG }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </motion.div>
      )}

      {/* ── Vista 1: Resumen cohort por día ── */}
      {!loading && (
        <motion.div
          {...fadeUp(0.18)}
          className="bg-card/40 rounded-2xl border border-border shadow-card3d hairline-top overflow-hidden transition-colors duration-200 hover:border-border-strong"
        >
          <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <span className="w-9 h-9 rounded-xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
                <ClipboardList size={17} />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Vista por día — cohort de inflow</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Pedidos que entraron cada día y su resultado final · {days.length} fila{days.length === 1 ? '' : 's'}
                </p>
              </div>
            </div>
            <button
              onClick={exportDaysCsv}
              disabled={days.length === 0}
              className="h-8 px-3 rounded-xl border border-border bg-card/40 text-muted-foreground hover:text-foreground hover:border-border-strong text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50"
            >
              <Download size={12} /> CSV
            </button>
          </div>

          {days.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">No hay datos en este rango</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-card/40 border-b border-border text-muted-foreground text-[10px] uppercase tracking-[0.2em] font-mono">
                    <th className="px-3 py-2 font-semibold">Fecha</th>
                    <th
                      className="px-3 py-2 font-semibold text-center"
                      title="Pedidos creados ese día que entraron al flujo de confirmación"
                    >
                      Entrantes
                    </th>
                    <th className="px-3 py-2 font-semibold text-center">Confirmados</th>
                    <th className="px-3 py-2 font-semibold text-center">Cancelados</th>
                    <th
                      className="px-3 py-2 font-semibold text-center"
                      title="Pedidos del cohort que tuvieron noresp y NUNCA terminaron en conf/canc"
                    >
                      No Respondió
                    </th>
                    <th
                      className="px-3 py-2 font-semibold text-center"
                      title="Pedidos del cohort sin ninguna gestión todavía"
                    >
                      Pendientes
                    </th>
                    <th
                      className="px-3 py-2 font-semibold text-center"
                      title="(Confirmados + Cancelados) ÷ Entrantes — qué tan trabajado está el día. Bajo 90% el día aún no es concluyente (gris)."
                    >
                      % Proc
                    </th>
                    <th
                      className="px-3 py-2 font-semibold text-center"
                      title="Confirmados ÷ lo que ENTRÓ ese día — confirmación del día. Meta ~55% (%Proc = %Conf + %Canc: todo sobre lo que entró). La efectividad de cierre (÷ resueltos, meta 85%) está en el tooltip de cada celda. Gris = día en curso / no concluyente."
                    >
                      % Conf
                    </th>
                    <th
                      className="px-3 py-2 font-semibold text-center"
                      title="Cancelados ÷ lo que ENTRÓ ese día (mismo denominador que %Conf)"
                    >
                      % Canc
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {days.map((r) => {
                    const m = deriveDayMetrics(r.confirmados, r.cancelados, r.entrantes);
                    // %CONF/%CANC ahora son ÷inflow (sobre lo que entró). Color:
                    //  - sin entrantes → "—"; inmaduro (día en curso) → gris no concluyente;
                    //  - maduro → color vs meta del día (~55%).
                    const confClass = m.tasaConfDia == null || m.inmaduro
                      ? 'text-muted-foreground'
                      : pctConfClass(m.tasaConfDia);
                    // Tooltip: la efectividad de cierre (÷resueltos, meta 85%) — el otro ángulo.
                    const confTitle = m.tasaConfDia == null
                      ? 'Sin pedidos que entraran todavía'
                      : m.inmaduro
                        ? `Día en curso — solo ${m.pctProcesado}% procesado, provisional. Efectividad de cierre: ${m.tasaConf == null ? 'N/A' : m.tasaConf + '%'} (÷ resueltos).`
                        : `${r.confirmados} confirmados de ${r.entrantes} que entraron. Efectividad de cierre: ${m.tasaConf == null ? 'N/A' : m.tasaConf + '%'} (÷ resueltos, meta 85%).`;
                    return (
                      <tr key={r.fecha} className="hover:bg-muted/30 transition-colors">
                        <td className={`${cellBase} font-sans font-semibold text-foreground`}>{r.fecha}</td>
                        <td className={`${cellBase} text-center font-bold text-foreground`}>{r.entrantes}</td>
                        <td className={`${cellBase} text-center text-success font-semibold`}>{r.confirmados}</td>
                        <td className={`${cellBase} text-center text-danger font-semibold`}>{r.cancelados}</td>
                        <td className={`${cellBase} text-center text-muted-foreground`}>{r.noresp}</td>
                        <td className={`${cellBase} text-center text-warning`}>{r.pendientes}</td>
                        <td className={`${cellBase} text-center font-semibold ${m.inmaduro ? 'text-muted-foreground' : 'text-foreground'}`}>
                          {m.pctProcesado}%
                        </td>
                        <td className={`${cellBase} text-center font-bold ${confClass}`} title={confTitle}>
                          {m.tasaConfDia == null ? '—' : `${m.tasaConfDia}%`}
                        </td>
                        <td className={`${cellBase} text-center ${m.tasaCancDia == null ? 'text-muted-foreground' : (m.tasaCancDia > 0 ? 'text-danger' : 'text-muted-foreground')}`}>
                          {m.tasaCancDia == null ? '—' : `${m.tasaCancDia}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {days.length > 1 && (
                  <tfoot>
                    <tr className="bg-muted/40 border-t-2 border-border">
                      <td className={`${cellBase} font-sans font-bold text-foreground`}>Total rango</td>
                      <td className={`${cellBase} text-center font-bold text-foreground`}>{totals.entrantes}</td>
                      <td className={`${cellBase} text-center text-success font-bold`}>{totals.confirmados}</td>
                      <td className={`${cellBase} text-center text-danger font-bold`}>{totals.cancelados}</td>
                      <td className={`${cellBase} text-center text-muted-foreground font-bold`}>{totals.noresp}</td>
                      <td className={`${cellBase} text-center text-warning font-bold`}>{totals.pendientes}</td>
                      <td className={`${cellBase} text-center font-bold text-foreground`}>{totals.pctProcesado}%</td>
                      <td className={`${cellBase} text-center font-bold ${totals.tasaConfDia == null ? 'text-muted-foreground' : pctConfClass(totals.tasaConfDia)}`}
                        title={`${totals.confirmados} confirmados de ${totals.entrantes} que entraron. Efectividad de cierre: ${totals.tasaConf == null ? 'N/A' : totals.tasaConf + '%'} (÷ resueltos, meta 85%).`}>
                        {totals.tasaConfDia == null ? '—' : `${totals.tasaConfDia}%`}
                      </td>
                      <td className={`${cellBase} text-center font-bold ${totals.tasaCancDia != null && totals.tasaCancDia > 0 ? 'text-danger' : 'text-muted-foreground'}`}>
                        {totals.tasaCancDia == null ? '—' : `${totals.tasaCancDia}%`}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </motion.div>
      )}

      {/* ── Vista 2: Detalle apertura/cierre por operadora ── */}
      {!loading && (
        <motion.div
          {...fadeUp(0.24)}
          className="bg-card/40 rounded-2xl border border-border shadow-card3d hairline-top overflow-hidden transition-colors duration-200 hover:border-border-strong"
        >
          <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <span className="w-9 h-9 rounded-xl bg-info/14 border border-info/30 text-info glow-info flex items-center justify-center flex-shrink-0" aria-hidden="true">
                <Users size={17} />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Apertura y cierre por operadora</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Conteos crudos de turnos · {shifts.length} fila{shifts.length === 1 ? '' : 's'}
                </p>
              </div>
            </div>
            <button
              onClick={exportShiftsCsv}
              disabled={shifts.length === 0}
              className="h-8 px-3 rounded-xl border border-border bg-card/40 text-muted-foreground hover:text-foreground hover:border-border-strong text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50"
            >
              <Download size={12} /> CSV
            </button>
          </div>

          {shifts.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">No hay turnos cerrados en este rango</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-card/40 border-b border-border text-muted-foreground text-[10px] uppercase tracking-[0.2em] font-mono">
                    <th className="px-2 py-2 font-semibold">Fecha</th>
                    <th className="px-2 py-2 font-semibold">Tipo</th>
                    <th className="px-2 py-2 font-semibold">Operadora</th>
                    <th className="px-2 py-2 font-semibold">Hora</th>
                    <th className="px-2 py-2 font-semibold text-center">Pedidos Nuevos</th>
                    <th className="px-2 py-2 font-semibold text-center">Guías Apertura</th>
                    <th className="px-2 py-2 font-semibold text-center">Pendientes Ayer</th>
                    <th className="px-2 py-2 font-semibold text-center">Confirmados</th>
                    <th className="px-2 py-2 font-semibold text-center">No Respondió</th>
                    <th className="px-2 py-2 font-semibold text-center">Cancelados</th>
                    <th className="px-2 py-2 font-semibold text-center">Total</th>
                    <th className="px-2 py-2 font-semibold text-center">Pend. Mañana</th>
                    <th className="px-2 py-2 font-semibold">Notas</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {shifts.map((r, i) => (
                    <tr
                      key={`${r.fecha}-${r.tipo}-${r.operadora}-${i}`}
                      className={`hover:bg-muted/30 transition-colors ${
                        r.tipo === 'apertura' ? 'bg-info/5' : 'bg-success/5'
                      }`}
                    >
                      <td className={cellBase}>{r.fecha}</td>
                      <td className={cellBase}>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          r.tipo === 'apertura' ? 'bg-info/15 text-info' : 'bg-success/15 text-success'
                        }`}>{r.tipo}</span>
                      </td>
                      <td className={`${cellBase} font-sans`}>{r.operadora}</td>
                      <td className={cellBase}>{fmtHora(r.hora)}</td>
                      <td className={`${cellBase} text-center ${r.pedidos_nuevos != null ? 'text-warning font-bold' : 'text-muted-foreground'}`}>
                        {r.pedidos_nuevos ?? ''}
                      </td>
                      <td className={`${cellBase} text-center`}>{r.guias_apertura ?? ''}</td>
                      <td className={`${cellBase} text-center`}>{r.pendientes_ayer ?? ''}</td>
                      <td className={`${cellBase} text-center`}>{r.confirmados ?? ''}</td>
                      <td className={`${cellBase} text-center`}>{r.noresp ?? ''}</td>
                      <td className={`${cellBase} text-center`}>
                        {r.cancelados != null && r.cancelados > 0 ? (
                          <button
                            type="button"
                            onClick={() => setCancelDetail({ operadora: r.operadora, fecha: r.fecha })}
                            className="text-danger font-bold underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none rounded"
                            title="Ver motivos de cancelación"
                          >
                            {r.cancelados}
                          </button>
                        ) : (r.cancelados ?? '')}
                      </td>
                      <td className={`${cellBase} text-center font-bold`}>{r.total_gestionados ?? ''}</td>
                      <td className={`${cellBase} text-center`}>{r.pendientes_manana ?? ''}</td>
                      <td className={`${cellBase} font-sans text-muted-foreground max-w-[260px] truncate`} title={r.notas ?? ''}>
                        {r.notas ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </motion.div>
      )}

      {/* ── Vista 3: Acciones por operadora por día (por fecha de la acción) ── */}
      {!loading && (
        <motion.div
          {...fadeUp(0.28)}
          className="bg-card/40 rounded-2xl border border-border shadow-card3d hairline-top overflow-hidden transition-colors duration-200 hover:border-border-strong"
        >
          <div className="px-5 py-4 border-b border-border">
            <div className="flex items-center gap-3">
              <span className="w-9 h-9 rounded-xl bg-ai/14 border border-ai/30 text-ai flex items-center justify-center flex-shrink-0" aria-hidden="true">
                <Users size={17} />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Acciones por operadora por día</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Lo que gestionó cada operadora cada día — por fecha de la acción (no por fecha del pedido).
                  Explica por qué el cohort puede mostrar "6 conf" mientras la operadora confirmó 12 el mismo día:
                  los otros 6 son de pedidos creados días anteriores (backlog). · {actions.length} fila{actions.length === 1 ? '' : 's'}
                </p>
              </div>
            </div>
          </div>

          {actions.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">No hay acciones en este rango</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-card/40 border-b border-border text-muted-foreground text-[10px] uppercase tracking-[0.2em] font-mono">
                    <th className="px-3 py-2 font-semibold">Fecha</th>
                    <th className="px-3 py-2 font-semibold">Operadora</th>
                    <th className="px-3 py-2 font-semibold text-center">Atendidos</th>
                    <th className="px-3 py-2 font-semibold text-center">Confirmados</th>
                    <th className="px-3 py-2 font-semibold text-center">Cancelados</th>
                    <th className="px-3 py-2 font-semibold text-center">No Respondió</th>
                    <th
                      className="px-3 py-2 font-semibold text-center"
                      title="Confirmados ÷ Atendidos del día (qué % de lo que tocó cerró en conf)"
                    >
                      % Conf / Atendidos
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {actions.map((r, i) => {
                    const pct = r.atendidos > 0 ? Math.round((r.conf / r.atendidos) * 100) : 0;
                    return (
                      <tr key={`${r.fecha}-${r.operadora}-${i}`} className="hover:bg-muted/30 transition-colors">
                        <td className={`${cellBase} font-sans font-semibold text-foreground`}>{r.fecha}</td>
                        <td className={`${cellBase} font-sans`}>{r.operadora}</td>
                        <td className={`${cellBase} text-center font-bold text-foreground`}>{r.atendidos}</td>
                        <td className={`${cellBase} text-center text-success font-semibold`}>{r.conf}</td>
                        <td className={`${cellBase} text-center text-danger font-semibold`}>{r.canc}</td>
                        <td className={`${cellBase} text-center text-muted-foreground`}>{r.noresp}</td>
                        <td className={`${cellBase} text-center font-bold ${pctConfClass(pct)}`}>{pct}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </motion.div>
      )}

      {cancelDetail && (
        <CancelledReasonsModal
          operadora={cancelDetail.operadora}
          fecha={cancelDetail.fecha}
          onClose={() => setCancelDetail(null)}
        />
      )}
    </div>
  );
}
