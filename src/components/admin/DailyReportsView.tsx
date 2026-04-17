import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { ClipboardList, Download, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { Input } from '@/components/ui/input';

interface Row {
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
  pct_confirmacion: number | null;
  pct_cancelados: number | null;
  pendientes_manana: number | null;
  notas: string | null;
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
        pct_confirmacion: r.pct_confirmacion as number | null,
        pct_cancelados: r.pct_cancelados as number | null,
        pendientes_manana: r.pendientes_manana as number | null,
        notas: r.notas as string | null,
      })));
    }
    setLoading(false);
  }, [from, to]);

  useEffect(() => { void load(); }, [load]);

  const fmtHora = (h: string | null) =>
    h ? new Date(h).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: true }) : '';

  function exportCsv() {
    const headers = ['Fecha','Tipo','Operadora','Hora','Pedidos Nuevos','Guías Apertura','Pendientes','Confirmados','No Respondió','Cancelados','Total Gestionados','% Confirmación','% Cancelados','Pendientes Mañana','Notas'];
    const escape = (v: unknown) => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const csvRows = rows.map(r => [
      r.fecha, r.tipo, r.operadora, fmtHora(r.hora),
      r.pedidos_nuevos ?? '', r.guias_apertura ?? '', r.pendientes_ayer ?? '',
      r.confirmados ?? '', r.noresp ?? '', r.cancelados ?? '',
      r.total_gestionados ?? '',
      r.pct_confirmacion != null ? `${r.pct_confirmacion}%` : '',
      r.pct_cancelados != null ? `${r.pct_cancelados}%` : '',
      r.pendientes_manana ?? '', r.notas ?? '',
    ].map(escape).join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `reportes_${from}_a_${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const cellBase = 'px-2 py-2 text-xs font-mono whitespace-nowrap';

  function pctConfClass(p: number | null) {
    if (p == null) return '';
    if (p >= 70) return 'text-green';
    if (p >= 65) return 'text-orange';
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
            <h3 className="text-sm font-semibold text-foreground">Reportes diarios por operadora</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Apertura y cierre — {rows.length} fila{rows.length === 1 ? '' : 's'}</p>
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
        <div className="p-8 text-center text-sm text-muted-foreground">No hay reportes en este rango</div>
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
                <th className="px-2 py-2 font-semibold text-center">Pendientes</th>
                <th className="px-2 py-2 font-semibold text-center">Confirmados</th>
                <th className="px-2 py-2 font-semibold text-center">No Respondió</th>
                <th className="px-2 py-2 font-semibold text-center">Cancelados</th>
                <th className="px-2 py-2 font-semibold text-center">Total</th>
                <th className="px-2 py-2 font-semibold text-center">% Conf.</th>
                <th className="px-2 py-2 font-semibold text-center">% Canc.</th>
                <th className="px-2 py-2 font-semibold text-center">Pend. Mañana</th>
                <th className="px-2 py-2 font-semibold">Notas</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r, i) => (
                <tr
                  key={i}
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
                  <td className={`${cellBase} text-center ${r.pedidos_nuevos != null ? 'text-orange font-bold' : 'text-muted-foreground'}`}>{r.pedidos_nuevos ?? ''}</td>
                  <td className={`${cellBase} text-center`}>{r.guias_apertura ?? ''}</td>
                  <td className={`${cellBase} text-center`}>{r.pendientes_ayer ?? ''}</td>
                  <td className={`${cellBase} text-center`}>{r.confirmados ?? ''}</td>
                  <td className={`${cellBase} text-center`}>{r.noresp ?? ''}</td>
                  <td className={`${cellBase} text-center`}>{r.cancelados ?? ''}</td>
                  <td className={`${cellBase} text-center font-bold`}>{r.total_gestionados ?? ''}</td>
                  <td className={`${cellBase} text-center font-bold ${pctConfClass(r.pct_confirmacion)}`}>
                    {r.pct_confirmacion != null ? `${r.pct_confirmacion}%` : ''}
                  </td>
                  <td className={`${cellBase} text-center ${r.pct_cancelados != null && r.pct_cancelados > 0 ? 'text-red' : ''}`}>
                    {r.pct_cancelados != null ? `${r.pct_cancelados}%` : ''}
                  </td>
                  <td className={`${cellBase} text-center`}>{r.pendientes_manana ?? ''}</td>
                  <td className={`${cellBase} font-sans text-muted-foreground max-w-[260px] truncate`} title={r.notas ?? ''}>{r.notas ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </motion.div>
  );
}
