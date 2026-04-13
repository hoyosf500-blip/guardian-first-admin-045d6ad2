import { useOrders } from '@/contexts/OrderContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { truncate, formatDateES } from '@/lib/orderUtils';
import { useState, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer
} from 'recharts';

interface DailyResult {
  result_date: string;
  result: string;
}

export default function DashboardTab() {
  const { allOrders, counter, workQueue } = useOrders();
  const { user } = useAuth();
  const [period, setPeriod] = useState(7);
  const [historyData, setHistoryData] = useState<DailyResult[]>([]);

  // Fetch historical results
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
      .then(({ data }) => {
        if (data) setHistoryData(data);
      });
  }, [user]);

  // Build chart data
  const chartData = useMemo(() => {
    const since = new Date();
    since.setDate(since.getDate() - period);
    const sinceStr = since.toISOString().split('T')[0];

    const filtered = historyData.filter(r => r.result_date >= sinceStr);
    const byDay: Record<string, { conf: number; canc: number; noresp: number }> = {};

    // Fill all days in period
    for (let i = 0; i < period; i++) {
      const d = new Date();
      d.setDate(d.getDate() - (period - 1 - i));
      const key = d.toISOString().split('T')[0];
      byDay[key] = { conf: 0, canc: 0, noresp: 0 };
    }

    filtered.forEach(r => {
      if (!byDay[r.result_date]) byDay[r.result_date] = { conf: 0, canc: 0, noresp: 0 };
      if (r.result === 'conf') byDay[r.result_date].conf++;
      else if (r.result === 'canc') byDay[r.result_date].canc++;
      else byDay[r.result_date].noresp++;
    });

    return Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => {
        const total = d.conf + d.canc + d.noresp;
        const tasa = total > 0 ? Math.round(d.conf / total * 100) : 0;
        const label = new Date(date + 'T12:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
        return { date: label, ...d, tasa, total };
      });
  }, [historyData, period]);

  const total = counter.conf + counter.canc + counter.noresp;
  const tasa = total > 0 ? Math.round(counter.conf / total * 100) : 0;
  const tasaColor = tasa >= 80 ? 'text-green' : tasa >= 60 ? 'text-orange' : 'text-red';
  const tasaBorder = tasa >= 80 ? 'border-l-green' : tasa >= 60 ? 'border-l-orange' : 'border-l-red';

  // Product table
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

  const handleCierre = async () => {
    if (!user) return;
    const today = new Date().toISOString().split('T')[0];
    const { error } = await supabase.from('daily_reports').insert({
      operator_id: user.id,
      report_date: today,
      report_type: 'cierre',
      data: {
        confirmados: counter.conf,
        cancelados: counter.canc,
        no_respondio: counter.noresp,
        total_gestionados: total,
        tasa_confirmacion: tasa,
        pendientes_manana: pendLeft,
      }
    });
    if (error) {
      if (error.code === '23505') toast.error('⚠️ Ya enviaste el cierre de hoy');
      else toast.error('Error enviando cierre');
    } else {
      toast.success('✅ Cierre enviado');
    }
  };

  const copiarResumen = () => {
    const today = new Date().toISOString().split('T')[0];
    const r = `📊 *Cierre — ${formatDateES(today)}*\n\n📞 *Confirmación*\n✅ Confirmados: ${counter.conf}\n❌ Cancelados: ${counter.canc}\n📵 No respondió: ${counter.noresp}\n📈 Tasa: ${tasa}%\n⏳ Pendientes: ${pendLeft}\n\n🎯 *Total: ${total}*`;
    navigator.clipboard.writeText(r).then(() => toast.success('📋 Copiado'));
  };

  const enviarWA = () => {
    const msg = encodeURIComponent(`📊 *Cierre — ${formatDateES(new Date().toISOString().split('T')[0])}*\n\n✅ ${counter.conf} | ❌ ${counter.canc} | 📵 ${counter.noresp}\n📊 Total: ${total} | Tasa: ${tasa}%\n⏳ Pendientes: ${pendLeft}`);
    window.open(`https://wa.me/?text=${msg}`, '_blank');
  };

  const chartTickStyle = { fontSize: 10, fill: 'hsl(var(--muted-foreground))' };

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight">📊 Dashboard</h1>
          <div className="text-xs text-muted-foreground">Análisis de rendimiento</div>
        </div>
      </div>

      {/* Period filters */}
      <div className="flex gap-1.5 mb-4">
        {[{ n: 7, l: '7 días' }, { n: 15, l: '15 días' }, { n: 30, l: '30 días' }].map(p => (
          <button key={p.n} onClick={() => setPeriod(p.n)}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-all ${period === p.n ? 'bg-cyan/10 text-cyan border-cyan/30' : 'bg-muted/50 text-muted-foreground border-border'}`}>
            {p.l}
          </button>
        ))}
      </div>

      {/* Semáforo */}
      <div className={`bg-card border border-border rounded-lg p-5 text-center mb-3 border-l-4 ${tasaBorder}`}>
        <div className="text-[11px] text-muted-foreground uppercase font-bold tracking-wider">Tasa de Confirmación</div>
        <div className={`font-mono text-6xl font-bold my-2 leading-none ${tasaColor}`}>{tasa}%</div>
        <div className="text-xs text-muted-foreground">{counter.conf} confirmados de {total} gestionados</div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-3">
        <div className="bg-card border border-border rounded-lg p-3 text-center">
          <div className="font-mono text-2xl font-bold text-green">{counter.conf}</div>
          <div className="text-[10px] text-muted-foreground font-semibold uppercase">Confirmados</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-3 text-center">
          <div className="font-mono text-2xl font-bold text-red">{counter.canc}</div>
          <div className="text-[10px] text-muted-foreground font-semibold uppercase">Cancelados</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-3 text-center">
          <div className="font-mono text-2xl font-bold text-muted-foreground">{counter.noresp}</div>
          <div className="text-[10px] text-muted-foreground font-semibold uppercase">No respondió</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-3 text-center">
          <div className="font-mono text-2xl font-bold text-cyan">{allOrders.length}</div>
          <div className="text-[10px] text-muted-foreground font-semibold uppercase">Total pedidos</div>
        </div>
      </div>

      {/* Chart: Tasa de confirmación diaria (Line) */}
      <div className="bg-card border border-border rounded-lg p-4 mb-3">
        <h3 className="text-sm font-semibold text-muted-foreground mb-3">📈 Tasa de confirmación diaria</h3>
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tick={chartTickStyle} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 100]} tick={chartTickStyle} axisLine={false} tickLine={false} unit="%" />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
                formatter={(value: number) => [`${value}%`, 'Tasa']}
              />
              <Line
                type="monotone"
                dataKey="tasa"
                stroke="hsl(var(--cyan))"
                strokeWidth={2.5}
                dot={{ r: 3, fill: 'hsl(var(--cyan))' }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Chart: Gestiones por día (Stacked Bar) */}
      <div className="bg-card border border-border rounded-lg p-4 mb-3">
        <h3 className="text-sm font-semibold text-muted-foreground mb-3">📊 Gestiones por día</h3>
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tick={chartTickStyle} axisLine={false} tickLine={false} />
              <YAxis tick={chartTickStyle} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
              />
              <Legend
                wrapperStyle={{ fontSize: '11px' }}
                formatter={(value: string) =>
                  value === 'conf' ? 'Confirmados' : value === 'canc' ? 'Cancelados' : 'No respondió'
                }
              />
              <Bar dataKey="conf" stackId="a" fill="hsl(var(--green))" radius={[0, 0, 0, 0]} name="conf" />
              <Bar dataKey="canc" stackId="a" fill="hsl(var(--red))" name="canc" />
              <Bar dataKey="noresp" stackId="a" fill="hsl(var(--muted-foreground))" radius={[3, 3, 0, 0]} name="noresp" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Product table */}
      {prods.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-4 mb-3">
          <h3 className="text-sm font-semibold text-muted-foreground mb-3">📦 Por producto</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground text-[10px] uppercase tracking-wider">
                  <th className="text-left pb-2 pr-2">Producto</th>
                  <th className="pb-2 px-1">Total</th>
                  <th className="pb-2 px-1">✅</th>
                  <th className="pb-2 px-1">❌</th>
                  <th className="pb-2 px-1">⚠️</th>
                  <th className="pb-2 pl-1">Efect.</th>
                </tr>
              </thead>
              <tbody>
                {prods.map(([name, d]) => {
                  const efect = d.total > 0 ? Math.round(d.entreg / d.total * 100) : 0;
                  const ec = efect >= 55 ? 'text-green' : efect >= 40 ? 'text-orange' : 'text-red';
                  return (
                    <tr key={name} className="border-t border-border">
                      <td className="py-2 pr-2 font-semibold truncate max-w-[120px]">{truncate(name, 20)}</td>
                      <td className="py-2 px-1 text-center">{d.total}</td>
                      <td className="py-2 px-1 text-center text-green">{d.entreg}</td>
                      <td className="py-2 px-1 text-center text-red">{d.canc}</td>
                      <td className="py-2 px-1 text-center text-orange">{d.nov}</td>
                      <td className={`py-2 pl-1 text-center font-bold ${ec}`}>{efect}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Cierre */}
      <div className="bg-card border border-border rounded-lg p-4 border-l-[3px] border-l-cyan">
        <h3 className="text-sm font-bold mb-4">📊 Cierre del día</h3>
        <div className="space-y-2 mb-4">
          <div className="flex justify-between py-2 border-b border-border text-sm">
            <span className="text-muted-foreground">✅ Confirmados</span>
            <span className="font-semibold text-green">{counter.conf}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-border text-sm">
            <span className="text-muted-foreground">❌ Cancelados</span>
            <span className="font-semibold text-red">{counter.canc}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-border text-sm">
            <span className="text-muted-foreground">📵 No respondió</span>
            <span className="font-semibold">{counter.noresp}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-border text-sm">
            <span className="text-muted-foreground">⏳ Pendientes</span>
            <span className="font-semibold">{pendLeft}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={handleCierre} className="flex-1 py-3 rounded-lg bg-gradient-to-r from-cyan to-blue font-semibold text-primary-foreground text-sm active:scale-[0.97] transition-transform">📤 Enviar</button>
          <button onClick={copiarResumen} className="flex-1 py-3 rounded-lg bg-green/15 text-green border border-green/25 font-semibold text-sm active:scale-[0.97] transition-transform">📋 Copiar</button>
          <button onClick={enviarWA} className="flex-1 py-3 rounded-lg bg-green/15 text-green border border-green/25 font-semibold text-sm active:scale-[0.97] transition-transform">💬 WA</button>
        </div>
      </div>
    </div>
  );
}