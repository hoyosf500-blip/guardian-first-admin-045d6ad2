import { useOrders } from '@/contexts/OrderContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { truncate, formatDateES } from '@/lib/orderUtils';
import { useState, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2, XCircle, PhoneOff, Clock, Send, Copy, MessageSquare,
  Download, TrendingUp, TrendingDown, Minus, Package, ChevronDown,
  BarChart3, Activity, Layers
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { motion } from 'framer-motion';

interface DailyResult { result_date: string; result: string; }

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

function MiniSparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const w = 64, h = 24;
  const points = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`).join(' ');
  return (
    <svg width={w} height={h} className="opacity-60">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export default function DashboardTab() {
  const { allOrders, counter, workQueue } = useOrders();
  const { user } = useAuth();
  const [period, setPeriod] = useState(7);
  const [historyData, setHistoryData] = useState<DailyResult[]>([]);
  const [actionsOpen, setActionsOpen] = useState(false);

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
      return {
        date: new Date(date + 'T12:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short' }),
        ...d, tasa: t > 0 ? Math.round(d.conf / t * 100) : 0, total: t
      };
    });
  }, [historyData, period]);

  // Yesterday comparison
  const yesterdayData = useMemo(() => {
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const yd = yesterday.toISOString().split('T')[0];
    const yResults = historyData.filter(r => r.result_date === yd);
    const conf = yResults.filter(r => r.result === 'conf').length;
    const canc = yResults.filter(r => r.result === 'canc').length;
    const noresp = yResults.filter(r => r.result !== 'conf' && r.result !== 'canc').length;
    const total = conf + canc + noresp;
    return { conf, canc, noresp, total, tasa: total > 0 ? Math.round(conf / total * 100) : 0 };
  }, [historyData]);

  const sparkData = useMemo(() => {
    const last7 = chartData.slice(-7);
    return {
      conf: last7.map(d => d.conf),
      canc: last7.map(d => d.canc),
      total: last7.map(d => d.total),
    };
  }, [chartData]);

  const total = counter.conf + counter.canc + counter.noresp;
  const tasa = total > 0 ? Math.round(counter.conf / total * 100) : 0;
  const pendLeft = workQueue.filter(o => !o.result).length;

  const byProd: Record<string, { total: number; entreg: number; canc: number; nov: number }> = {};
  allOrders.forEach(o => {
    const p = o.producto || 'Sin producto';
    if (!byProd[p]) byProd[p] = { total: 0, entreg: 0, canc: 0, nov: 0 };
    byProd[p].total++;
    const e = (o.estado || '').toUpperCase();
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
  const tasaBg = tasa >= 80 ? 'bg-green/10' : tasa >= 60 ? 'bg-orange/10' : 'bg-red/10';

  function TrendBadge({ current, previous, suffix = '' }: { current: number; previous: number; suffix?: string }) {
    const diff = current - previous;
    if (diff === 0) return <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground"><Minus size={10} /> sin cambio</span>;
    const up = diff > 0;
    return (
      <span className={`inline-flex items-center gap-0.5 text-[10px] font-medium ${up ? 'text-green' : 'text-red'}`}>
        {up ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
        {up ? '+' : ''}{diff}{suffix} vs ayer
      </span>
    );
  }

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Buenos días';
    if (h < 18) return 'Buenas tardes';
    return 'Buenas noches';
  })();

  const hasData = total > 0 || allOrders.length > 0;

  return (
    <div className="max-w-6xl mx-auto">
      {/* Toolbar */}
      <motion.div {...fadeUp(0)} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{greeting}</h2>
          <p className="text-xs text-muted-foreground">{formatDateES(new Date().toISOString().split('T')[0])}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Period tabs */}
          <div className="inline-flex bg-secondary rounded-lg p-0.5">
            {[{ n: 7, l: '7d' }, { n: 15, l: '15d' }, { n: 30, l: '30d' }].map(p => (
              <button key={p.n} onClick={() => setPeriod(p.n)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  period === p.n ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}>{p.l}</button>
            ))}
          </div>
          <div className="h-5 w-px bg-border hidden sm:block" />
          {/* Action buttons */}
          <button onClick={exportarResultadosHoy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-muted-foreground text-xs font-medium hover:text-foreground transition-colors">
            <Download size={12} /> CSV
          </button>
          <button onClick={handleCierre} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity">
            <Send size={12} /> Enviar cierre
          </button>
          {/* More actions dropdown */}
          <div className="relative">
            <button onClick={() => setActionsOpen(!actionsOpen)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-secondary text-muted-foreground text-xs font-medium hover:text-foreground transition-colors">
              <ChevronDown size={12} className={`transition-transform ${actionsOpen ? 'rotate-180' : ''}`} />
            </button>
            {actionsOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setActionsOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 bg-card border border-border rounded-xl shadow-lg py-1 min-w-[160px]">
                  <button onClick={() => { exportarHistorico(); setActionsOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-foreground hover:bg-secondary transition-colors">
                    <Download size={13} /> Exportar histórico
                  </button>
                  <button onClick={() => { copiarResumen(); setActionsOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-foreground hover:bg-secondary transition-colors">
                    <Copy size={13} /> Copiar resumen
                  </button>
                  <button onClick={() => { enviarWA(); setActionsOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-green hover:bg-secondary transition-colors">
                    <MessageSquare size={13} /> Enviar por WhatsApp
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </motion.div>

      {!hasData ? (
        /* Empty state */
        <motion.div {...fadeUp(0.05)} className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-16 h-16 rounded-2xl bg-secondary flex items-center justify-center mb-4">
            <BarChart3 size={28} className="text-muted-foreground" />
          </div>
          <h3 className="text-base font-semibold text-foreground mb-1">Sin datos todavía</h3>
          <p className="text-sm text-muted-foreground max-w-xs">
            Sube un archivo Excel o comienza a gestionar pedidos para ver tus estadísticas aquí.
          </p>
        </motion.div>
      ) : (
        <>
          {/* Hero KPI + Compact KPIs */}
          <motion.div {...fadeUp(0.05)} className="grid grid-cols-1 md:grid-cols-12 gap-4 mb-5">
            {/* Hero: Tasa de confirmación */}
            <div className="md:col-span-4 bg-card rounded-xl border border-border p-5 flex items-center gap-5">
              <div className="relative w-20 h-20 flex-shrink-0">
                <svg viewBox="0 0 120 120" className="-rotate-90 w-full h-full">
                  <circle cx="60" cy="60" r="50" fill="none" strokeWidth="10" stroke="hsl(var(--border))" />
                  <circle cx="60" cy="60" r="50" fill="none" strokeWidth="10" stroke={tasaStroke} strokeLinecap="round"
                    strokeDasharray={314} strokeDashoffset={314 * (1 - tasa / 100)} className="transition-all duration-700" />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className={`font-mono text-xl font-bold ${tasaColor}`}>{tasa}%</span>
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-muted-foreground font-medium mb-0.5">Tasa de confirmación</div>
                <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-semibold ${tasaBg} ${tasaColor}`}>
                  {tasa >= 80 ? 'Excelente' : tasa >= 60 ? 'Aceptable' : 'Necesita mejorar'}
                </div>
                <div className="mt-1.5">
                  <TrendBadge current={tasa} previous={yesterdayData.tasa} suffix="%" />
                </div>
              </div>
            </div>

            {/* Compact KPIs */}
            {[
              { icon: CheckCircle2, label: 'Confirmados', value: counter.conf, prev: yesterdayData.conf, color: 'text-green', iconBg: 'bg-green/10', iconColor: 'text-green', spark: sparkData.conf, sparkColor: 'hsl(var(--green))' },
              { icon: XCircle, label: 'Cancelados', value: counter.canc, prev: yesterdayData.canc, color: 'text-red', iconBg: 'bg-red/10', iconColor: 'text-red', spark: sparkData.canc, sparkColor: 'hsl(var(--red))' },
              { icon: PhoneOff, label: 'No respondió', value: counter.noresp, prev: yesterdayData.noresp, color: 'text-muted-foreground', iconBg: 'bg-secondary', iconColor: 'text-muted-foreground', spark: [], sparkColor: '' },
              { icon: Package, label: 'Total pedidos', value: allOrders.length, prev: 0, color: 'text-foreground', iconBg: 'bg-blue/10', iconColor: 'text-blue', spark: sparkData.total, sparkColor: 'hsl(var(--blue))', extra: `${pendLeft} pendientes` },
            ].map((k, i) => {
              const Icon = k.icon;
              return (
                <div key={k.label} className="md:col-span-2 bg-card rounded-xl border border-border p-4 flex flex-col justify-between">
                  <div className="flex items-center justify-between mb-2">
                    <div className={`w-7 h-7 rounded-lg ${k.iconBg} flex items-center justify-center`}>
                      <Icon size={14} className={k.iconColor} />
                    </div>
                    {k.spark.length > 1 && <MiniSparkline data={k.spark} color={k.sparkColor} />}
                  </div>
                  <div>
                    <div className={`font-mono text-2xl font-bold ${k.color} leading-none`}>{k.value}</div>
                    <div className="text-[10px] text-muted-foreground mt-1">{k.label}</div>
                  </div>
                  <div className="mt-1.5">
                    {k.extra ? (
                      <span className="text-[10px] text-muted-foreground">{k.extra}</span>
                    ) : (
                      <TrendBadge current={k.value} previous={k.prev} />
                    )}
                  </div>
                </div>
              );
            })}
          </motion.div>

          {/* Charts */}
          <motion.div {...fadeUp(0.12)} className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
            <div className="bg-card rounded-xl border border-border p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Activity size={14} className="text-blue" /> Tasa de confirmación
                </h3>
              </div>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                    <defs>
                      <linearGradient id="tGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--blue))" stopOpacity={0.15} />
                        <stop offset="100%" stopColor="hsl(var(--blue))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="date" tick={tickStyle} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tick={tickStyle} axisLine={false} tickLine={false} unit="%" />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${v}%`, 'Tasa']} />
                    <Area type="monotone" dataKey="tasa" stroke="hsl(var(--blue))" strokeWidth={2} fill="url(#tGrad)" dot={{ r: 2, fill: 'hsl(var(--blue))', strokeWidth: 0 }} activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--card))' }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-card rounded-xl border border-border p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Layers size={14} className="text-green" /> Gestiones por día
                </h3>
              </div>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="date" tick={tickStyle} axisLine={false} tickLine={false} />
                    <YAxis tick={tickStyle} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '6px' }} formatter={(v: string) => v === 'conf' ? 'Confirmados' : v === 'canc' ? 'Cancelados' : 'No respondió'} />
                    <Bar dataKey="conf" stackId="a" fill="hsl(var(--green))" name="conf" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="canc" stackId="a" fill="hsl(var(--red))" name="canc" />
                    <Bar dataKey="noresp" stackId="a" fill="hsl(var(--muted-foreground))" radius={[3, 3, 0, 0]} name="noresp" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </motion.div>

          {/* Products */}
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
                <div className="overflow-x-auto">
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
                          <tr key={name} className="border-b border-border last:border-0 hover:bg-secondary/30 transition-colors">
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
              </div>
            </motion.div>
          )}

          {/* Cierre summary */}
          <motion.div {...fadeUp(0.24)} className="bg-card rounded-xl border border-border p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Resumen del día</h3>
                <p className="text-[10px] text-muted-foreground mt-0.5">{formatDateES(new Date().toISOString().split('T')[0])}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { icon: CheckCircle2, label: 'Confirmados', value: counter.conf, color: 'text-green', iconColor: 'text-green' },
                { icon: XCircle, label: 'Cancelados', value: counter.canc, color: 'text-red', iconColor: 'text-red' },
                { icon: PhoneOff, label: 'No respondió', value: counter.noresp, color: 'text-muted-foreground', iconColor: 'text-muted-foreground' },
                { icon: Clock, label: 'Pendientes', value: pendLeft, color: 'text-orange', iconColor: 'text-orange' },
              ].map(item => {
                const Icon = item.icon;
                return (
                  <div key={item.label} className="flex items-center gap-3 p-3 rounded-lg bg-secondary/50">
                    <Icon size={18} className={item.iconColor} />
                    <div>
                      <div className={`font-mono text-lg font-bold ${item.color}`}>{item.value}</div>
                      <div className="text-[10px] text-muted-foreground">{item.label}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        </>
      )}
    </div>
  );
}
