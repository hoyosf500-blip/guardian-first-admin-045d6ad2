import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  CheckCircle2, RotateCcw, Package, Star, AlertTriangle,
  User, RefreshCw, Sparkles, Shield, Fingerprint, Store, Globe,
} from 'lucide-react';
import {
  PieChart, Pie, Cell,
  BarChart, Bar, XAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { TruncatedText } from '@/components/TruncatedText';
import { useAiInsight } from '@/hooks/useAiInsight';
import { calcBadge, estadoColor } from '@/lib/customerUtils';
import { formatCOP } from '@/lib/utils';

interface Props {
  currentPhone: string;
  currentOrderId: string;
}

interface HistoryOrder {
  id: string;
  external_id: string | null;
  nombre: string | null;
  estado: string | null;
  fecha: string | null;
  fecha_conf: string | null;
  valor: number | null;
  guia: string | null;
  novedad: string | null;
  novedad_sol: boolean | null;
  producto: string | null;
  transportadora: string | null;
  ciudad: string | null;
}

// ── Dropi fingerprint types ──────────────────────────────────────────

interface DropiFingerprint {
  found: boolean;
  phone: string;
  global_profile: {
    risk_label: string;   // "Seguro" | "Probable" | "Riesgoso"
    risk_color: string;   // "green" | "yellow" | "red"
    buyer_type: string;   // "Frecuente" | "Nuevo" | etc.
    lifetime_totals: {
      orders: number;
      delivered: number;
      returned: number;
    };
  };
  context_analysis: {
    my_shop: { period_orders: number; period_delivered: number; period_returned: number; period_transit: number };
    other_shops: { period_orders: number; period_delivered: number; period_returned: number; period_transit: number };
    all_shops: { period_orders: number; period_delivered: number; period_returned: number; period_transit: number };
  };
}

const DROPI_RISK_COLORS: Record<string, { color: string; bgClass: string; textClass: string }> = {
  green:  { color: '#22c55e', bgClass: 'bg-green-500/10',  textClass: 'text-green-600 dark:text-green-400' },
  yellow: { color: '#eab308', bgClass: 'bg-yellow-500/10', textClass: 'text-yellow-600 dark:text-yellow-400' },
  red:    { color: '#ef4444', bgClass: 'bg-red-500/10',    textClass: 'text-red-600 dark:text-red-400' },
};

// ── Order categorization ────────────────────────────────────────────

type OrderCategory = 'todos' | 'entregado' | 'no_entrega' | 'en_camino';

function categorizeOrder(estado: string | null): Exclude<OrderCategory, 'todos'> {
  const e = (estado || '').toUpperCase();
  if (e === 'ENTREGADO') return 'entregado';
  if (e.includes('DEVOL') || e.includes('CANCELADO')) return 'no_entrega';
  return 'en_camino';
}

// ── Score configuration ─────────────────────────────────────────────

interface ScoreConfig {
  label: string;
  color: string;
  bgClass: string;
  textClass: string;
}

function getScoreConfig(score: number): ScoreConfig {
  if (score >= 80) return {
    label: 'Seguro',
    color: '#22c55e',
    bgClass: 'bg-green-500/10',
    textClass: 'text-green-600 dark:text-green-400',
  };
  if (score >= 50) return {
    label: 'Moderado',
    color: '#eab308',
    bgClass: 'bg-yellow-500/10',
    textClass: 'text-yellow-600 dark:text-yellow-400',
  };
  return {
    label: 'Riesgoso',
    color: '#ef4444',
    bgClass: 'bg-red-500/10',
    textClass: 'text-red-600 dark:text-red-400',
  };
}

// ── Auto-generated insights ─────────────────────────────────────────

function generateInsights(
  total: number,
  entregados: number,
  devoluciones: number,
  novedades: number,
  orders: HistoryOrder[],
): string[] {
  const insights: string[] = [];

  // Delivery pattern
  if (entregados > 0 && devoluciones === 0) {
    insights.push(`${entregados} entrega${entregados > 1 ? 's' : ''} exitosa${entregados > 1 ? 's' : ''} sin devoluciones`);
  } else if (entregados + devoluciones > 0) {
    const rate = Math.round((entregados / (entregados + devoluciones)) * 100);
    if (rate >= 80) {
      insights.push('Alta certeza de entregas — cliente confiable');
    } else if (rate < 50 && devoluciones >= 2) {
      insights.push(`Patrón de devolución frecuente (${devoluciones} de ${entregados + devoluciones})`);
    }
  }

  // Novedades
  if (novedades > 0) {
    const novedadPct = Math.round((novedades / total) * 100);
    if (novedadPct >= 30) {
      insights.push(`${novedadPct}% de pedidos con novedad — verificar dirección`);
    } else {
      insights.push(`${novedades} pedido${novedades > 1 ? 's' : ''} con novedad registrada`);
    }
  } else if (total >= 3) {
    insights.push('Sin novedades en su historial');
  }

  // Average ticket
  if (orders.length > 0) {
    const avgValue = orders.reduce((s, o) => s + (Number(o.valor) || 0), 0) / orders.length;
    if (avgValue >= 150000) {
      insights.push(`Ticket promedio alto: ${formatCOP(Math.round(avgValue))}`);
    } else if (total >= 3) {
      insights.push(`Ticket promedio: ${formatCOP(Math.round(avgValue))}`);
    }
  }

  // Recent trend (last 3 completed orders)
  if (orders.length >= 3) {
    const last3 = orders.slice(0, 3);
    const last3Delivered = last3.filter(o => /ENTREGADO/i.test(o.estado || '')).length;
    if (last3Delivered === 3) {
      insights.push('Tendencia positiva — últimos 3 entregados');
    } else {
      const last3Returns = last3.filter(o => /DEVOL/i.test(o.estado || '')).length;
      if (last3Returns >= 2) {
        insights.push('Tendencia negativa — devoluciones recientes');
      }
    }
  }

  return insights.slice(0, 3);
}

// ── Monthly chart data ──────────────────────────────────────────────

const MONTH_NAMES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

interface MonthData {
  month: string;
  entregados: number;
  noEntrega: number;
  enCamino: number;
}

function buildMonthlyChart(orders: HistoryOrder[]): MonthData[] {
  const months = new Map<string, MonthData>();

  for (const o of orders) {
    if (!o.fecha) continue;
    const key = o.fecha.slice(0, 7); // "YYYY-MM"
    const monthIdx = parseInt(o.fecha.slice(5, 7), 10) - 1;
    const label = `${MONTH_NAMES[monthIdx]} ${o.fecha.slice(2, 4)}`;

    if (!months.has(key)) {
      months.set(key, { month: label, entregados: 0, noEntrega: 0, enCamino: 0 });
    }
    const entry = months.get(key)!;
    const cat = categorizeOrder(o.estado);
    if (cat === 'entregado') entry.entregados++;
    else if (cat === 'no_entrega') entry.noEntrega++;
    else entry.enCamino++;
  }

  return Array.from(months.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-6)
    .map(([, v]) => v);
}

// ── Tabs config ─────────────────────────────────────────────────────

const TABS: { key: OrderCategory; label: string; activeClass: string }[] = [
  { key: 'todos',      label: 'Todos',       activeClass: 'bg-accent/12 text-accent border border-accent/30' },
  { key: 'entregado',  label: 'Entregados',  activeClass: 'bg-success/12 text-success border border-success/30' },
  { key: 'no_entrega', label: 'No Entrega',  activeClass: 'bg-danger/12 text-danger border border-danger/30' },
  { key: 'en_camino',  label: 'En Camino',   activeClass: 'bg-info/12 text-info border border-info/30' },
];

// Muted fill for the gauge background — works in light and dark themes
const GAUGE_REST_COLOR = 'rgba(156, 163, 175, 0.15)';

// ═════════════════════════════════════════════════════════════════════

export default function CustomerHistoryCard({ currentPhone, currentOrderId }: Props) {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<HistoryOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<OrderCategory>('todos');
  const { ask: askAi, get: getAi } = useAiInsight();

  // Dropi fingerprint (cross-store data)
  const [fingerprint, setFingerprint] = useState<DropiFingerprint | null>(null);
  const [fpLoading, setFpLoading] = useState(false);

  useEffect(() => {
    if (!currentPhone) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from('orders')
        .select('id, external_id, nombre, estado, fecha, fecha_conf, valor, guia, novedad, novedad_sol, producto, transportadora, ciudad')
        .eq('phone', currentPhone)
        .neq('id', currentOrderId)
        .order('fecha', { ascending: false, nullsFirst: false })
        .limit(20);
      if (!cancelled) {
        setOrders((data as HistoryOrder[]) || []);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [currentPhone, currentOrderId]);

  // Fetch Dropi fingerprint (global cross-store data)
  useEffect(() => {
    if (!currentPhone) return;
    let cancelled = false;
    (async () => {
      setFpLoading(true);
      try {
        const { data: raw, error } = await supabase.rpc('dropi_fingerprint', {
          p_phone: currentPhone,
        });
        const d = raw as Record<string, unknown> | null;
        if (!cancelled && !error && d?.ok && (d.fingerprint as DropiFingerprint)?.found) {
          setFingerprint(d.fingerprint as DropiFingerprint);
        }
      } catch {
        // Silently fail — fingerprint is optional
      } finally {
        if (!cancelled) setFpLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [currentPhone]);

  // ── Derived stats ──────────────────────────────────────────────

  const total = orders.length + 1; // +1 for current order
  const entregados = orders.filter(o => /ENTREGADO/i.test(o.estado || '')).length;
  const devoluciones = orders.filter(o => /DEVOL/i.test(o.estado || '')).length;
  const enCamino = orders.length - entregados - devoluciones;
  const novedades = orders.filter(o => o.novedad).length;
  const completados = entregados + devoluciones;
  const deliveryScore = completados > 0 ? Math.round((entregados / completados) * 100) : null;
  const efectividad = Math.round((entregados / total) * 100);
  const badge = calcBadge(total, entregados, devoluciones);

  const gaugeScore = deliveryScore ?? 50;
  const scoreConfig = getScoreConfig(gaugeScore);
  const gaugeData = [
    { value: gaugeScore },
    { value: 100 - gaugeScore },
  ];

  const insights = useMemo(
    () => generateInsights(total, entregados, devoluciones, novedades, orders),
    [total, entregados, devoluciones, novedades, orders],
  );

  const chartData = useMemo(() => buildMonthlyChart(orders), [orders]);

  const filteredOrders = useMemo(() => {
    if (activeTab === 'todos') return orders;
    return orders.filter(o => categorizeOrder(o.estado) === activeTab);
  }, [orders, activeTab]);

  const tabCounts: Record<OrderCategory, number> = {
    todos: orders.length,
    entregado: entregados,
    no_entrega: devoluciones,
    en_camino: enCamino,
  };

  // ── Loading / empty states ─────────────────────────────────────

  if (loading) {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        className="bg-card border border-border rounded-2xl p-5">
        <div className="flex items-center gap-2">
          <RefreshCw size={16} className="text-muted-foreground animate-spin" />
          <span className="text-sm text-muted-foreground">Cargando huella del cliente…</span>
        </div>
      </motion.div>
    );
  }

  if (orders.length === 0) {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        className="bg-card border border-border rounded-2xl p-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center flex-shrink-0">
            <User size={18} className="text-blue-500" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-foreground">Huella del comprador</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Primer pedido de este cliente</p>
          </div>
        </div>
      </motion.div>
    );
  }

  // ── Full card ──────────────────────────────────────────────────

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className="bg-card border border-border rounded-2xl overflow-hidden">

      {/* Header */}
      <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Shield size={16} className="text-accent" />
          <h3 className="text-sm font-bold text-foreground">Huella del comprador</h3>
          <span className="text-xs text-muted-foreground">· {total} pedido{total === 1 ? '' : 's'}</span>
        </div>
        {badge && (
          <span className={`text-[10px] px-2 py-1 rounded-full font-bold ${badge.className}`}>
            {badge.label}
          </span>
        )}
      </div>

      {/* ── Dropi global fingerprint (cross-store) ── */}
      {fingerprint && (() => {
        const gp = fingerprint.global_profile;
        const totals = gp.lifetime_totals;
        const dropiScore = totals.delivered + totals.returned > 0
          ? Math.round((totals.delivered / (totals.delivered + totals.returned)) * 100)
          : null;
        const riskStyle = DROPI_RISK_COLORS[gp.risk_color] || DROPI_RISK_COLORS.yellow;
        const myShop = fingerprint.context_analysis.my_shop.period_orders;
        const otherShops = fingerprint.context_analysis.other_shops.period_orders;
        const shopGaugeData = [
          { name: 'Tu tienda', value: myShop || 0 },
          { name: 'Otras tiendas', value: otherShops || 0 },
        ];
        // If both are 0, show empty gauge
        const hasShopData = myShop + otherShops > 0;

        return (
          <div className="px-5 py-5 border-b border-border">
            <div className="flex items-center gap-1.5 mb-4">
              <Fingerprint size={13} className="text-cyan-500" />
              <span className="text-[10px] font-bold text-cyan-600 dark:text-cyan-400 uppercase tracking-wider">Datos Dropi — todas las tiendas</span>
            </div>
            <div className="flex flex-col sm:flex-row items-center gap-5">
              {/* Donut: tu tienda vs otras */}
              <div className="relative flex-shrink-0" style={{ width: 130, height: 130 }}>
                <PieChart width={130} height={130}>
                  <Pie
                    data={hasShopData ? shopGaugeData : [{ value: 1 }]}
                    cx={60} cy={60}
                    innerRadius={42} outerRadius={56}
                    startAngle={90} endAngle={-270}
                    dataKey="value" stroke="none"
                    animationBegin={0} animationDuration={800}
                  >
                    {hasShopData ? (
                      <>
                        <Cell fill="#3b82f6" />
                        <Cell fill="#94a3b8" />
                      </>
                    ) : (
                      <Cell fill={GAUGE_REST_COLOR} />
                    )}
                  </Pie>
                </PieChart>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-[10px] text-muted-foreground">Total</span>
                  <span className="text-2xl font-bold text-foreground">{totals.orders}</span>
                </div>
              </div>

              {/* Right side: score + breakdown */}
              <div className="flex-1 min-w-0 text-center sm:text-left">
                <div className="flex items-center justify-center sm:justify-start gap-2 mb-1">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${riskStyle.bgClass} ${riskStyle.textClass}`}>
                    {gp.buyer_type}
                  </span>
                </div>
                <div className="flex items-center justify-center sm:justify-start gap-2 mb-3">
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                    Probabilidad de entrega
                  </span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${riskStyle.bgClass} ${riskStyle.textClass}`}>
                    {gp.risk_label}
                  </span>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="flex items-center gap-2">
                    <Store size={11} className="text-blue-500" />
                    <span className="text-muted-foreground">En tu tienda:</span>
                    <span className="font-bold text-foreground">{myShop}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Globe size={11} className="text-gray-400" />
                    <span className="text-muted-foreground">En otras tiendas:</span>
                    <span className="font-bold text-foreground">{otherShops}</span>
                  </div>
                </div>

                {/* Delivery / return bars */}
                <div className="mt-3 space-y-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">Entregadas</span>
                    <span className="font-bold text-emerald-500">{totals.delivered} ({dropiScore ?? 0}%)</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-muted/40 overflow-hidden">
                    <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${dropiScore ?? 0}%` }} />
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">Devoluciones</span>
                    <span className="font-bold text-rose-500">{totals.returned} ({dropiScore !== null ? 100 - dropiScore : 0}%)</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-muted/40 overflow-hidden">
                    <div className="h-full rounded-full bg-rose-500 transition-all" style={{ width: `${dropiScore !== null ? 100 - dropiScore : 0}%` }} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {fpLoading && (
        <div className="px-5 py-3 border-b border-border flex items-center gap-2 text-xs text-cyan-500">
          <RefreshCw size={12} className="animate-spin" />
          Consultando huella Dropi…
        </div>
      )}

      {/* ── Local delivery probability gauge + insights ── */}
      <div className="px-5 py-5 border-b border-border flex flex-col sm:flex-row items-center gap-5">
        {/* Circular gauge */}
        <div className="relative flex-shrink-0" style={{ width: 130, height: 130 }}>
          <PieChart width={130} height={130}>
            <Pie
              data={gaugeData}
              cx={60}
              cy={60}
              innerRadius={42}
              outerRadius={56}
              startAngle={90}
              endAngle={-270}
              dataKey="value"
              stroke="none"
              animationBegin={0}
              animationDuration={800}
            >
              <Cell fill={scoreConfig.color} />
              <Cell fill={GAUGE_REST_COLOR} />
            </Pie>
          </PieChart>
          {/* Score number in center */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className={`text-3xl font-bold ${scoreConfig.textClass}`}>
              {deliveryScore !== null ? gaugeScore : '—'}
            </span>
          </div>
        </div>

        {/* Label + insights */}
        <div className="flex-1 min-w-0 text-center sm:text-left">
          <div className="flex items-center justify-center sm:justify-start gap-2 mb-1">
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
              {fingerprint ? 'Tu tienda' : 'Probabilidad de entrega'}
            </span>
          </div>
          <div className="flex items-center justify-center sm:justify-start gap-2 mb-3">
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${scoreConfig.bgClass} ${scoreConfig.textClass}`}>
              {deliveryScore !== null ? scoreConfig.label : 'Sin datos'}
            </span>
          </div>
          <ul className="space-y-1.5">
            {insights.map((text, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                <span className={`mt-1 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  gaugeScore >= 80 ? 'bg-green-500' : gaugeScore >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                }`} />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* ── KPI grid ── */}
      <div className="grid grid-cols-4 divide-x divide-border border-b border-border">
        <div className="p-3 text-center">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Total</div>
          <div className="text-lg font-bold text-foreground flex items-center justify-center gap-1">
            <Package size={14} className="text-muted-foreground" />{total}
          </div>
        </div>
        <div className="p-3 text-center">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Entregados</div>
          <div className="text-lg font-bold text-emerald-500 flex items-center justify-center gap-1">
            <CheckCircle2 size={14} />{entregados}
          </div>
        </div>
        <div className="p-3 text-center">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Devueltos</div>
          <div className="text-lg font-bold text-rose-500 flex items-center justify-center gap-1">
            <RotateCcw size={14} />{devoluciones}
          </div>
        </div>
        <div className="p-3 text-center">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Efectividad</div>
          <div className={`text-lg font-bold flex items-center justify-center gap-1 ${
            efectividad >= 80 ? 'text-green-500' : efectividad >= 50 ? 'text-yellow-500' : 'text-red-500'
          }`}>
            {efectividad >= 80 && <Star size={14} />}
            {efectividad < 50 && <AlertTriangle size={14} />}
            {efectividad}%
          </div>
        </div>
      </div>

      {/* ── AI customer profile ── */}
      {orders.length >= 2 && (() => {
        const aiKey = `profile-${currentPhone}`;
        const ai = getAi(aiKey);
        const buildCtx = () => [
          `Total pedidos: ${total}`,
          `Entregados: ${entregados}`,
          `Devoluciones: ${devoluciones}`,
          `Efectividad: ${efectividad}%`,
          `Score probabilidad entrega: ${gaugeScore}/100 (${scoreConfig.label})`,
          `Productos pedidos: ${[...new Set(orders.map(o => o.producto).filter(Boolean))].join(', ')}`,
          `Ciudades: ${[...new Set(orders.map(o => o.ciudad).filter(Boolean))].join(', ') || 'N/A'}`,
          `Transportadoras usadas: ${[...new Set(orders.map(o => o.transportadora).filter(Boolean))].join(', ')}`,
          `Pedidos con novedad: ${novedades}`,
          `Valor promedio: $${Math.round(orders.reduce((s, o) => s + (Number(o.valor) || 0), 0) / orders.length).toLocaleString()}`,
        ].join('\n');
        return (
          <div className="px-5 py-3 border-b border-border">
            {!ai.reply && !ai.loading && (
              <button onClick={() => askAi(aiKey, 'customer_profile', buildCtx())}
                className="w-full inline-flex items-center justify-center gap-1.5 py-2 rounded-lg bg-ai/10 border border-ai/25 text-ai text-xs font-semibold hover:bg-ai/15 hover:border-ai/40 transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-ai/40 focus-visible:outline-none">
                <Sparkles size={12} aria-hidden="true" /> Perfil IA del cliente
              </button>
            )}
            {ai.loading && (
              <div className="flex items-center gap-1.5 py-2 text-xs text-ai">
                <RefreshCw size={12} className="animate-spin" aria-hidden="true" /> Analizando cliente...
              </div>
            )}
            {ai.reply && (
              <div className="p-3 rounded-lg bg-ai/5 border border-ai/25 text-xs text-foreground whitespace-pre-line leading-relaxed">
                <span className="text-ai font-semibold inline-flex items-center gap-1 mb-1"><Sparkles size={10} aria-hidden="true" /> Perfil IA</span>
                <br />{ai.reply}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Análisis detallado (tabs) ── */}
      <div className="px-5 pt-4 pb-3 border-b border-border">
        <h4 className="text-xs font-bold text-foreground mb-3">Análisis detallado</h4>
        <div className="flex gap-1 flex-wrap">
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors ${
                activeTab === tab.key ? tab.activeClass : 'text-muted-foreground hover:bg-muted/50'
              }`}
            >
              {tab.label}{' '}
              <span className="opacity-70">({tabCounts[tab.key]})</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Monthly bar chart ── */}
      {chartData.length >= 2 && (
        <div className="px-5 py-4 border-b border-border">
          <ResponsiveContainer width="100%" height={90}>
            <BarChart data={chartData} barGap={1}>
              <XAxis
                dataKey="month"
                tick={{ fontSize: 10, fill: 'currentColor' }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                contentStyle={{
                  fontSize: 11,
                  borderRadius: 8,
                  backgroundColor: 'var(--color-card, #fff)',
                  borderColor: 'var(--color-border, #e5e7eb)',
                }}
                labelStyle={{ fontWeight: 600 }}
              />
              <Bar dataKey="entregados" stackId="a" fill="#22c55e" name="Entregados" />
              <Bar dataKey="noEntrega"  stackId="a" fill="#ef4444"  name="No entrega" />
              <Bar dataKey="enCamino"   stackId="a" fill="#3b82f6"  name="En camino" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Filtered orders list ── */}
      <div className="max-h-72 overflow-y-auto divide-y divide-border">
        {filteredOrders.length === 0 && (
          <div className="px-5 py-6 text-xs text-muted-foreground text-center">
            Sin pedidos en esta categoría
          </div>
        )}
        {filteredOrders.slice(0, 10).map((o) => (
          <button
            key={o.id}
            onClick={() => o.external_id && navigate(`/pedido/${o.external_id}`)}
            disabled={!o.external_id}
            aria-label={`Pedido #${o.external_id || 'sin ID'} — ${o.estado || 'sin estado'} — $${(Number(o.valor) || 0).toLocaleString()}`}
            className="w-full text-left px-5 py-3 hover:bg-secondary/40 transition-colors disabled:cursor-not-allowed"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-xs font-mono text-muted-foreground">#{o.external_id || 'sin ID'}</span>
                  <span className="text-[10px] text-muted-foreground">·</span>
                  <span className="text-xs text-muted-foreground">{o.fecha || '—'}</span>
                  {o.ciudad && (
                    <>
                      <span className="text-[10px] text-muted-foreground">·</span>
                      <span className="text-[10px] text-muted-foreground">{o.ciudad}</span>
                    </>
                  )}
                </div>
                <TruncatedText
                  text={o.producto || '—'}
                  maxChars={50}
                  className="block text-xs text-foreground"
                />
                {o.transportadora && (
                  <div className="text-[10px] text-muted-foreground mt-0.5">{o.transportadora}{o.guia ? ` · ${o.guia}` : ''}</div>
                )}
              </div>
              <div className="flex flex-col items-end gap-1 flex-shrink-0">
                <span className="text-xs font-bold text-foreground">${(Number(o.valor) || 0).toLocaleString()}</span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${estadoColor(o.estado)}`}>
                  {o.estado || '—'}
                </span>
              </div>
            </div>
          </button>
        ))}
        {filteredOrders.length > 10 && (
          <div className="px-5 py-3 text-xs text-muted-foreground text-center bg-muted/20">
            + {filteredOrders.length - 10} pedidos más
          </div>
        )}
      </div>
    </motion.div>
  );
}
