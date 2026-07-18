import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { useOrders } from '@/contexts/OrderContext';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { supabase } from '@/integrations/supabase/client';
import { truncate, formatDateES } from '@/lib/orderUtils';
import { bogotaToday } from '@/lib/utils';
import { computeDailyCounter, computeDailyCounterByDay } from '@/lib/computeDailyCounter';
import { confRateBySample, CONF_TARGET_PCT } from '@/lib/confirmationRate';
import { TruncatedText } from '@/components/TruncatedText';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import { copyToClipboard } from '@/lib/clipboard';
import {
  CheckCircle2, XCircle, PhoneOff, Clock, Send, Copy, MessageSquare,
  Download, TrendingUp, TrendingDown, Minus, Package, ChevronDown,
  BarChart3, Activity, Layers, CloudOff, CloudDownload, RefreshCw,
  Trophy, Users, Calendar as CalendarIcon,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { motion } from 'framer-motion';
import { TiltCard, StatTile, CountUp, GaugeRing, RankRow } from '@/components/ui3d';

interface DailyResult { result_date: string; result: string; order_id: string | null; }
interface SyncLog { status: string; created_at: string; synced_count: number; error_message: string | null; source: string; }

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

export default function DashboardTab() {
  const { allOrders, counter, workQueue } = useOrders();
  const { user, profile } = useAuth();
  const { activeStoreId, isManagerOfActive } = useStore();
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

  // Audit M3: cancellation guards — evitan setState en componente desmontado.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const today = bogotaToday();
    // El scope por tienda lo resuelve la RPC server-side vía
    // _resolve_scope_store() (admin → su tienda activa). No pasamos p_store_id
    // para no depender de que la migration del parámetro esté aplicada (PGRST202).
    supabase.rpc('get_daily_operator_stats', { p_date: today }).then(({ data, error }) => {
      if (cancelled || error || !data) return;
      const ranking = (data as Array<{ operator_id: string; display_name: string; conf: number; canc: number; noresp: number }>)
        .map(r => {
          const total = Number(r.conf) + Number(r.canc) + Number(r.noresp);
          return {
            operatorId: r.operator_id,
            name: r.display_name || 'Operador',
            conf: Number(r.conf),
            canc: Number(r.canc),
            noresp: Number(r.noresp),
            total,
            // Tasa MADURA conf÷(conf+canc), igual que toda la app (no ÷total).
            tasa: confRateBySample(Number(r.conf), Number(r.canc)).tasa ?? 0,
          };
        });
      ranking.sort((a, b) => b.total - a.total);
      if (!cancelled) setOperatorRanking(ranking);
    });
    return () => { cancelled = true; };
  }, [user, counter]); // re-fetch when counter changes (user marked something)

  // Load orders from DB for dashboard stats (filtrado por tienda activa)
  useEffect(() => {
    if (!user || !activeStoreId) return;
    let cancelled = false;
    const fetchAllOrders = async () => {
      const allData: Array<{ producto: string; estado: string; valor: number; ciudad: string; transportadora: string }> = [];
      let from = 0;
      const pageSize = 1000;
      while (true) {
        if (cancelled) return;
        const { data, error } = await supabase.from('orders').select('producto, estado, valor, ciudad, transportadora')
          .eq('store_id', activeStoreId)
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
      if (!cancelled) setDbOrders(allData);
    };
    fetchAllOrders();
    return () => { cancelled = true; };
  }, [user, activeStoreId]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const since = new Date(); since.setDate(since.getDate() - 30);
    supabase.from('order_results').select('result_date, result, order_id')
      .eq('operator_id', user.id).gte('result_date', since.toISOString().split('T')[0])
      .order('result_date', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.error('Error loading history:', error.message);
        if (data) setHistoryData(data);
      });
    return () => { cancelled = true; };
  }, [user]);

  // Sync health — poll the latest entry in sync_logs every 30s. Only
  // admins have SELECT permission on sync_logs, so non-admin users just
  // see an empty response and the widget stays hidden. This is the first
  // line of defense against "Dropi se cayó y nadie se enteró" — if the
  // cron stops producing rows, the banner immediately turns red.
  const loadSyncLog = useCallback(async () => {
    if (!activeStoreId) return;
    const { data, error } = await supabase
      .from('sync_logs')
      .select('status, created_at, synced_count, error_message, source')
      .eq('store_id', activeStoreId)
      // 'dropi' (no 'dropi-sync'): la edge function dropi-sync escribe
      // source:'dropi' — NADA escribe 'dropi-sync'. El filtro viejo hacía
      // invisibles los syncs/fallos manuales para este chip de salud.
      .in('source', ['dropi-cron', 'dropi'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) console.error('Error loading sync log:', error.message);
    if (data) setLastSync(data);
  }, [activeStoreId]);

  // COST-2 2026-07-10: sync log 2 → 15 min, tick visual 30s → 2 min.
  useEffect(() => {
    if (!user) return;
    loadSyncLog();
    const stopPoll = pollWhenVisible(loadSyncLog, 15 * 60 * 1000, { runOnVisible: false });
    const stopTick = pollWhenVisible(() => setNowTick(Date.now()), 2 * 60 * 1000, { runOnVisible: false });
    return () => { stopPoll(); stopTick(); };
  }, [user, loadSyncLog]);

  const resyncNow = async () => {
    if (resyncing) return;
    if (!activeStoreId) { toast.error('Sin tienda activa'); return; }
    setResyncing(true);
    try {
      // dropi-sync ahora responde 200 con {rateLimited|error} en vez de colapsar
      // en el genérico "non-2xx". Leemos el body para mostrar la causa REAL:
      // throttle de Dropi (común en EC, alto volumen) → aviso, no error.
      const res = await supabase.functions.invoke('dropi-sync', { body: { store_id: activeStoreId } });
      if (res.error) throw res.error;
      const data = res.data as { rateLimited?: boolean; error?: string; message?: string } | null;
      if (data?.rateLimited) {
        toast.warning(data.message || 'Dropi está limitando las peticiones. El sync automático igual mantiene tus pedidos al día.');
      } else if (data?.error) {
        toast.error(data.error);
      } else {
        toast.success('Sincronización disparada');
      }
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

  const hoyISO = new Date().toISOString().split('T')[0];

  const chartData = useMemo(() => {
    // Generamos las N fechas (incluyendo hoy) y delegamos la dedup al
    // helper compartido — misma fuente de verdad que CounterBar y el RPC
    // operator_productivity_stats v20260505184140. Si la regla cambia, se
    // toca un solo lugar (computeDailyCounter) y el chart la hereda.
    const dates: string[] = [];
    for (let i = 0; i < period; i++) {
      const d = new Date(); d.setDate(d.getDate() - (period - 1 - i));
      dates.push(d.toISOString().split('T')[0]);
    }
    const byDay = computeDailyCounterByDay(historyData, dates);
    return dates.map(date => {
      const d = byDay[date];
      const t = d.conf + d.canc + d.noresp;
      return {
        date: new Date(date + 'T12:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short' }),
        // Marca el día de hoy para poder resaltarlo en el gráfico. Con 30 días
        // seleccionados, sin esto la operadora no sabe cuál barra es la suya.
        esHoy: date === hoyISO,
        ...d, tasa: confRateBySample(d.conf, d.canc).tasa ?? 0, total: t
      };
    });
  }, [historyData, period, hoyISO]);

  // Comparativo de ayer. Usa la MISMA fn que CounterBar (computeDailyCounter)
  // para que "ayer" en el dashboard nunca diverja del cierre real del día.
  const yesterdayData = useMemo(() => {
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const yd = yesterday.toISOString().split('T')[0];
    const { conf, canc, noresp } = computeDailyCounter(historyData, yd);
    const total = conf + canc + noresp;
    return { conf, canc, noresp, total, tasa: confRateBySample(conf, canc).tasa ?? 0 };
  }, [historyData]);

  const sparkData = useMemo(() => {
    const last7 = chartData.slice(-7);
    return {
      conf: last7.map(d => d.conf),
      canc: last7.map(d => d.canc),
      noresp: last7.map(d => d.noresp),
      total: last7.map(d => d.total),
    };
  }, [chartData]);

  const total = counter.conf + counter.canc + counter.noresp;
  const tasa = confRateBySample(counter.conf, counter.canc).tasa ?? 0;
  const pendLeft = workQueue.filter(o => !o.result).length;

  // Meta del día — MISMA fórmula que CounterBar (src/components/CounterBar.tsx):
  // gestionados hoy / (gestionados hoy + lo que queda en cola). Se replica en
  // vez de inventar otra para que la barra de Confirmar y la del Dashboard no
  // puedan mostrarle números distintos a la misma operadora.
  const metaDia = (() => {
    const goal = total + workQueue.length;
    return { goal, pct: goal > 0 ? Math.min(100, Math.round(total / goal * 100)) : 0 };
  })();

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
    void copyToClipboard(
      `Cierre — ${formatDateES(new Date().toISOString().split('T')[0])}\n\nConfirmados: ${counter.conf}\nCancelados: ${counter.canc}\nNo respondió: ${counter.noresp}\nTasa: ${tasa}%\nPendientes: ${pendLeft}\nTotal: ${total}`,
      'Copiado al portapapeles',
    );
  };
  const enviarWA = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(`Cierre — ${formatDateES(new Date().toISOString().split('T')[0])}\n\nConf: ${counter.conf} | Canc: ${counter.canc} | N/R: ${counter.noresp}\nTotal: ${total} | Tasa: ${tasa}%\nPendientes: ${pendLeft}`)}`, '_blank');
  };

  // Chart theming uses HSL CSS vars so dark/light modes adapt automatically.
  const hsl = (v: string) => `hsl(var(${v}))`;
  const tickStyle = { fontSize: 10, fill: hsl('--muted-foreground') };

  /**
   * Tick del eje X que escribe "HOY" en cian sobre la columna del día actual,
   * en vez de la fecha. Con 30 días en pantalla es la única forma de que la
   * operadora encuentre su jornada de un vistazo.
   */
  const hoyTick = (props: { x?: number; y?: number; index?: number; payload?: { value?: string } }) => {
    const { x = 0, y = 0, index = 0, payload } = props;
    const esHoy = chartData[index]?.esHoy;
    return (
      <text
        x={x}
        y={y + 10}
        textAnchor="middle"
        fontSize={esHoy ? 9 : 10}
        fontWeight={esHoy ? 700 : 400}
        letterSpacing={esHoy ? '0.1em' : undefined}
        fill={esHoy ? hsl('--cyan') : hsl('--muted-foreground')}
      >
        {esHoy ? 'HOY' : payload?.value}
      </text>
    );
  };
  const tooltipStyle = {
    backgroundColor: hsl('--card'),
    border: `1px solid ${hsl('--border')}`,
    borderRadius: '10px',
    fontSize: '12px',
    color: hsl('--foreground'),
    boxShadow: 'var(--shadow-md)',
  };
  const CHART_ACCENT  = hsl('--accent');
  const CHART_SUCCESS = hsl('--success');
  const CHART_DANGER  = hsl('--danger');
  const CHART_WARNING = hsl('--warning');
  const CHART_INFO    = hsl('--info');
  const CHART_AI      = hsl('--ai');
  const CHART_CYAN    = hsl('--cyan');
  const CHART_MUTED   = hsl('--muted-foreground');
  const CHART_GRID    = hsl('--border');
  const COLORS = [CHART_ACCENT, CHART_INFO, CHART_SUCCESS, CHART_DANGER, CHART_AI, '#06b6d4', CHART_MUTED];

  // Meta oficial del dueño = CONF_TARGET_PCT (85%), fuente única. Verde en meta;
  // ámbar en la banda "cerca" (5 pts por debajo); rojo debajo de eso.
  const tasaColor  = tasa >= CONF_TARGET_PCT ? 'text-success' : tasa >= CONF_TARGET_PCT - 5 ? 'text-warning' : 'text-danger';
  const tasaStroke = tasa >= CONF_TARGET_PCT ? CHART_SUCCESS : tasa >= CONF_TARGET_PCT - 5 ? CHART_WARNING : CHART_DANGER;
  const tasaBg     = tasa >= CONF_TARGET_PCT ? 'bg-success/10 border border-success/25' : tasa >= CONF_TARGET_PCT - 5 ? 'bg-warning/10 border border-warning/25' : 'bg-danger/10 border border-danger/25';

  // Píldora de tendencia. Se llamaba "badge" pero era texto suelto sin fondo ni
  // borde: en la card hero quedaba como contrapeso del rótulo "Tasa personal"
  // sin ningún peso visual. El handoff la pide como chip con tinte semántico.
  function TrendBadge({ current, previous, suffix = '' }: { current: number; previous: number; suffix?: string }) {
    const base = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border text-[10px] font-semibold whitespace-nowrap';
    const diff = current - previous;
    if (diff === 0) {
      return (
        <span className={`${base} bg-muted/50 border-border text-muted-foreground`}>
          <Minus size={10} aria-hidden="true" /> sin cambio
        </span>
      );
    }
    const up = diff > 0;
    return (
      <span className={`${base} ${up ? 'bg-success/14 border-success/30 text-success' : 'bg-danger/14 border-danger/30 text-danger'}`}>
        {up ? <TrendingUp size={10} aria-hidden="true" /> : <TrendingDown size={10} aria-hidden="true" />}
        <span className="font-mono tabular-nums">{up ? '+' : ''}{diff}{suffix}</span> vs ayer
      </span>
    );
  }

  const greeting = (() => {
    const h = new Date().getHours();
    const franja = h < 12 ? 'Buenos días' : h < 18 ? 'Buenas tardes' : 'Buenas noches';
    // Solo el primer nombre: "Buenos días, María Fernanda Ríos" no entra en el
    // header y el apellido no aporta nada acá.
    const nombre = (profile?.display_name || '').trim().split(/\s+/)[0];
    return nombre ? `${franja}, ${nombre}` : franja;
  })();

  const hasData = total > 0 || totalOrders > 0;

  return (
    <div className="max-w-6xl mx-auto">
      {/* Page header — patrón pro coherente con Logística/Rescate */}
      <motion.header {...fadeUp(0)} className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div className="min-w-0 space-y-1.5">
          <div className="hud-label mb-1 truncate">
            Resumen · Operadora
          </div>
          {/* Avatar con la inicial + punto de "en línea", como el mockup: es la
              pantalla personal de la operadora, así que el header lleva su cara,
              no un ícono genérico de gráfico. */}
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-3">
            <span className="relative flex-shrink-0" aria-hidden="true">
              <span className="w-11 h-11 rounded-2xl bg-accent-gradient shadow-glow flex items-center justify-center text-white text-base font-bold">
                {(profile?.display_name || 'U')[0].toUpperCase()}
              </span>
              <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-success border-2 border-background glow-success" />
            </span>
            {greeting}
          </h1>
          <p className="text-sm text-muted-foreground">
            {formatDateES(new Date().toISOString().split('T')[0])} · Tu progreso del día y tendencia reciente.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Chip de fecha del mockup, antes del selector de período. */}
          <span className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-card/40 border border-border text-xs text-muted-foreground">
            <CalendarIcon size={13} className="text-accent" aria-hidden="true" />
            <span className="font-mono tabular-nums">
              {new Date().toLocaleDateString('es-CO', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
            </span>
          </span>
          {/* Period tabs */}
          <div className="inline-flex flex-wrap gap-2">
            {[{ n: 7, l: '7d' }, { n: 15, l: '15d' }, { n: 30, l: '30d' }].map(p => (
              <button key={p.n} onClick={() => setPeriod(p.n)}
                className={`px-4 py-2 rounded-xl text-sm transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                  period === p.n
                    ? 'font-semibold bg-accent/16 border border-accent/40 text-accent shadow-glow3d'
                    : 'font-medium bg-card/40 border border-border text-muted-foreground hover:text-foreground hover:border-border-strong'
                }`}>{p.l}</button>
            ))}
          </div>
          <div className="h-5 w-px bg-border hidden sm:block" />
          {/* Action buttons */}
          <button onClick={exportarResultadosHoy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-card/40 border border-border text-muted-foreground text-sm font-medium hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
            <Download size={13} aria-hidden="true" /> CSV
          </button>
          <button onClick={handleCierre} className="btn-accent-3d inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
            <Send size={13} aria-hidden="true" /> Enviar cierre
          </button>
          {/* More actions dropdown */}
          <div className="relative">
            <button onClick={() => setActionsOpen(!actionsOpen)}
              aria-expanded={actionsOpen}
              aria-label="Más acciones"
              className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-card/40 border border-border text-muted-foreground text-sm font-medium hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
              <ChevronDown size={13} className={`transition-transform duration-200 ${actionsOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            {actionsOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setActionsOpen(false)} aria-hidden="true" />
                <div className="absolute right-0 top-full mt-2 z-50 bg-card border border-border rounded-2xl shadow-card3d-lg py-1 min-w-[168px]">
                  <button onClick={() => { exportarHistorico(); setActionsOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-foreground hover:bg-surface transition-colors duration-200 cursor-pointer">
                    <Download size={13} aria-hidden="true" /> Exportar histórico
                  </button>
                  <button onClick={() => { copiarResumen(); setActionsOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-foreground hover:bg-surface transition-colors duration-200 cursor-pointer">
                    <Copy size={13} aria-hidden="true" /> Copiar resumen
                  </button>
                  <button onClick={() => { enviarWA(); setActionsOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-success hover:bg-surface transition-colors duration-200 cursor-pointer">
                    <MessageSquare size={13} aria-hidden="true" /> Enviar por WhatsApp
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </motion.header>

      {/* Sync health — only renders when we have at least one sync_logs row
          (i.e. the user is admin and the table is readable). Turns red if
          the cron hasn't produced a fresh entry in over an hour. */}
      {syncStatus && (
        <motion.div {...fadeUp(0.03)} className={`relative mb-5 flex flex-col sm:flex-row sm:items-center gap-3 rounded-2xl border px-4 pl-5 py-3 shadow-card3d ${
          syncStatus.broken
            ? 'border-danger/30 bg-danger/10'
            : syncStatus.warning
              ? 'border-warning/30 bg-warning/10'
              : 'border-success/30 bg-success/10'
        }`}>
          <span className={`absolute left-0 top-3 bottom-3 w-1 rounded-full ${
            syncStatus.broken ? 'bg-danger' : syncStatus.warning ? 'bg-warning' : 'bg-success'
          }`} aria-hidden="true" />
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${
            syncStatus.broken ? 'bg-danger/20 glow-danger' : syncStatus.warning ? 'bg-warning/20 glow-warning' : 'bg-success/20 glow-success'
          }`}>
            {syncStatus.broken ? <CloudOff size={18} className="text-danger" aria-hidden="true" />
              : syncStatus.warning ? <Clock size={18} className="text-warning" aria-hidden="true" />
              : <CloudDownload size={18} className="text-success" aria-hidden="true" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-xs font-semibold ${
              syncStatus.broken ? 'text-danger' : syncStatus.warning ? 'text-warning' : 'text-success'
            }`}>
              {syncStatus.broken
                ? (syncStatus.isError ? `Sync caído: ${lastSync?.error_message || 'error'}` : `Sin sincronización hace ${syncStatus.ageLabel}`)
                : syncStatus.warning
                  ? `Sincronizado hace ${syncStatus.ageLabel} (lento)`
                  : `Dropi sincronizado hace ${syncStatus.ageLabel}`}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5 font-mono tabular-nums">
              Fuente: {lastSync?.source} · {lastSync?.synced_count ?? 0} pedidos · {lastSync ? new Date(lastSync.created_at).toLocaleString('es-CO') : ''}
            </div>
          </div>
          <button
            onClick={resyncNow}
            disabled={resyncing}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-card/40 border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors duration-200 disabled:opacity-50 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <RefreshCw size={12} className={resyncing ? 'animate-spin' : ''} />
            {resyncing ? 'Sincronizando...' : 'Forzar sync'}
          </button>
        </motion.div>
      )}

      {!hasData ? (
        /* Empty state */
        <motion.div {...fadeUp(0.05)} className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-16 h-16 rounded-2xl bg-card/40 border border-border shadow-card3d flex items-center justify-center mb-4">
            <BarChart3 size={28} className="text-muted-foreground" aria-hidden="true" />
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
            <TiltCard
              sheen
              brackets
              wrapperClassName="md:col-span-5"
              className="bg-card/40 border border-border rounded-3xl p-6 shadow-card3d-lg h-full flex flex-col"
            >
              <div className="flex items-center justify-between gap-3 tilt-layer-2">
                <div
                  className="hud-label"
                  title="Tasa personal: tus confirmados / los que tuvieron respuesta hoy (conf+canc, SIN noresp). Es la confirmación madura estándar COD. NO sobre el inflow total del día — eso lo ves en /admin → Productividad."
                >
                  Tasa personal
                </div>
                <TrendBadge current={tasa} previous={yesterdayData.tasa} suffix="%" />
              </div>

              <div className="flex justify-center py-4 tilt-layer-3">
                <GaugeRing value={tasa} label="confirmación" size={190} />
              </div>

              {/* Este panel mide la tasa PERSONAL del usuario que está mirando
                  (today_call_stats filtra por operator_id = auth.uid()). Para un
                  dueño o supervisor que no atiende llamadas siempre da 0, y ver
                  ceros sin explicación se lee como "la pantalla está rota".
                  Se dice explícitamente y se apunta a dónde están los del equipo. */}
              {total === 0 && isManagerOfActive && (
                <div className="rounded-xl border border-border bg-muted/20 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                  Estás en <span className="text-foreground font-semibold">0</span> porque este panel
                  mide <span className="text-foreground font-semibold">tus</span> llamadas, y hoy no
                  registraste ninguna. Los números del equipo están en{' '}
                  <span className="text-accent font-semibold">Admin → Productividad</span>.
                </div>
              )}

              <div className="tilt-layer-1 space-y-3">
                <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold ${tasaBg} ${tasaColor}`}>
                  {tasa >= CONF_TARGET_PCT ? `En meta (${CONF_TARGET_PCT}%)` : tasa >= CONF_TARGET_PCT - 5 ? 'Cerca de la meta' : 'Por debajo de la meta'}
                </div>

                {/* Meta del día — mismo cálculo que CounterBar (gestionados sobre
                    la cola del día), para que el Dashboard y la barra de
                    Confirmar nunca muestren números distintos. */}
                {metaDia.goal > 0 && (
                  <div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
                      <span>Meta del día</span>
                      <span className="font-mono tabular-nums text-foreground">
                        <b>{total}</b> / {metaDia.goal}
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-valuenow={metaDia.pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label="Avance de la meta del día"
                      className="h-2 rounded-full bg-foreground/10 overflow-hidden"
                    >
                      <div
                        className="h-full rounded-full bg-accent-gradient transition-[width] duration-700"
                        style={{ width: `${metaDia.pct}%` }}
                      />
                    </div>
                    <div className={`mt-2.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[13px] font-semibold border ${
                      pendLeft === 0
                        ? 'bg-success/10 border-success/28 text-success'
                        : 'bg-accent/10 border-accent/28 text-accent'
                    }`}>
                      {pendLeft === 0
                        ? '✓ ¡Cola al día! No te queda nada pendiente'
                        : <>Te faltan <span className="font-mono tabular-nums">{pendLeft}</span></>}
                    </div>
                  </div>
                )}
              </div>
            </TiltCard>

            {/* Compact KPIs */}
            <div className="md:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[
              { icon: CheckCircle2, label: 'Confirmados', value: counter.conf, prev: yesterdayData.conf, tone: 'success' as const, spark: sparkData.conf },
              { icon: XCircle, label: 'Cancelados', value: counter.canc, prev: yesterdayData.canc, tone: 'danger' as const, spark: sparkData.canc },
              { icon: PhoneOff, label: 'No respondió', value: counter.noresp, prev: yesterdayData.noresp, tone: 'neutral' as const, spark: sparkData.noresp },
              { icon: Package, label: 'Total pedidos', value: totalOrders, prev: 0, tone: 'accent' as const, spark: sparkData.total, extra: `${statusBreakdown.pendientes} pendientes` },
            ].map((k) => (
              <StatTile
                key={k.label}
                icon={k.icon}
                label={k.label}
                value={k.value}
                tone={k.tone}
                spark={k.spark}
                extra={k.extra
                  ? <span className="text-[11px] font-medium text-accent">{k.extra}</span>
                  : <TrendBadge current={k.value} previous={k.prev} />}
              />
            ))}
            </div>
          </motion.div>

          {/* Charts */}
          <motion.div {...fadeUp(0.12)} className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
            <TiltCard className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d h-full">
              <div className="flex items-center justify-between mb-4 tilt-layer-1">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Activity size={14} className="text-accent" aria-hidden="true" /> Tasa de confirmación
                </h3>
              </div>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                    <defs>
                      <linearGradient id="tGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={CHART_ACCENT} stopOpacity={0.45} />
                        <stop offset="100%" stopColor={CHART_ACCENT} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="tGradLine" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor={CHART_ACCENT} />
                        <stop offset="100%" stopColor={CHART_CYAN} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
                    <XAxis dataKey="date" tick={tickStyle} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tick={tickStyle} axisLine={false} tickLine={false} unit="%" />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${v}%`, 'Tasa']} />
                    <Area type="monotone" dataKey="tasa" stroke="url(#tGradLine)" strokeWidth={3} strokeLinecap="round" fill="url(#tGrad)" style={{ filter: `drop-shadow(0 0 8px ${CHART_ACCENT})` }} dot={{ r: 2, fill: CHART_ACCENT, strokeWidth: 0 }} activeDot={{ r: 4, strokeWidth: 2, stroke: hsl('--background') }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </TiltCard>

            <TiltCard className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d h-full">
              <div className="flex items-center justify-between mb-4 tilt-layer-1">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Layers size={14} className="text-success" aria-hidden="true" /> Gestiones por día
                </h3>
              </div>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
                    <XAxis dataKey="date" tick={hoyTick} axisLine={false} tickLine={false} />
                    <YAxis tick={tickStyle} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '6px' }} formatter={(v: string) => v === 'conf' ? 'Confirmados' : v === 'canc' ? 'Cancelados' : 'No respondió'} />
                    {/* Las barras de HOY van con contorno cian: con 30 días
                        seleccionados, sin esta marca la operadora no distingue
                        cuál columna es la de su jornada. */}
                    <Bar dataKey="conf" stackId="a" fill={CHART_SUCCESS} name="conf" radius={[0, 0, 0, 0]} style={{ filter: `drop-shadow(0 0 6px ${CHART_SUCCESS})` }}>
                      {chartData.map((d, i) => (
                        <Cell key={`c-${i}`} stroke={d.esHoy ? CHART_CYAN : 'transparent'} strokeWidth={d.esHoy ? 1.5 : 0} />
                      ))}
                    </Bar>
                    <Bar dataKey="canc" stackId="a" fill={CHART_DANGER} name="canc">
                      {chartData.map((d, i) => (
                        <Cell key={`x-${i}`} stroke={d.esHoy ? CHART_CYAN : 'transparent'} strokeWidth={d.esHoy ? 1.5 : 0} />
                      ))}
                    </Bar>
                    <Bar dataKey="noresp" stackId="a" fill={CHART_MUTED} radius={[6, 6, 0, 0]} name="noresp">
                      {chartData.map((d, i) => (
                        <Cell key={`n-${i}`} stroke={d.esHoy ? CHART_CYAN : 'transparent'} strokeWidth={d.esHoy ? 1.5 : 0} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </TiltCard>
          </motion.div>

          {/* F5: Operator ranking */}
          {operatorRanking.length > 1 && (
            <motion.div {...fadeUp(0.15)} className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d mb-5">
              <div className="flex items-center gap-2 mb-4">
                <Users size={14} className="text-accent" aria-hidden="true" />
                <h3
                  className="text-sm font-semibold text-foreground"
                  title="Tasa personal de cada operadora: confirmados / lo gestionado (conf+canc+noresp). NO sobre el inflow total del día."
                >
                  Ranking del equipo hoy
                </h3>
              </div>
              {/* Tabla REAL, no divs con role="table": las cifras tienen que
                  quedar asociadas a su encabezado para un lector de pantalla,
                  y con columnas de verdad los rótulos se alinean solos.
                  RankRow no sirve acá — es una fila de ranking de 3 datos, no
                  una tabla de 7 columnas. */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="px-5 py-2.5 text-left hud-label font-normal">#</th>
                      <th className="px-3 py-2.5 text-left hud-label font-normal">Operador(a)</th>
                      <th className="px-3 py-2.5 text-center hud-label font-normal">Conf.</th>
                      <th className="px-3 py-2.5 text-center hud-label font-normal">Canc.</th>
                      <th className="px-3 py-2.5 text-center hud-label font-normal">N/R</th>
                      <th className="px-3 py-2.5 text-center hud-label font-normal">Total</th>
                      <th
                        className="px-3 py-2.5 text-center hud-label font-normal"
                        title="Tasa personal de cada operadora: confirmados / lo gestionado (conf+canc+noresp). NO sobre el inflow total del día."
                      >
                        Tasa pers.
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {operatorRanking.map((op, idx) => {
                      const isMe = op.operatorId === user?.id;
                      // El umbral es de negocio (CONF_TARGET_PCT), no de
                      // presentación: verde en meta, ámbar en la banda "cerca",
                      // rojo debajo. Sin esto una tasa de 20% se ve igual que 90%.
                      const tasaC = op.tasa >= CONF_TARGET_PCT ? 'text-success' : op.tasa >= CONF_TARGET_PCT - 5 ? 'text-warning' : 'text-danger';
                      return (
                        <tr
                          key={op.operatorId}
                          className={`border-b border-border last:border-0 transition-colors duration-200 ${
                            isMe ? 'bg-accent/8' : 'hover:bg-card/60'
                          }`}
                        >
                          <td className="px-5 py-2.5 font-mono tabular-nums text-muted-foreground">
                            {idx === 0
                              ? <Trophy size={14} className="text-accent" aria-label="1er lugar" />
                              : idx + 1}
                          </td>
                          <td className="px-3 py-2.5 font-medium text-foreground">
                            {op.name}
                            {isMe && <span className="ml-1.5 text-[10px] text-accent font-semibold">(tú)</span>}
                          </td>
                          <td className="px-3 py-2.5 text-center font-mono tabular-nums text-success">{op.conf}</td>
                          <td className="px-3 py-2.5 text-center font-mono tabular-nums text-danger">{op.canc}</td>
                          <td className="px-3 py-2.5 text-center font-mono tabular-nums text-muted-foreground">{op.noresp}</td>
                          <td className="px-3 py-2.5 text-center font-mono tabular-nums text-foreground">{op.total}</td>
                          <td className={`px-3 py-2.5 text-center font-mono tabular-nums font-bold ${tasaC}`}>{op.tasa}%</td>
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
              <TiltCard wrapperClassName="md:col-span-2" className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d h-full">
                <h3 className="hud-label mb-4">Distribución por producto</h3>
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
                      <Legend wrapperStyle={{ fontSize: '10px', color: CHART_MUTED }} layout="vertical" align="right" verticalAlign="middle" />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </TiltCard>

              <div className="md:col-span-3 bg-card/40 border border-border rounded-2xl overflow-hidden shadow-card3d hover:border-border-strong transition-colors duration-200">
                <div className="px-5 py-3.5 border-b border-border">
                  <h3 className="hud-label">Detalle por producto</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground text-[10px] uppercase tracking-wider border-b border-border bg-card/30">
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
                        const ec = efect >= 55 ? 'text-success' : efect >= 40 ? 'text-warning' : 'text-danger';
                        return (
                          <tr key={name} className="border-b border-border last:border-0 hover:bg-card transition-colors duration-200">
                            <td className="px-5 py-2.5 font-medium max-w-[160px]">
                              <TruncatedText text={name} maxChars={22} className="block" />
                            </td>
                            <td className="px-3 py-2.5 text-center font-mono tabular-nums">{d.total}</td>
                            <td className="px-3 py-2.5 text-center font-mono tabular-nums text-success">{d.entreg}</td>
                            <td className="px-3 py-2.5 text-center font-mono tabular-nums text-danger">{d.canc}</td>
                            <td className="px-3 py-2.5 text-center font-mono tabular-nums text-warning">{d.nov}</td>
                            <td className={`px-3 py-2.5 text-center font-mono tabular-nums font-bold ${ec}`}>{efect}%</td>
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
          <motion.div {...fadeUp(0.24)} className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="hud-label">Resumen del día</h3>
                <p className="text-[10px] text-muted-foreground/70 mt-1 font-mono tabular-nums">{formatDateES(new Date().toISOString().split('T')[0])}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { icon: CheckCircle2, label: 'Confirmados', value: counter.conf, color: 'text-success', iconBg: 'bg-success/14 border-success/30 glow-success', iconColor: 'text-success' },
                { icon: XCircle, label: 'Cancelados', value: counter.canc, color: 'text-danger', iconBg: 'bg-danger/14 border-danger/30 glow-danger', iconColor: 'text-danger' },
                { icon: PhoneOff, label: 'No respondió', value: counter.noresp, color: 'text-muted-foreground', iconBg: 'bg-muted/60 border-border', iconColor: 'text-muted-foreground' },
                { icon: Clock, label: 'Pendientes', value: pendLeft, color: 'text-warning', iconBg: 'bg-warning/14 border-warning/30 glow-warning', iconColor: 'text-warning' },
              ].map(item => {
                const Icon = item.icon;
                return (
                  <div key={item.label} className="flex items-center gap-3 p-3.5 rounded-2xl bg-card/40 border border-border hover:border-border-strong transition-colors duration-200">
                    <div className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 ${item.iconBg}`}>
                      <Icon size={16} className={item.iconColor} aria-hidden="true" />
                    </div>
                    <div>
                      <div className={`text-2xl font-bold leading-none ${item.color}`}>
                        <CountUp value={item.value} />
                      </div>
                      <div className="hud-label mt-1.5">{item.label}</div>
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
