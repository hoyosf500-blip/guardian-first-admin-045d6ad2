import { useOrders } from '@/contexts/OrderContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { truncate, formatDateES } from '@/lib/orderUtils';
import { useState, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  Area, AreaChart
} from 'recharts';

interface DailyResult {
  result_date: string;
  result: string;
}

/* ─── Reusable Card Shell ─── */
function DashCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-card rounded-xl border border-border shadow-sm ${className}`}>
      {children}
    </div>
  );
}

function CardHeader({ icon, title, action }: { icon: string; title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-5 pt-4 pb-2">
      <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
        <span>{icon}</span>{title}
      </h3>
      {action}
    </div>
  );
}

/* ─── KPI Stat ─── */
function StatCard({ value, label, color, sub }: { value: number | string; label: string; color: string; sub?: string }) {
  return (
    <DashCard className="p-4">
      <div className={`font-mono text-3xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-muted-foreground font-medium mt-1">{label}</div>
      {sub && <div className="text-[10px] text-muted-foreground/60 mt-0.5">{sub}</div>}
    </DashCard>
  );
}

export default function DashboardTab() {
  const { allOrders, counter, workQueue } = useOrders();
  const { user } = useAuth();
  const [period, setPeriod] = useState(7);
  const [historyData, setHistoryData] = useState<DailyResult[]>([]);

  useEffect(() => {
    if (!user) return;
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const sinceStr = since.toISOString().split('T')[0];
    supabase.from('order_results')
      .select('result_date, result')
      .eq('operator_id', user.id)
      .gte('result_date', sinceStr)
      .order('result_date', { ascending: true })
      .then(({ data }) => { if (data) setHistoryData(data); });
  }, [user]);

  const chartData = useMemo(() => {
    const since = new Date();
    since.setDate(since.getDate() - period);
    const sinceStr = since.toISOString().split('T')[0];
    const filtered = historyData.filter(r => r.result_date >= sinceStr);
    const byDay: Record<string, { conf: number; canc: number; noresp: number }> = {};
    for (let i = 0; i < period; i++) {
      const d = new Date();
      d.setDate(d.getDate() - (period - 1 - i));
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
        ...d, tasa: t > 0 ? Math.round(d.conf / t * 100) : 0, total: t,
      };
    });
  }, [historyData, period]);

  const total = counter.conf + counter.canc + counter.noresp;
  const tasa = total > 0 ? Math.round(counter.conf / total * 100) : 0;

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
  const pendLeft = workQueue.filter(o => !o.result).length;

  // ─── Export helpers ───
  const downloadCsv = (filename: string, headers: string[], rows: string[][]) => {
    const bom = '\uFEFF';
    const csv = bom + [headers.join(','), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    toast.success('📥 CSV descargado');
  };

  const exportarResultadosHoy = () => {
    const today = new Date().toISOString().split('T')[0];
    const managed = workQueue.filter(o => o.result);
    if (!managed.length) { toast.error('No hay resultados hoy'); return; }
    downloadCsv(`resultados_${today}.csv`,
      ['Teléfono', 'Nombre', 'Producto', 'Ciudad', 'Resultado', 'Razón', 'Valor'],
      managed.map(o => [o.phone, o.nombre, o.producto, o.ciudad,
        o.result === 'conf' ? 'Confirmado' : o.result === 'canc' ? 'Cancelado' : 'No respondió',
        o.reason || '', String(o.valor)])
    );
  };

  const exportarHistorico = async () => {
    if (!user) return;
    const since = new Date(); since.setDate(since.getDate() - period);
    const sinceStr = since.toISOString().split('T')[0];
    const { data, error } = await supabase.from('order_results')
      .select('result_date, result_time, phone, result, reason, module')
      .eq('operator_id', user.id).gte('result_date', sinceStr)
      .order('result_date', { ascending: false });
    if (error || !data?.length) { toast.error(error ? 'Error consultando' : 'Sin datos en el período'); return; }
    downloadCsv(`historico_${sinceStr}_a_${new Date().toISOString().split('T')[0]}.csv`,
      ['Fecha', 'Hora', 'Teléfono', 'Resultado', 'Razón', 'Módulo'],
      data.map(r => [r.result_date, r.result_time || '', r.phone,
        r.result === 'conf' ? 'Confirmado' : r.result === 'canc' ? 'Cancelado' : 'No respondió',
        r.reason || '', r.module])
    );
  };

  const handleCierre = async () => {
    if (!user) return;
    const today = new Date().toISOString().split('T')[0];
    const { error } = await supabase.from('daily_reports').insert({
      operator_id: user.id, report_date: today, report_type: 'cierre',
      data: { confirmados: counter.conf, cancelados: counter.canc, no_respondio: counter.noresp,
        total_gestionados: total, tasa_confirmacion: tasa, pendientes_manana: pendLeft }
    });
    if (error) { toast.error(error.code === '23505' ? '⚠️ Ya enviaste el cierre de hoy' : 'Error enviando cierre'); }
    else { toast.success('✅ Cierre enviado'); }
  };

  const copiarResumen = () => {
    const today = new Date().toISOString().split('T')[0];
    navigator.clipboard.writeText(
      `📊 *Cierre — ${formatDateES(today)}*\n\n✅ Confirmados: ${counter.conf}\n❌ Cancelados: ${counter.canc}\n📵 No respondió: ${counter.noresp}\n📈 Tasa: ${tasa}%\n⏳ Pendientes: ${pendLeft}\n🎯 *Total: ${total}*`
    ).then(() => toast.success('📋 Copiado'));
  };

  const enviarWA = () => {
    const msg = encodeURIComponent(`📊 *Cierre — ${formatDateES(new Date().toISOString().split('T')[0])}*\n\n✅ ${counter.conf} | ❌ ${counter.canc} | 📵 ${counter.noresp}\n📊 Total: ${total} | Tasa: ${tasa}%\n⏳ Pendientes: ${pendLeft}`);
    window.open(`https://wa.me/?text=${msg}`, '_blank');
  };

  const tickStyle = { fontSize: 10, fill: 'hsl(var(--muted-foreground))' };
  const tooltipStyle = {
    backgroundColor: 'hsl(var(--card))',
    border: '1px solid hsl(var(--border))',
    borderRadius: '10px',
    fontSize: '12px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
  };

  const DONUT_COLORS = [
    'hsl(var(--cyan))', 'hsl(var(--green))', 'hsl(var(--orange))',
    'hsl(var(--red))', 'hsl(var(--purple))', 'hsl(var(--blue))',
    'hsl(var(--muted-foreground))'
  ];

  const tasaRing = tasa >= 80 ? 'text-green' : tasa >= 60 ? 'text-orange' : 'text-red';
  const tasaRingStroke = tasa >= 80 ? 'hsl(var(--green))' : tasa >= 60 ? 'hsl(var(--orange))' : 'hsl(var(--red))';

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 pt-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Análisis de rendimiento</p>
        </div>
        <div className="flex gap-1.5">
          {[{ n: 7, l: '7d' }, { n: 15, l: '15d' }, { n: 30, l: '30d' }].map(p => (
            <button key={p.n} onClick={() => setPeriod(p.n)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                period === p.n
                  ? 'bg-foreground text-background shadow-sm'
                  : 'bg-secondary text-muted-foreground hover:bg-secondary/80'
              }`}>
              {p.l}
            </button>
          ))}
        </div>
      </div>

      {/* Top row: Tasa ring + KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-4">
        {/* Tasa gauge */}
        <DashCard className="md:col-span-1 p-5 flex flex-col items-center justify-center">
          <div className="relative w-28 h-28">
            <svg viewBox="0 0 120 120" className="-rotate-90 w-full h-full">
              <circle cx="60" cy="60" r="52" fill="none" strokeWidth="10"
                stroke="hsl(var(--secondary))" />
              <circle cx="60" cy="60" r="52" fill="none" strokeWidth="10"
                stroke={tasaRingStroke} strokeLinecap="round"
                strokeDasharray={326.7} strokeDashoffset={326.7 * (1 - tasa / 100)}
                className="transition-all duration-700" />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className={`font-mono text-2xl font-bold ${tasaRing}`}>{tasa}%</span>
            </div>
          </div>
          <div className="text-xs text-muted-foreground mt-2 font-medium text-center">Tasa de confirmación</div>
        </DashCard>

        {/* KPI grid */}
        <div className="md:col-span-4 grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard value={counter.conf} label="Confirmados" color="text-green" sub={`${total > 0 ? Math.round(counter.conf / total * 100) : 0}% del total`} />
          <StatCard value={counter.canc} label="Cancelados" color="text-red" sub={`${total > 0 ? Math.round(counter.canc / total * 100) : 0}% del total`} />
          <StatCard value={counter.noresp} label="No respondió" color="text-muted-foreground" />
          <StatCard value={allOrders.length} label="Total pedidos" color="text-cyan" sub={`${pendLeft} pendientes`} />
        </div>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        {/* Line chart – Tasa diaria */}
        <DashCard>
          <CardHeader icon="📈" title="Tasa de confirmación" />
          <div className="px-3 pb-4 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
                <defs>
                  <linearGradient id="tasaGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--cyan))" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="hsl(var(--cyan))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="date" tick={tickStyle} axisLine={false} tickLine={false} />
                <YAxis domain={[0, 100]} tick={tickStyle} axisLine={false} tickLine={false} unit="%" />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${v}%`, 'Tasa']} />
                <Area type="monotone" dataKey="tasa" stroke="hsl(var(--cyan))" strokeWidth={2.5}
                  fill="url(#tasaGrad)" dot={{ r: 3, fill: 'hsl(var(--cyan))', strokeWidth: 0 }} activeDot={{ r: 5 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </DashCard>

        {/* Stacked bar – Gestiones */}
        <DashCard>
          <CardHeader icon="📊" title="Gestiones por día" />
          <div className="px-3 pb-4 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="date" tick={tickStyle} axisLine={false} tickLine={false} />
                <YAxis tick={tickStyle} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }}
                  formatter={(v: string) => v === 'conf' ? 'Confirmados' : v === 'canc' ? 'Cancelados' : 'No respondió'} />
                <Bar dataKey="conf" stackId="a" fill="hsl(var(--green))" radius={[0, 0, 0, 0]} name="conf" />
                <Bar dataKey="canc" stackId="a" fill="hsl(var(--red))" name="canc" />
                <Bar dataKey="noresp" stackId="a" fill="hsl(var(--muted-foreground))" radius={[3, 3, 0, 0]} name="noresp" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </DashCard>
      </div>

      {/* Bottom row: Donut + Product table */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-4">
        {/* Donut */}
        {prods.length > 0 && (() => {
          const topProds = prods.slice(0, 6);
          const otherTotal = prods.slice(6).reduce((s, [, d]) => s + d.total, 0);
          const pieData = topProds.map(([name, d]) => ({ name: truncate(name, 15), value: d.total }));
          if (otherTotal > 0) pieData.push({ name: 'Otros', value: otherTotal });
          return (
            <DashCard className="md:col-span-2">
              <CardHeader icon="🍩" title="Por producto" />
              <div className="px-3 pb-4 h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} cx="50%" cy="50%" innerRadius={45} outerRadius={75}
                      paddingAngle={3} dataKey="value" stroke="none">
                      {pieData.map((_, i) => <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => [`${v} pedidos`, n]} />
                    <Legend wrapperStyle={{ fontSize: '10px' }} layout="vertical" align="right" verticalAlign="middle" />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </DashCard>
          );
        })()}

        {/* Product table */}
        {prods.length > 0 && (
          <DashCard className={prods.length > 0 ? 'md:col-span-3' : 'md:col-span-5'}>
            <CardHeader icon="📦" title="Detalle por producto" />
            <div className="px-5 pb-4 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground text-[10px] uppercase tracking-wider border-b border-border">
                    <th className="text-left pb-2.5 pr-2 font-semibold">Producto</th>
                    <th className="pb-2.5 px-2 font-semibold">Total</th>
                    <th className="pb-2.5 px-2 font-semibold">Entreg.</th>
                    <th className="pb-2.5 px-2 font-semibold">Canc.</th>
                    <th className="pb-2.5 px-2 font-semibold">Nov.</th>
                    <th className="pb-2.5 pl-2 font-semibold">Efect.</th>
                  </tr>
                </thead>
                <tbody>
                  {prods.map(([name, d]) => {
                    const efect = d.total > 0 ? Math.round(d.entreg / d.total * 100) : 0;
                    const ec = efect >= 55 ? 'text-green' : efect >= 40 ? 'text-orange' : 'text-red';
                    return (
                      <tr key={name} className="border-b border-border/50 last:border-0 hover:bg-secondary/30 transition-colors">
                        <td className="py-2.5 pr-2 font-medium truncate max-w-[140px]">{truncate(name, 22)}</td>
                        <td className="py-2.5 px-2 text-center font-mono">{d.total}</td>
                        <td className="py-2.5 px-2 text-center font-mono text-green">{d.entreg}</td>
                        <td className="py-2.5 px-2 text-center font-mono text-red">{d.canc}</td>
                        <td className="py-2.5 px-2 text-center font-mono text-orange">{d.nov}</td>
                        <td className={`py-2.5 pl-2 text-center font-mono font-bold ${ec}`}>{efect}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </DashCard>
        )}
      </div>

      {/* Cierre del día */}
      <DashCard className="mb-4">
        <CardHeader icon="📋" title="Cierre del día" action={
          <span className="text-xs text-muted-foreground">{formatDateES(new Date().toISOString().split('T')[0])}</span>
        } />
        <div className="px-5 pb-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            {[
              { label: 'Confirmados', value: counter.conf, color: 'text-green', icon: '✅' },
              { label: 'Cancelados', value: counter.canc, color: 'text-red', icon: '❌' },
              { label: 'No respondió', value: counter.noresp, color: 'text-muted-foreground', icon: '📵' },
              { label: 'Pendientes', value: pendLeft, color: 'text-orange', icon: '⏳' },
            ].map(item => (
              <div key={item.label} className="flex items-center gap-3 p-3 rounded-lg bg-secondary/50">
                <span className="text-lg">{item.icon}</span>
                <div>
                  <div className={`font-mono text-lg font-bold ${item.color}`}>{item.value}</div>
                  <div className="text-[10px] text-muted-foreground font-medium">{item.label}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <button onClick={handleCierre}
              className="flex-1 min-w-[100px] py-2.5 rounded-lg bg-foreground text-background font-semibold text-sm hover:opacity-90 active:scale-[0.97] transition-all">
              📤 Enviar cierre
            </button>
            <button onClick={copiarResumen}
              className="py-2.5 px-4 rounded-lg bg-secondary text-foreground font-semibold text-sm hover:bg-secondary/80 active:scale-[0.97] transition-all">
              📋 Copiar
            </button>
            <button onClick={enviarWA}
              className="py-2.5 px-4 rounded-lg bg-green/10 text-green border border-green/20 font-semibold text-sm hover:bg-green/15 active:scale-[0.97] transition-all">
              💬 WhatsApp
            </button>
            <button onClick={exportarResultadosHoy}
              className="py-2.5 px-4 rounded-lg bg-secondary text-foreground font-semibold text-sm hover:bg-secondary/80 active:scale-[0.97] transition-all">
              📥 CSV Hoy
            </button>
            <button onClick={exportarHistorico}
              className="py-2.5 px-4 rounded-lg bg-secondary text-foreground font-semibold text-sm hover:bg-secondary/80 active:scale-[0.97] transition-all">
              📊 Histórico ({period}d)
            </button>
          </div>
        </div>
      </DashCard>
    </div>
  );
}
