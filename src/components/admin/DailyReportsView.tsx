import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { ClipboardList, Download, Loader2, Users } from 'lucide-react';
import { motion } from 'framer-motion';
import PresetDateRangePicker from '@/components/PresetDateRangePicker';
import { confRateByCohort, CONF_DIA_TARGET_PCT } from '@/lib/confirmationRate';
import CancelledReasonsModal from '@/components/admin/CancelledReasonsModal';

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
    if (p >= CONF_DIA_TARGET_PCT) return 'text-green';
    if (p >= CONF_DIA_TARGET_PCT - 5) return 'text-orange';
    return 'text-red';
  }

  return (
    <div className="space-y-5">
      {/* Filtros de rango compartidos por las dos vistas */}
      <div className="bg-card/40 rounded-2xl border border-border shadow-card3d hairline-top px-5 py-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          Reportes diarios — rango compartido por las dos vistas
        </div>
        <PresetDateRangePicker
          value={{ from, to }}
          onChange={({ from: f, to: t }) => { setFrom(f); setTo(t); }}
          align="end"
        />
      </div>

      {/* Banner de error de RPC. Se muestra arriba de las dos tablas cuando
          alguna RPC falla (auth, función inexistente, signature mismatch).
          Texto en mono+wrap para no truncar el mensaje crudo de PostgREST. */}
      {errMsg && (
        <div className="bg-red/10 border border-red/30 text-red rounded-2xl shadow-card3d px-4 py-3 text-xs font-mono whitespace-pre-wrap break-all">
          <span className="font-sans font-semibold text-red mr-2">Error:</span>
          {errMsg}
        </div>
      )}

      {loading && (
        <div className="bg-card/40 rounded-2xl border border-border shadow-card3d hairline-top flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-muted-foreground" />
        </div>
      )}

      {/* ── Vista 1: Resumen cohort por día ── */}
      {!loading && (
        <motion.div
          initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}
          className="bg-card/40 rounded-2xl border border-border shadow-card3d hairline-top overflow-hidden"
        >
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-8 h-8 rounded-xl bg-accent/14 border border-accent/30 text-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
                <ClipboardList size={15} />
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
                        <td className={`${cellBase} text-center text-green font-semibold`}>{r.confirmados}</td>
                        <td className={`${cellBase} text-center text-red font-semibold`}>{r.cancelados}</td>
                        <td className={`${cellBase} text-center text-muted-foreground`}>{r.noresp}</td>
                        <td className={`${cellBase} text-center text-orange`}>{r.pendientes}</td>
                        <td className={`${cellBase} text-center font-semibold ${m.inmaduro ? 'text-muted-foreground' : 'text-foreground'}`}>
                          {m.pctProcesado}%
                        </td>
                        <td className={`${cellBase} text-center font-bold ${confClass}`} title={confTitle}>
                          {m.tasaConfDia == null ? '—' : `${m.tasaConfDia}%`}
                        </td>
                        <td className={`${cellBase} text-center ${m.tasaCancDia == null ? 'text-muted-foreground' : (m.tasaCancDia > 0 ? 'text-red' : 'text-muted-foreground')}`}>
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
                      <td className={`${cellBase} text-center text-green font-bold`}>{totals.confirmados}</td>
                      <td className={`${cellBase} text-center text-red font-bold`}>{totals.cancelados}</td>
                      <td className={`${cellBase} text-center text-muted-foreground font-bold`}>{totals.noresp}</td>
                      <td className={`${cellBase} text-center text-orange font-bold`}>{totals.pendientes}</td>
                      <td className={`${cellBase} text-center font-bold text-foreground`}>{totals.pctProcesado}%</td>
                      <td className={`${cellBase} text-center font-bold ${totals.tasaConfDia == null ? 'text-muted-foreground' : pctConfClass(totals.tasaConfDia)}`}
                        title={`${totals.confirmados} confirmados de ${totals.entrantes} que entraron. Efectividad de cierre: ${totals.tasaConf == null ? 'N/A' : totals.tasaConf + '%'} (÷ resueltos, meta 85%).`}>
                        {totals.tasaConfDia == null ? '—' : `${totals.tasaConfDia}%`}
                      </td>
                      <td className={`${cellBase} text-center font-bold ${totals.tasaCancDia != null && totals.tasaCancDia > 0 ? 'text-red' : 'text-muted-foreground'}`}>
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
          initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.05 }}
          className="bg-card/40 rounded-2xl border border-border shadow-card3d hairline-top overflow-hidden"
        >
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-8 h-8 rounded-xl bg-accent/14 border border-accent/30 text-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
                <Users size={15} />
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
                        r.tipo === 'apertura' ? 'bg-blue/5' : 'bg-green/5'
                      }`}
                    >
                      <td className={cellBase}>{r.fecha}</td>
                      <td className={cellBase}>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          r.tipo === 'apertura' ? 'bg-blue/15 text-blue' : 'bg-green/15 text-green'
                        }`}>{r.tipo}</span>
                      </td>
                      <td className={`${cellBase} font-sans`}>{r.operadora}</td>
                      <td className={cellBase}>{fmtHora(r.hora)}</td>
                      <td className={`${cellBase} text-center ${r.pedidos_nuevos != null ? 'text-orange font-bold' : 'text-muted-foreground'}`}>
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
                            className="text-red font-bold underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none rounded"
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
          initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.1 }}
          className="bg-card/40 rounded-2xl border border-border shadow-card3d hairline-top overflow-hidden"
        >
          <div className="px-5 py-4 border-b border-border">
            <div className="flex items-center gap-2">
              <Users size={16} className="text-primary" />
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
                        <td className={`${cellBase} text-center text-green font-semibold`}>{r.conf}</td>
                        <td className={`${cellBase} text-center text-red font-semibold`}>{r.canc}</td>
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
