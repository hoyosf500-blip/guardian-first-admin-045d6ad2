import { useOrders } from '@/contexts/OrderContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { truncate, formatDateES } from '@/lib/orderUtils';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2, XCircle, PhoneOff, Clock, Send, Copy, MessageSquare,
  Download, TrendingUp, TrendingDown, Minus, Package, ChevronDown,
  BarChart3, Activity, Layers, CloudOff, CloudDownload, RefreshCw,
  Trophy, Users,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { motion } from 'framer-motion';

interface DailyResult { result_date: string; result: string; }
interface SyncLog { status: string; created_at: string; synced_count: number; error_message: string | null; source: string; }

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
  const [dbOrders, setDbOrders] = useState<Array<{ producto: string; estado: string; valor: number; ciudad: string; transportadora: string }>>([]);
  const [lastSync, setLastSync] = useState<SyncLog | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [resyncing, setResyncing] = useState(false);

  // F5: operator ranking — today's results for ALL operators
  interface OperatorStat { name: string; operatorId: string; conf: number; canc: number; noresp: number; total: number; tasa: number; }
  const [operatorRanking, setOperatorRanking] = useState<OperatorStat[]>([]);

  useEffect(() => {
    if (!user) return;
    const today = new Date().toLocaleDateString('en-CA');
    Promise.all([
      supabase.from('order_results').select('operator_id, result').eq('result_date', today),
      supabase.from('profiles').select('user_id, display_name'),
    ]).then(([resultsRes, profilesRes]) => {
      if (resultsRes.error || !resultsRes.data) return;
      const names: Record<string, string> = {};
      (profilesRes.data || []).forEach((p: { user_id: string; display_name: string }) => {
        names[p.user_id] = p.display_name;
      });
      const byOp: Record<string, { conf: number; canc: number; noresp: number }> = {};
      resultsRes.data.forEach((r: { operator_id: string; result: string }) => {
        if (!byOp[r.operator_id]) byOp[r.operator_id] = { conf: 0, canc: 0, noresp: 0 };
        if (r.result === 'conf') byOp[r.operator_id].conf++;
        else if (r.result === 'canc') byOp[r.operator_id].canc++;
        else byOp[r.operator_id].noresp++;
      });
      const ranking = Object.entries(byOp).map(([opId, s]) => {
        const total = s.conf + s.canc + s.noresp;
        return {
          operatorId: opId,
          name: names[opId] || 'Operador',
          ...s,
          total,
          tasa: total > 0 ? Math.round(s.conf / total * 100) : 0,
        };
      });
      ranking.sort((a, b) => b.total - a.total);
      setOperatorRanking(ranking);
    });
  }, [user, counter]); // re-fetch when counter changes (user marked something)

  // Load orders from DB for dashboard stats
  useEffect(() => {
    if (!user) return;
    const fetchAllOrders = async () => {
      const allData: Array<{ producto: string; estado: string; valor: number; ciudad: string; transportadora: string }> = [];
      let from = 0;
      const pageSize = 1000;
      while (true) {
        const { data, error } = await supabase.from('orders').select('producto, estado, valor, ciudad, transportadora')
          .order('created_at', { ascending: false })
          .range(from, from + pageSize - 1);
        if (error) { console.error('Error loading orders:', error.message); break; }
        if (!data || data.length === 0) break;
        allData.push(...data.map(o => ({
          producto: o.producto || 'Sin producto',
          estado: o.estado || '',
          valor: Number(o.valor) || 0,
          ciudad: o.ciudad || '',
          transportadora: o.transportadora || '',
        })));
        if (data.length < pageSize) break;
        from += pageSize;
      }
      setDbOrders(allData);
    };
    fetchAllOrders();
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const since = new Date(); since.setDate(since.getDate() - 30);
    supabase.from('order_results').select('result_date, result')
      .eq('operator_id', user.id).gte('result_date', since.toISOString().split('T')[0])
      .order('result_date', { ascending: true })
      .then(({ data, error }) => {
        if (error) console.error('Error loading history:', error.message);
        if (data) setHistoryData(data);
      });
  }, [user]);

  // Sync health — poll the latest entry in sync_logs every 30s. Only
  // admins have SELECT permission on sync_logs, so non-admin users just
  // see an empty response and the widget stays hidden. This is the first
  // line of defense against "Dropi se cayó y nadie se enteró" — if the
  // cron stops producing rows, the banner immediately turns red.
  const loadSyncLog = useCallback(async () => {
    const { data, error } = await supabase
      .from('sync_logs')
      .select('status, created_at, synced_count, error_message, source')
      .in('source', ['dropi-cron', 'dropi-sync'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) console.error('Error loading sync log:', error.message);
    if (data) setLastSync(data);
  }, []);

  useEffect(() => {
    if (!user) return;
    loadSyncLog();
    const poll = setInterval(loadSyncLog, 30 * 1000);
    const tick = setInterval(() => setNowTick(Date.now()), 15 * 1000);
    // Refresh immediately when tab becomes visible (Chrome Memory Saver / mobile
    // throttle intervals, so the age label can be stale when the operator returns).
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        setNowTick(Date.now());
        loadSyncLog();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(poll); clearInterval(tick); document.removeEventListener('visibilitychange', onVisible); };
  }, [user, loadSyncLog]);

  const resyncNow = async () => {
    if (resyncing) return;
    setResyncing(true);
    try {
      const { error } = await supabase.functions.invoke('dropi-sync', { body: {} });
      if (error) throw error;
      toast.success('Sincronización disparada');
      // Refresh the health card after a short delay so the new row appears
      setTimeout(loadSyncLog, 1500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error('Error disparando sync: ' + msg);
    } finally {
      setResyncing(false);
    }
  };

  const syncStatus = useMemo(() => {
    if (!lastSync) return null;
    const ageMs = nowTick - new Date(lastSync.created_at).getTime();
    const ageMin = Math.floor(ageMs / 60000);
    const isError = lastSync.status !== 'success';
    const healthy = !isError && ageMin < 15;
    const warning = !isError && ageMin >= 15 && ageMin < 60;
    const broken = isError || ageMin >= 60;
    const ageLabel = ageMin < 1 ? 'ahora' : ageMin < 60 ? `${ageMin}m` : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m`;
    return { ageMin, ageLabel, isError, healthy, warning, broken };
  }, [lastSync, nowTick]);

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

  // Memoized so downstream useMemo (statusBreakdown, prods) gets a stable reference.
  // Without this, every render creates a new array → defeats all memoization.
  const ordersForStats = useMemo(() =>
    allOrders.length > 0 ? allOrders.map(o => ({
      producto: o.producto || 'Sin producto', estado: o.estado || '', valor: o.valor, ciudad: o.ciudad, transportadora: o.transportadora
    })) : dbOrders,
  [allOrders, dbOrders]);

  const totalOrders = ordersForStats.length;

  const prods = useMemo(() => {
    const byProd: Record<string, { total: number; entreg: number; canc: number; nov: number }> = {};
    ordersForStats.forEach(o => {
      const p = o.producto || 'Sin producto';
      if (!byProd[p]) byProd[p] = { total: 0, entreg: 0, canc: 0, nov: 0 };
      byProd[p].total++;
      const e = (o.estado || '').toUpperCase();
      if (e.includes('ENTREGAD')) byProd[p].entreg++;
      else if (e.includes('CANCEL')) byProd[p].canc++;
      else if (e.includes('NOVEDAD')) byProd[p].nov++;
    });
    return Object.entries(byProd).sort((a, b) => b[1].total - a[1].total);
  }, [ordersForStats]);

  // Status breakdown from DB
  const statusBreakdown = useMemo(() => {
    const s = { entregados: 0, cancelados: 0, novedades: 0, oficina: 0, devoluciones: 0, transito: 0, pendientes: 0, otros: 0, valorTotal: 0, valorEntregado: 0 };
    ordersForStats.forEach(o => {
      const e = (o.estado || '').toUpperCase();
      s.valorTotal += o.valor;
      if (e.includes('ENTREGAD')) { s.entregados++; s.valorEntregado += o.valor; }
      else if (e.includes('CANCEL')) s.cancelados++;
      else if (e.includes('NOVEDAD') || e === 'INTENTO DE ENTREGA') s.novedades++;
      else if (e.includes('OFICINA') || e.includes('RECLAME')) s.oficina++;
      else if (e.includes('DEVOL')) s.devoluciones++;
      else if (e.includes('DESPACHAD') || e.includes('TRANSPORTE') || e.includes('REPARTO') || e.includes('DISTRIBUCION') || e === 'ADMITIDA' || e === 'EN DESPACHO') s.transito++;
      else if (e === 'PENDIENTE CONFIRMACION') s.pendientes++;
      else s.otros++;
    });
    return s;
  }, [ordersForStats]);

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

  const hasData = total > 0 || totalOrders > 0;

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

      {/* Sync health — only renders when we have at least one sync_logs row
          (i.e. the user is admin and the table is readable). Turns red if
          the cron hasn't produced a fresh entry in over an hour. */}
      {syncStatus && (
        <motion.div {...fadeUp(0.03)} className={`mb-5 flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border px-4 py-3 ${
          syncStatus.broken
            ? 'border-red/30 bg-red/10'
            : syncStatus.warning
              ? 'border-orange/30 bg-orange/10'
              : 'border-green/30 bg-green/10'
        }`}>
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
            syncStatus.broken ? 'bg-red/20' : syncStatus.warning ? 'bg-orange/20' : 'bg-green/20'
          }`}>
            {syncStatus.broken ? <CloudOff size={18} className="text-red" />
              : syncStatus.warning ? <Clock size={18} className="text-orange" />
              : <CloudDownload size={18} className="text-green" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-xs font-semibold ${
              syncStatus.broken ? 'text-red' : syncStatus.warning ? 'text-orange' : 'text-green'
            }`}>
              {syncStatus.broken
                ? (syncStatus.isError ? `Sync caído: ${lastSync?.error_message || 'error'}` : `Sin sincronización hace ${syncStatus.ageLabel}`)
                : syncStatus.warning
                  ? `Sincronizado hace ${syncStatus.ageLabel} (lento)`
                  : `Dropi sincronizado hace ${syncStatus.ageLabel}`}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              Fuente: {lastSync?.source} · {lastSync?.synced_count ?? 0} pedidos · {lastSync ? new Date(lastSync.created_at).toLocaleString('es-CO') : ''}
            </div>
          </div>
          <button
            onClick={resyncNow}
            disabled={resyncing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-card border border-border text-xs font-medium text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={resyncing ? 'animate-spin' : ''} />
            {resyncing ? 'Sincronizando...' : 'Forzar sync'}
          </button>
        </motion.div>
      )}

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
              { icon: CheckCircle2, label: 'Confirmados', value: counter.conf, prev: yesterdayData.conf, color: 'text-green', iconBg: 'bg-green/20', iconColor: 'text-green', spark: sparkData.conf, sparkColor: 'hsl(var(--green))' },
              { icon: XCircle, label: 'Cancelados', value: counter.canc, prev: yesterdayData.canc, color: 'text-red', iconBg: 'bg-red/20', iconColor: 'text-red', spark: sparkData.canc, sparkColor: 'hsl(var(--red))' },
              { icon: PhoneOff, label: 'No respondió', value: counter.noresp, prev: yesterdayData.noresp, color: 'text-foreground', iconBg: 'bg-secondary', iconColor: 'text-muted-foreground', spark: [], sparkColor: '' },
              { icon: Package, label: 'Total pedidos', value: totalOrders, prev: 0, color: 'text-foreground', iconBg: 'bg-blue/20', iconColor: 'text-blue', spark: sparkData.total, sparkColor: 'hsl(var(--blue))', extra: `${statusBreakdown.pendientes} pendientes` },
            ].map((k, i) => {
              const Icon = k.icon;
              const isZero = k.value === 0;
              return (
                <div
                  key={k.label}
                  className={`md:col-span-2 bg-card rounded-xl border p-4 flex flex-col justify-between transition-opacity ${isZero ? 'border-border/60 opacity-80' : 'border-border'}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className={`w-7 h-7 rounded-lg ${k.iconBg} flex items-center justify-center ring-1 ring-inset ring-border/30`}>
                      <Icon size={14} className={k.iconColor} />
                    </div>
                    {k.spark.length > 1 && <MiniSparkline data={k.spark} color={k.sparkColor} />}
                  </div>
                  <div>
                    <div className={`font-mono text-2xl font-bold ${isZero ? 'text-muted-foreground' : k.color} leading-none tabular-nums`}>{k.value}</div>
                    <div className="text-xs font-medium text-foreground/80 mt-1.5">{k.label}</div>
                  </div>
                  <div className="mt-1.5">
                    {k.extra ? (
                      <span className="text-[11px] font-medium text-muted-foreground">{k.extra}</span>
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

          {/* F5: Operator ranking */}
          {operatorRanking.length > 1 && (
            <motion.div {...fadeUp(0.15)} className="bg-card rounded-xl border border-border overflow-hidden mb-5">
              <div className="px-5 py-4 border-b border-border flex items-center gap-2">
                <Users size={14} className="text-blue" />
                <h3 className="text-sm font-semibold text-foreground">Ranking del equipo hoy</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground text-[10px] uppercase tracking-wider border-b border-border">
                      <th className="px-5 py-2.5 text-left font-medium">#</th>
                      <th className="px-3 py-2.5 text-left font-medium">Operador(a)</th>
                      <th className="px-3 py-2.5 text-center font-medium">Conf.</th>
                      <th className="px-3 py-2.5 text-center font-medium">Canc.</th>
                      <th className="px-3 py-2.5 text-center font-medium">N/R</th>
                      <th className="px-3 py-2.5 text-center font-medium">Total</th>
                      <th className="px-3 py-2.5 text-center font-medium">Tasa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {operatorRanking.map((op, idx) => {
                      const isMe = op.operatorId === user?.id;
                      const tasaC = op.tasa >= 80 ? 'text-green' : op.tasa >= 60 ? 'text-orange' : 'text-red';
                      return (
                        <tr key={op.operatorId} className={`border-b border-border last:border-0 transition-colors ${isMe ? 'bg-primary/5' : 'hover:bg-secondary/30'}`}>
                          <td className="px-5 py-2.5 font-mono font-bold">
                            {idx === 0 ? <Trophy size={14} className="text-yellow-500 inline" /> : idx + 1}
                          </td>
                          <td className="px-3 py-2.5 font-medium">
                            {op.name}{isMe && <span className="ml-1.5 text-[10px] text-primary">(tú)</span>}
                          </td>
                          <td className="px-3 py-2.5 text-center font-mono text-green">{op.conf}</td>
                          <td className="px-3 py-2.5 text-center font-mono text-red">{op.canc}</td>
                          <td className="px-3 py-2.5 text-center font-mono text-muted-foreground">{op.noresp}</td>
                          <td className="px-3 py-2.5 text-center font-mono font-bold">{op.total}</td>
                          <td className={`px-3 py-2.5 text-center font-mono font-bold ${tasaC}`}>{op.tasa}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </motion.div>
          )}

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
