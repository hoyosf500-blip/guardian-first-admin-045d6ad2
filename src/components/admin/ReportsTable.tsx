import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { ClipboardList, Download, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { CONF_TARGET_PCT } from '@/lib/confirmationRate';

interface ReportRow {
  fecha: string;
  tipo: string;
  hora: string;
  operadora: string;
  pedidos_nuevos: number | null;
  guias_apertura: number | null;
  pendientes: number | null;
  confirmados: number | null;
  no_respondio: number | null;
  cancelados: number | null;
  total_gestionados: number | null;
  tasa_confirmacion: number | null;
  tasa_cancelados: number | null;
  pendientes_manana: number | null;
}

export default function ReportsTable() {
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadReports();
  }, []);

  async function loadReports() {
    setLoading(true);
    const { data: profiles, error: profErr } = await supabase.from('profiles').select('user_id, display_name');
    if (profErr) console.error('Error loading profiles:', profErr.message);
    const { data: reports, error: repErr } = await supabase
      .from('daily_reports')
      .select('operator_id, report_date, report_type, data, created_at')
      .order('report_date', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(100);
    if (repErr) console.error('Error loading reports:', repErr.message);

    if (!reports || !profiles) { setLoading(false); return; }

    const profileMap = new Map(profiles.map(p => [p.user_id, p.display_name]));

    const mapped: ReportRow[] = reports.map(r => {
      const d = r.data as Record<string, number>;
      const hora = new Date(r.created_at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: true });
      const isApertura = r.report_type === 'apertura';

      if (isApertura) {
        return {
          fecha: r.report_date,
          tipo: 'apertura',
          hora,
          operadora: profileMap.get(r.operator_id) || 'Desconocido',
          pedidos_nuevos: d.nuevos ?? null,
          guias_apertura: d.guias ?? null,
          pendientes: d.pendientes ?? null,
          confirmados: null, no_respondio: null, cancelados: null,
          total_gestionados: null, tasa_confirmacion: null, tasa_cancelados: null, pendientes_manana: null,
        };
      } else {
        const total = d.total_gestionados ?? 0;
        const conf = d.confirmados ?? 0;
        const canc = d.cancelados ?? 0;
        return {
          fecha: r.report_date,
          tipo: 'cierre',
          hora,
          operadora: profileMap.get(r.operator_id) || 'Desconocido',
          pedidos_nuevos: null, guias_apertura: null, pendientes: null,
          confirmados: conf,
          no_respondio: d.no_respondio ?? 0,
          cancelados: canc,
          total_gestionados: total,
          tasa_confirmacion: total > 0 ? Math.round((conf / total) * 100) : 0,
          tasa_cancelados: total > 0 ? Math.round((canc / total) * 100) : 0,
          pendientes_manana: d.pendientes_manana ?? 0,
        };
      }
    });

    setRows(mapped);
    setLoading(false);
  }

  function exportCsv() {
    const headers = ['Fecha', 'Tipo', 'Hora', 'Operadora', 'Pedidos Nuevos', 'Guías Apertura', 'Pendientes', 'Confirmados', 'No Respondió', 'Cancelados', 'Total Gestionados', '% Confirmación', '% Cancelados', 'Pendientes Mañana'];
    const csvRows = rows.map(r => [
      r.fecha, r.tipo, r.hora, r.operadora,
      r.pedidos_nuevos ?? '', r.guias_apertura ?? '', r.pendientes ?? '',
      r.confirmados ?? '', r.no_respondio ?? '', r.cancelados ?? '',
      r.total_gestionados ?? '', r.tasa_confirmacion != null ? `${r.tasa_confirmacion}%` : '',
      r.tasa_cancelados != null ? `${r.tasa_cancelados}%` : '', r.pendientes_manana ?? '',
    ].join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `reportes_${new Date().toISOString().split('T')[0]}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const cellBase = 'px-2 py-2 text-xs font-mono whitespace-nowrap';

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}
      className="bg-card rounded-xl border border-border overflow-hidden md:col-span-2"
    >
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ClipboardList size={16} className="text-primary" />
          <div>
            <h3 className="text-sm font-semibold text-foreground">Reportes Diarios</h3>
            <p className="text-xs text-muted-foreground mt-0.5">{rows.length} registros (apertura + cierre)</p>
          </div>
        </div>
        <button
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="h-8 px-3 rounded-lg border border-border bg-secondary text-secondary-foreground text-xs font-medium flex items-center gap-1.5 hover:bg-secondary/80 transition-colors disabled:opacity-50"
        >
          <Download size={12} /> CSV
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">No hay reportes aún</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-muted/50 text-muted-foreground text-[10px] uppercase tracking-wider">
                <th className="px-2 py-2 font-semibold">Fecha</th>
                <th className="px-2 py-2 font-semibold">Tipo</th>
                <th className="px-2 py-2 font-semibold">Hora</th>
                <th className="px-2 py-2 font-semibold">Operadora</th>
                <th className="px-2 py-2 font-semibold text-center">P. Nuevos</th>
                <th className="px-2 py-2 font-semibold text-center">Guías</th>
                <th className="px-2 py-2 font-semibold text-center">Pend.</th>
                <th className="px-2 py-2 font-semibold text-center">Conf.</th>
                <th className="px-2 py-2 font-semibold text-center">N/R</th>
                <th className="px-2 py-2 font-semibold text-center">Canc.</th>
                <th className="px-2 py-2 font-semibold text-center">Total</th>
                <th className="px-2 py-2 font-semibold text-center">% Conf.</th>
                <th className="px-2 py-2 font-semibold text-center">% Canc.</th>
                <th className="px-2 py-2 font-semibold text-center">Pend. Mañana</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r, i) => (
                <tr key={i} className={`hover:bg-muted/30 transition-colors ${r.tipo === 'cierre' ? 'bg-muted/10' : ''}`}>
                  <td className={cellBase}>{r.fecha}</td>
                  <td className={cellBase}>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                      r.tipo === 'apertura' ? 'bg-blue/10 text-blue' : 'bg-purple/10 text-purple'
                    }`}>{r.tipo}</span>
                  </td>
                  <td className={cellBase}>{r.hora}</td>
                  <td className={`${cellBase} font-sans`}>{r.operadora}</td>
                  <td className={`${cellBase} text-center ${r.pedidos_nuevos != null ? 'text-orange font-bold' : 'text-muted-foreground'}`}>
                    {r.pedidos_nuevos ?? ''}
                  </td>
                  <td className={`${cellBase} text-center`}>{r.guias_apertura ?? ''}</td>
                  <td className={`${cellBase} text-center`}>{r.pendientes ?? ''}</td>
                  <td className={`${cellBase} text-center`}>{r.confirmados ?? ''}</td>
                  <td className={`${cellBase} text-center`}>{r.no_respondio ?? ''}</td>
                  <td className={`${cellBase} text-center`}>{r.cancelados ?? ''}</td>
                  <td className={`${cellBase} text-center font-bold`}>{r.total_gestionados ?? ''}</td>
                  {/* Color de la tasa de confirmación vs la meta oficial del
                      dueño (CONF_TARGET_PCT = 85%, fuente única). Verde en meta;
                      ámbar en la banda "cerca" (5 pts); rojo debajo. */}
                  <td className={`${cellBase} text-center font-bold ${
                    r.tasa_confirmacion != null
                      ? r.tasa_confirmacion >= CONF_TARGET_PCT ? 'text-green' : r.tasa_confirmacion >= CONF_TARGET_PCT - 5 ? 'text-orange' : 'text-red'
                      : ''
                  }`}>
                    {r.tasa_confirmacion != null ? `${r.tasa_confirmacion}%` : ''}
                  </td>
                  <td className={`${cellBase} text-center ${
                    r.tasa_cancelados != null && r.tasa_cancelados > 0 ? 'text-red' : ''
                  }`}>
                    {r.tasa_cancelados != null ? `${r.tasa_cancelados}%` : ''}
                  </td>
                  <td className={`${cellBase} text-center`}>{r.pendientes_manana ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </motion.div>
  );
}
