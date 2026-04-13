import { useOrders } from '@/contexts/OrderContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { truncate, formatDateES } from '@/lib/orderUtils';
import { useState, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, XCircle, PhoneOff, Clock, Send, Copy, MessageSquare, Download } from 'lucide-react';
import { motion } from 'framer-motion';

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';

interface DailyResult { result_date: string; result: string; }

export default function DashboardTab() {
  const { allOrders, counter, workQueue } = useOrders();
  const { user } = useAuth();
  const [period, setPeriod] = useState(7);
  const [historyData, setHistoryData] = useState<DailyResult[]>([]);

  useEffect(() => {
    if (!user) return;
    const since = new Date(); since.setDate(since.getDate() - 30);
    supabase.from('order_results').select('result_date, result')
      .eq('operator_id', user.id).gte('result_date', since.toISOString().split('T')[0])
      .order('result_date', { ascending: true })
      .then(({ data }) => { if (data) setHistoryData(data); });
  }, [user]);

  const chartData = useMemo(() => {
    const since = new Date(); since.setDate(since.getDate() - period);
    const sinceStr = since.toISOString().split('T')[0];
    const filtered = historyData.filter(r => r.result_date >= sinceStr);
    const byDay: Record<string, { conf: number; canc: number; noresp: number }> = {};
    for (let i = 0; i < period; i++) {
      const d = new Date(); d.setDate(d.getDate() - (period - 1 - i));
      byDay[d.toISOString().split('T')[0]] = { conf: 0, canc: 0, noresp: 0 };
    }
    filtered.forEach(r => {
      if (!byDay[r.result_date]) byDay[r.result_date] = { conf: 0, canc: 0, noresp: 0 };
      if (r.result === 'conf') byDay[r.result_date].conf++;
      else if (r.result === 'canc') byDay[r.result_date].canc++;
      else byDay[r.result_date].noresp++;
    });
    return Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([date, d]) => {
      const t = d.conf + d.canc + d.noresp;
      return { date: new Date(date + 'T12:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short' }), ...d, tasa: t > 0 ? Math.round(d.conf / t * 100) : 0, total: t };
    });
  }, [historyData, period]);

  const total = counter.conf + counter.canc + counter.noresp;
  const tasa = total > 0 ? Math.round(counter.conf / total * 100) : 0;
  const pendLeft = workQueue.filter(o => !o.result).length;

  const byProd: Record<string, { total: number; entreg: number; canc: number; nov: number }> = {};
  allOrders.forEach(o => {
    const p = o.producto || 'Sin producto';
    if (!byProd[p]) byProd[p] = { total: 0, entreg: 0, canc: 0, nov: 0 };
    byProd[p].total++;
    const e = o.estado.toUpperCase();
    if (e.includes('ENTREGAD')) byProd[p].entreg++;
    else if (e.includes('CANCEL')) byProd[p].canc++;
    else if (e.includes('NOVEDAD')) byProd[p].nov++;
  });
  const prods = Object.entries(byProd).sort((a, b) => b[1].total - a[1].total);

  const downloadCsv = (filename: string, headers: string[], rows: string[][]) => {
    const csv = '\uFEFF' + [headers.join(','), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))].join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = filename; a.click(); toast.success('CSV descargado');
  };
  const exportarResultadosHoy = () => {
    const managed = workQueue.filter(o => o.result);
    if (!managed.length) { toast.error('No hay resultados hoy'); return; }
    downloadCsv(`resultados_${new Date().toISOString().split('T')[0]}.csv`,
      ['Teléfono', 'Nombre', 'Producto', 'Ciudad', 'Resultado', 'Razón', 'Valor'],
      managed.map(o => [o.phone, o.nombre, o.producto, o.ciudad, o.result === 'conf' ? 'Confirmado' : o.result === 'canc' ? 'Cancelado' : 'No respondió', o.reason || '', String(o.valor)]));
  };
  const exportarHistorico = async () => {
    if (!user) return;
    const since = new Date(); since.setDate(since.getDate() - period);
    const sinceStr = since.toISOString().split('T')[0];
    const { data, error } = await supabase.from('order_results').select('result_date, result_time, phone, result, reason, module')
      .eq('operator_id', user.id).gte('result_date', sinceStr).order('result_date', { ascending: false });
    if (error || !data?.length) { toast.error(error ? 'Error' : 'Sin datos'); return; }
    downloadCsv(`historico_${sinceStr}.csv`, ['Fecha', 'Hora', 'Teléfono', 'Resultado', 'Razón', 'Módulo'],
      data.map(r => [r.result_date, r.result_time || '', r.phone, r.result === 'conf' ? 'Confirmado' : r.result === 'canc' ? 'Cancelado' : 'No respondió', r.reason || '', r.module]));
  };
  const handleCierre = async () => {
    if (!user) return;
    const today = new Date().toISOString().split('T')[0];
    const { error } = await supabase.from('daily_reports').insert({ operator_id: user.id, report_date: today, report_type: 'cierre',
      data: { confirmados: counter.conf, cancelados: counter.canc, no_respondio: counter.noresp, total_gestionados: total, tasa_confirmacion: tasa, pendientes_manana: pendLeft } });
    if (error) toast.error(error.code === '23505' ? 'Ya enviaste el cierre de hoy' : 'Error');
    else toast.success('Cierre enviado correctamente');
  };
  const copiarResumen = () => {
    navigator.clipboard.writeText(`Cierre — ${formatDateES(new Date().toISOString().split('T')[0])}\n\nConfirmados: ${counter.conf}\nCancelados: ${counter.canc}\nNo respondió: ${counter.noresp}\nTasa: ${tasa}%\nPendientes: ${pendLeft}\nTotal: ${total}`)
      .then(() => toast.success('Copiado al portapapeles'));
  };
  const enviarWA = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(`Cierre — ${formatDateES(new Date().toISOString().split('T')[0])}\n\nConf: ${counter.conf} | Canc: ${counter.canc} | N/R: ${counter.noresp}\nTotal: ${total} | Tasa: ${tasa}%\nPendientes: ${pendLeft}`)}`, '_blank');
  };

  const tickStyle = { fontSize: 10, fill: 'hsl(var(--muted-foreground))' };
  const tooltipStyle = { backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '10px', fontSize: '12px' };
  const COLORS = ['hsl(var(--blue))', 'hsl(var(--green))', 'hsl(var(--orange))', 'hsl(var(--red))', 'hsl(var(--purple))', 'hsl(var(--cyan))', 'hsl(var(--muted-foreground))'];
  const tasaColor = tasa >= 80 ? 'text-green' : tasa >= 60 ? 'text-orange' : 'text-red';
  const tasaStroke = tasa >= 80 ? 'hsl(var(--green))' : tasa >= 60 ? 'hsl(var(--orange))' : 'hsl(var(--red))';

  return (
    <div className="max-w-6xl mx-auto">
      {/* Period & actions */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex gap-1.5">
          {[{ n: 7, l: '7d' }, { n: 15, l: '15d' }, { n: 30, l: '30d' }].map(p => (
            <button key={p.n} onClick={() => setPeriod(p.n)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                period === p.n ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'
              }`}>{p.l}</button>
          ))}
        </div>
        <div className="flex gap-1.5">
          <button onClick={exportarResultadosHoy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-muted-foreground text-xs font-medium hover:text-foreground">
            <Download size={12} /> CSV Hoy
          </button>
          <button onClick={exportarHistorico} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-muted-foreground text-xs font-medium hover:text-foreground">
            <Download size={12} /> Histórico
          </button>
        </div>
      </div>

      {/* Top: Rate gauge + KPIs */}
      <motion.div {...fadeUp(0.05)} className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-5">
        <div className="bg-card rounded-xl border border-border p-6 flex flex-col items-center justify-center md:col-span-1">
          <div className="relative w-28 h-28 mb-2">
            <svg viewBox="0 0 120 120" className="-rotate-90 w-full h-full">
              <circle cx="60" cy="60" r="50" fill="none" strokeWidth="8" stroke="hsl(var(--border))" />
              <circle cx="60" cy="60" r="50" fill="none" strokeWidth="8" stroke={tasaStroke} strokeLinecap="round"
                strokeDasharray={314} strokeDashoffset={314 * (1 - tasa / 100)} className="transition-all duration-700" />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className={`font-mono text-2xl font-bold ${tasaColor}`}>{tasa}%</span>
            </div>
          </div>
          <div className="text-xs text-muted-foreground font-medium">Tasa confirmación</div>
        </div>

        <div className="md:col-span-4 grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'Confirmados', value: counter.conf, color: 'text-green', pct: total > 0 ? Math.round(counter.conf / total * 100) + '%' : '—' },
            { label: 'Cancelados', value: counter.canc, color: 'text-red', pct: total > 0 ? Math.round(counter.canc / total * 100) + '%' : '—' },
            { label: 'No respondió', value: counter.noresp, color: 'text-muted-foreground', pct: '' },
            { label: 'Total pedidos', value: allOrders.length, color: 'text-foreground', pct: `${pendLeft} pend.` },
          ].map(k => (
            <div key={k.label} className="bg-card rounded-xl border border-border p-4">
              <div className="text-xs text-muted-foreground font-medium mb-1">{k.label}</div>
              <div className={`font-mono text-2xl font-bold ${k.color}`}>{k.value}</div>
              {k.pct && <div className="text-[10px] text-muted-foreground mt-1">{k.pct}</div>}
            </div>
          ))}
        </div>
      </motion.div>

      {/* Charts */}
      <motion.div {...fadeUp(0.12)} className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
        <div className="bg-card rounded-xl border border-border p-5">
          <h3 className="text-sm font-semibold text-foreground mb-4">Tasa de confirmación</h3>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                <defs>
                  <linearGradient id="tGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--blue))" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="hsl(var(--blue))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="date" tick={tickStyle} axisLine={false} tickLine={false} />
                <YAxis domain={[0, 100]} tick={tickStyle} axisLine={false} tickLine={false} unit="%" />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${v}%`, 'Tasa']} />
                <Area type="monotone" dataKey="tasa" stroke="hsl(var(--blue))" strokeWidth={2} fill="url(#tGrad)" dot={{ r: 2.5, fill: 'hsl(var(--blue))', strokeWidth: 0 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-card rounded-xl border border-border p-5">
          <h3 className="text-sm font-semibold text-foreground mb-4">Gestiones por día</h3>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="date" tick={tickStyle} axisLine={false} tickLine={false} />
                <YAxis tick={tickStyle} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '6px' }} formatter={(v: string) => v === 'conf' ? 'Conf.' : v === 'canc' ? 'Canc.' : 'N/R'} />
                <Bar dataKey="conf" stackId="a" fill="hsl(var(--green))" name="conf" />
                <Bar dataKey="canc" stackId="a" fill="hsl(var(--red))" name="canc" />
                <Bar dataKey="noresp" stackId="a" fill="hsl(var(--muted-foreground))" radius={[3, 3, 0, 0]} name="noresp" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </motion.div>

      {/* Products row */}
      {prods.length > 0 && (
        <motion.div {...fadeUp(0.18)} className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-5">
          <div className="md:col-span-2 bg-card rounded-xl border border-border p-5">
            <h3 className="text-sm font-semibold text-foreground mb-4">Distribución por producto</h3>
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={(() => {
                    const top = prods.slice(0, 6).map(([n, d]) => ({ name: truncate(n, 14), value: d.total }));
                    const other = prods.slice(6).reduce((s, [, d]) => s + d.total, 0);
                    if (other > 0) top.push({ name: 'Otros', value: other });
                    return top;
                  })()} cx="50%" cy="50%" innerRadius={40} outerRadius={72} paddingAngle={2} dataKey="value" stroke="none">
                    {prods.slice(0, 7).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => [`${v}`, n]} />
                  <Legend wrapperStyle={{ fontSize: '10px' }} layout="vertical" align="right" verticalAlign="middle" />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="md:col-span-3 bg-card rounded-xl border border-border overflow-hidden">
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-sm font-semibold text-foreground">Detalle por producto</h3>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground text-[10px] uppercase tracking-wider border-b border-border">
                  <th className="text-left px-5 py-2.5 font-medium">Producto</th>
                  <th className="px-3 py-2.5 font-medium">Total</th>
                  <th className="px-3 py-2.5 font-medium">Entreg.</th>
                  <th className="px-3 py-2.5 font-medium">Canc.</th>
                  <th className="px-3 py-2.5 font-medium">Nov.</th>
                  <th className="px-3 py-2.5 font-medium">Efect.</th>
                </tr>
              </thead>
              <tbody>
                {prods.map(([name, d]) => {
                  const efect = d.total > 0 ? Math.round(d.entreg / d.total * 100) : 0;
                  const ec = efect >= 55 ? 'text-green' : efect >= 40 ? 'text-orange' : 'text-red';
                  return (
                    <tr key={name} className="border-b border-border last:border-0 hover:bg-secondary/30">
                      <td className="px-5 py-2.5 font-medium truncate max-w-[160px]">{truncate(name, 22)}</td>
                      <td className="px-3 py-2.5 text-center font-mono">{d.total}</td>
                      <td className="px-3 py-2.5 text-center font-mono text-green">{d.entreg}</td>
                      <td className="px-3 py-2.5 text-center font-mono text-red">{d.canc}</td>
                      <td className="px-3 py-2.5 text-center font-mono text-orange">{d.nov}</td>
                      <td className={`px-3 py-2.5 text-center font-mono font-bold ${ec}`}>{efect}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </motion.div>
      )}

      {/* Cierre */}
      <motion.div {...fadeUp(0.24)} className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Cierre del día</h3>
            <p className="text-xs text-muted-foreground">{formatDateES(new Date().toISOString().split('T')[0])}</p>
          </div>
        </div>
        <div className="p-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            {[
              { icon: CheckCircle2, label: 'Confirmados', value: counter.conf, color: 'text-green', iconColor: 'text-green' },
              { icon: XCircle, label: 'Cancelados', value: counter.canc, color: 'text-red', iconColor: 'text-red' },
              { icon: PhoneOff, label: 'No respondió', value: counter.noresp, color: 'text-muted-foreground', iconColor: 'text-muted-foreground' },
              { icon: Clock, label: 'Pendientes', value: pendLeft, color: 'text-orange', iconColor: 'text-orange' },
            ].map(item => {
              const Icon = item.icon;
              return (
                <div key={item.label} className="flex items-center gap-3 p-3 rounded-lg bg-secondary/50">
                  <Icon size={20} className={item.iconColor} />
                  <div>
                    <div className={`font-mono text-lg font-bold ${item.color}`}>{item.value}</div>
                    <div className="text-[10px] text-muted-foreground">{item.label}</div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={handleCierre} className="flex-1 min-w-[120px] inline-flex items-center justify-center gap-2 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 active:scale-[0.98] transition-all">
              <Send size={14} /> Enviar cierre
            </button>
            <button onClick={copiarResumen} className="inline-flex items-center gap-2 py-2.5 px-4 rounded-lg bg-secondary text-foreground font-medium text-sm hover:bg-secondary/80">
              <Copy size={14} /> Copiar
            </button>
            <button onClick={enviarWA} className="inline-flex items-center gap-2 py-2.5 px-4 rounded-lg bg-green/10 text-green border border-green/15 font-medium text-sm hover:bg-green/15">
              <MessageSquare size={14} /> WhatsApp
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
