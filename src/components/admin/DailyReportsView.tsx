import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { ClipboardList, Download, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { Input } from '@/components/ui/input';

// Vista de NEGOCIO por día. Una fila por fecha con la métrica de cohort:
// pedidos que entraron ese día y cómo terminaron. Los % son sobre el inflow
// (siempre ≤ 100%). Reemplaza la vista vieja por cierre de operadora — el
// detalle por operadora vive en /admin → Productividad.
//
// Reportado 2026-05-05: la versión vieja mostraba >100% (ej. 275%) cuando la
// operadora confirmaba pedidos del backlog contra el inflow del día actual.
// Ver migration 20260505230000 para el RPC redefinido.

interface Row {
  fecha: string;
  entrantes: number;
  confirmados: number;
  cancelados: number;
  noresp: number;
  pendientes: number;
  pct_confirmacion: number;
  pct_cancelados: number;
}

function isoDate(d: Date) { return d.toISOString().split('T')[0]; }

export default function DailyReportsView() {
  const today = useMemo(() => new Date(), []);
  const sevenAgo = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 6); return d; }, []);

  const [from, setFrom] = useState(isoDate(sevenAgo));
  const [to, setTo] = useState(isoDate(today));
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await (supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>
    ) => Promise<{ data: Array<Record<string, unknown>> | null; error: { message?: string } | null }>)(
      'admin_daily_reports_range', { p_from: from, p_to: to }
    );
    if (error) {
      console.error('admin_daily_reports_range:', error.message);
      setRows([]);
    } else {
      setRows((data || []).map((r) => ({
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
    setLoading(false);
  }, [from, to]);

  useEffect(() => { void load(); }, [load]);

  // Totales del rango — visibles en el footer para tener el agregado
  // del período de un vistazo sin tener que sumar cabeza.
  const totals = useMemo(() => {
    const t = rows.reduce(
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
  }, [rows]);

  function exportCsv() {
    const headers = [
      'Fecha', 'Entrantes', 'Confirmados', 'Cancelados',
      'No Respondió', 'Pendientes', '% Confirmación', '% Cancelación',
    ];
    const escape = (v: unknown) => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const csvRows = rows.map(r => [
      r.fecha,
      r.entrantes, r.confirmados, r.cancelados, r.noresp, r.pendientes,
      `${r.pct_confirmacion}%`, `${r.pct_cancelados}%`,
    ].map(escape).join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `reportes_${from}_a_${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const cellBase = 'px-3 py-2 text-xs font-mono whitespace-nowrap';

  function pctConfClass(p: number) {
    if (p >= 70) return 'text-green';
    if (p >= 50) return 'text-orange';
    return 'text-red';
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}
      className="bg-card rounded-xl border border-border overflow-hidden"
    >
      <div className="px-5 py-4 border-b border-border flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ClipboardList size={16} className="text-primary" />
          <div>
            <h3 className="text-sm font-semibold text-foreground">Reportes diarios — vista por día</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Cohort por fecha de entrada · {rows.length} fila{rows.length === 1 ? '' : 's'}
            </p>
          </div>
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
          <button
            onClick={exportCsv}
            disabled={rows.length === 0}
            className="h-8 px-3 rounded-lg border border-border bg-secondary text-secondary-foreground text-xs font-medium flex items-center gap-1.5 hover:bg-secondary/80 transition-colors disabled:opacity-50"
          >
            <Download size={12} /> CSV
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
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
              {rows.map((r) => (
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
            {rows.length > 1 && (
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
  );
}
