import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { ClipboardList, Download, Loader2, Users } from 'lucide-react';
import { motion } from 'framer-motion';
import { Input } from '@/components/ui/input';

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

export default function DailyReportsView() {
  const today = useMemo(() => new Date(), []);
  const sevenAgo = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 6); return d; }, []);

  const [from, setFrom] = useState(isoDate(sevenAgo));
  const [to, setTo] = useState(isoDate(today));
  const [days, setDays] = useState<DayRow[]>([]);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [loading, setLoading] = useState(true);
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
      const [daysRes, shiftsRes] = await Promise.all([
        Promise.resolve(rpc('admin_daily_reports_range', { p_from: from, p_to: to })).catch(
          (err: unknown) => ({ data: null, error: { message: String(err) } } as const)
        ),
        Promise.resolve(rpc('admin_operator_shifts_range', { p_from: from, p_to: to })).catch(
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
    const pctConf = t.entrantes > 0 ? Math.round((t.confirmados / t.entrantes) * 100) : 0;
    const pctCanc = t.entrantes > 0 ? Math.round((t.cancelados / t.entrantes) * 100) : 0;
    return { ...t, pctConf, pctCanc };
  }, [days]);

  const fmtHora = (h: string | null) =>
    h ? new Date(h).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: true }) : '';

  function exportDaysCsv() {
    const headers = [
      'Fecha', 'Entrantes', 'Confirmados', 'Cancelados',
      'No Respondió', 'Pendientes', '% Confirmación', '% Cancelación',
    ];
    const escape = (v: unknown) => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const csvRows = days.map(r => [
      r.fecha,
      r.entrantes, r.confirmados, r.cancelados, r.noresp, r.pendientes,
      `${r.pct_confirmacion}%`, `${r.pct_cancelados}%`,
    ].map(escape).join(','));
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

  function pctConfClass(p: number) {
    if (p >= 70) return 'text-green';
    if (p >= 50) return 'text-orange';
    return 'text-red';
  }

  return (
    <div className="space-y-5">
      {/* Filtros de rango compartidos por las dos vistas */}
      <div className="bg-card rounded-xl border border-border px-5 py-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          Reportes diarios — rango compartido por las dos vistas
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <label className="text-xs text-muted-foreground">Desde</label>
            <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="h-8 w-36 text-xs" />
          </div>
          <div className="flex items-center gap-1">
            <label className="text-xs text-muted-foreground">Hasta</label>
            <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="h-8 w-36 text-xs" />
          </div>
        </div>
      </div>

      {/* Banner de error de RPC. Se muestra arriba de las dos tablas cuando
          alguna RPC falla (auth, función inexistente, signature mismatch).
          Texto en mono+wrap para no truncar el mensaje crudo de PostgREST. */}
      {errMsg && (
        <div className="bg-red/10 border border-red/30 text-red rounded-xl px-4 py-3 text-xs font-mono whitespace-pre-wrap break-all">
          <span className="font-sans font-semibold text-red mr-2">Error:</span>
          {errMsg}
        </div>
      )}

      {loading && (
        <div className="bg-card rounded-xl border border-border flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-muted-foreground" />
        </div>
      )}

      {/* ── Vista 1: Resumen cohort por día ── */}
      {!loading && (
        <motion.div
          initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}
          className="bg-card rounded-xl border border-border overflow-hidden"
        >
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ClipboardList size={16} className="text-primary" />
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
              className="h-8 px-3 rounded-lg border border-border bg-secondary text-secondary-foreground text-xs font-medium flex items-center gap-1.5 hover:bg-secondary/80 transition-colors disabled:opacity-50"
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
                  <tr className="bg-muted/50 text-muted-foreground text-[10px] uppercase tracking-wider">
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
                      title="Confirmados ÷ Entrantes (siempre ≤ 100%)"
                    >
                      % Conf
                    </th>
                    <th
                      className="px-3 py-2 font-semibold text-center"
                      title="Cancelados ÷ Entrantes"
                    >
                      % Canc
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {days.map((r) => (
                    <tr key={r.fecha} className="hover:bg-muted/30 transition-colors">
                      <td className={`${cellBase} font-sans font-semibold text-foreground`}>{r.fecha}</td>
                      <td className={`${cellBase} text-center font-bold text-foreground`}>{r.entrantes}</td>
                      <td className={`${cellBase} text-center text-green font-semibold`}>{r.confirmados}</td>
                      <td className={`${cellBase} text-center text-red font-semibold`}>{r.cancelados}</td>
                      <td className={`${cellBase} text-center text-muted-foreground`}>{r.noresp}</td>
                      <td className={`${cellBase} text-center text-orange`}>{r.pendientes}</td>
                      <td className={`${cellBase} text-center font-bold ${pctConfClass(r.pct_confirmacion)}`}>
                        {r.pct_confirmacion}%
                      </td>
                      <td className={`${cellBase} text-center ${r.pct_cancelados > 0 ? 'text-red' : 'text-muted-foreground'}`}>
                        {r.pct_cancelados}%
                      </td>
                    </tr>
                  ))}
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
                      <td className={`${cellBase} text-center font-bold ${pctConfClass(totals.pctConf)}`}>
                        {totals.pctConf}%
                      </td>
                      <td className={`${cellBase} text-center font-bold ${totals.pctCanc > 0 ? 'text-red' : 'text-muted-foreground'}`}>
                        {totals.pctCanc}%
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
          className="bg-card rounded-xl border border-border overflow-hidden"
        >
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users size={16} className="text-primary" />
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
              className="h-8 px-3 rounded-lg border border-border bg-secondary text-secondary-foreground text-xs font-medium flex items-center gap-1.5 hover:bg-secondary/80 transition-colors disabled:opacity-50"
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
                  <tr className="bg-muted/50 text-muted-foreground text-[10px] uppercase tracking-wider">
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
                      <td className={`${cellBase} text-center`}>{r.cancelados ?? ''}</td>
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
    </div>
  );
}
