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
  green:  { color: 'hsl(var(--success))', bgClass: 'bg-success/14 border border-success/30', textClass: 'text-success' },
  yellow: { color: 'hsl(var(--warning))', bgClass: 'bg-warning/14 border border-warning/30', textClass: 'text-warning' },
  red:    { color: 'hsl(var(--danger))',  bgClass: 'bg-danger/14 border border-danger/30',   textClass: 'text-danger' },
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
    color: 'hsl(var(--success))',
    bgClass: 'bg-success/14 border border-success/30',
    textClass: 'text-success',
  };
  if (score >= 50) return {
    label: 'Moderado',
    color: 'hsl(var(--warning))',
    bgClass: 'bg-warning/14 border border-warning/30',
    textClass: 'text-warning',
  };
  return {
    label: 'Riesgoso',
    color: 'hsl(var(--danger))',
    bgClass: 'bg-danger/14 border border-danger/30',
    textClass: 'text-danger',
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
  { key: 'todos',      label: 'Todos',       activeClass: 'bg-accent/16 text-accent border border-accent/40 shadow-glow3d' },
  { key: 'entregado',  label: 'Entregados',  activeClass: 'bg-success/16 text-success border border-success/40' },
  { key: 'no_entrega', label: 'No Entrega',  activeClass: 'bg-danger/16 text-danger border border-danger/40' },
  { key: 'en_camino',  label: 'En Camino',   activeClass: 'bg-info/16 text-info border border-info/40' },
];

// Muted fill for the gauge background — works in light and dark themes
const GAUGE_REST_COLOR = 'hsl(var(--foreground) / 0.12)';

// Tope de filas del historial. Si la muestra llega al tope, sabemos que hay más
// pedidos aunque el conteo exacto no se haya podido leer.
const HISTORY_LIMIT = 20;

// ═════════════════════════════════════════════════════════════════════

export default function CustomerHistoryCard({ currentPhone, currentOrderId }: Props) {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<HistoryOrder[]>([]);
  // Conteo REAL de pedidos del cliente (el historial de abajo viene topado en 20 filas)
  const [totalCount, setTotalCount] = useState<number | null>(null);
  // La lectura del historial falló: NO es lo mismo que "no tiene pedidos previos".
  const [loadError, setLoadError] = useState(false);
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
      setLoadError(false);
      const [historyRes, countRes] = await Promise.all([
        supabase
          .from('orders')
          .select('id, external_id, nombre, estado, fecha, fecha_conf, valor, guia, novedad, novedad_sol, producto, transportadora, ciudad')
          .eq('phone', currentPhone)
          .neq('id', currentOrderId)
          .order('fecha', { ascending: false, nullsFirst: false })
          .limit(HISTORY_LIMIT),
        // El historial de arriba es una MUESTRA (.limit(20)). Pedimos el conteo exacto
        // aparte para no rotular esa muestra como "Total".
        supabase
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .eq('phone', currentPhone),
      ]);
      if (cancelled) return;
      // Si la consulta falló, `data` viene null. Sin este guard la tarjeta
      // mostraría "Primer pedido de este cliente" — un dato inventado a partir
      // de una lectura que nunca ocurrió.
      if (historyRes?.error) {
        setLoadError(true);
        setOrders([]);
        setTotalCount(null);
        setLoading(false);
        return;
      }
      setOrders((historyRes?.data as HistoryOrder[]) || []);
      setTotalCount(typeof countRes?.count === 'number' ? countRes.count : null);
      setLoading(false);
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
  // Solo los pedidos CONCLUIDOS (entregados + devueltos) son un desenlace. Con el pedido
  // actual y los que van en camino en el denominador, un cliente sin nada resuelto daba 0%.
  const efectividad = completados > 0 ? Math.round((entregados / completados) * 100) : null;
  const badge = calcBadge(total, entregados, devoluciones);

  // `total` sale de la muestra de 20; `totalReal` es el conteo exacto del cliente.
  // Si el conteo no se pudo leer Y la muestra llegó al tope, NO sabemos cuántos son:
  // ahí `totalReal` queda null y se rotula "N+" (al menos N), nunca como total cerrado.
  const hitLimit = orders.length >= HISTORY_LIMIT;
  const totalReal = totalCount ?? (hitLimit ? null : total);
  const totalLabel = totalReal === null ? `${total}+` : String(totalReal);
  const esMuestra = totalReal === null || totalReal > total;

  // OJO: 50 es un relleno para que el gauge tenga geometría, NO una medición.
  // Solo puede usarse dentro de un `deliveryScore !== null`. Nunca mostrarlo ni
  // mandarlo a la IA sin ese guard: sería inventar un nivel de riesgo.
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
        className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d">
        <div className="flex items-center gap-2">
          <RefreshCw size={16} className="text-muted-foreground animate-spin" />
          <span className="text-sm text-muted-foreground">Cargando huella del cliente…</span>
        </div>
      </motion.div>
    );
  }

  // La lectura falló: decirlo. Un historial vacío por error NO es "cliente nuevo".
  if (loadError) {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        className="bg-card/40 border border-danger/40 rounded-2xl p-5 shadow-card3d">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="text-danger flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-bold text-danger">No pudimos leer la huella del comprador</h3>
            <p className="text-xs text-muted-foreground mt-1">
              La consulta del historial falló. No sabemos si este cliente ya compró antes — no lo trates como primer pedido.
            </p>
          </div>
        </div>
      </motion.div>
    );
  }

  if (orders.length === 0) {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center flex-shrink-0">
            <User size={18} />
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
      className="bg-card/40 border border-border rounded-2xl overflow-hidden shadow-card3d">

      {/* Header */}
      <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-9 h-9 rounded-xl bg-accent/14 border border-accent/30 text-accent flex items-center justify-center flex-shrink-0">
            <Shield size={15} />
          </span>
          <h3 className="text-sm font-bold text-foreground">Huella del comprador</h3>
          <span className="text-xs text-muted-foreground font-mono tabular-nums">· {totalLabel} pedido{totalReal === 1 ? '' : 's'}</span>
        </div>
        {badge && (
          <span className={`inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg font-semibold ${badge.className}`}>
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
              <Fingerprint size={13} className="text-info" />
              <span className="hud-label">Datos Dropi — todas las tiendas</span>
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
                        <Cell fill="hsl(var(--info))" />
                        <Cell fill="hsl(var(--muted-foreground))" />
                      </>
                    ) : (
                      <Cell fill={GAUGE_REST_COLOR} />
                    )}
                  </Pie>
                </PieChart>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-[10px] text-muted-foreground">Total</span>
                  <span className="text-2xl font-bold text-foreground font-mono tabular-nums">{totals.orders}</span>
                </div>
              </div>

              {/* Right side: score + breakdown */}
              <div className="flex-1 min-w-0 text-center sm:text-left">
                <div className="flex items-center justify-center sm:justify-start gap-2 mb-1">
                  <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-lg ${riskStyle.bgClass} ${riskStyle.textClass}`}>
                    {gp.buyer_type}
                  </span>
                </div>
                <div className="flex items-center justify-center sm:justify-start gap-2 mb-3">
                  <span className="hud-label">
                    Probabilidad de entrega
                  </span>
                  <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-lg ${riskStyle.bgClass} ${riskStyle.textClass}`}>
                    {gp.risk_label}
                  </span>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="flex items-center gap-2">
                    <Store size={11} className="text-info" />
                    <span className="text-muted-foreground">En tu tienda:</span>
                    <span className="font-bold text-foreground font-mono tabular-nums">{myShop}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Globe size={11} className="text-muted-foreground" />
                    <span className="text-muted-foreground">En otras tiendas:</span>
                    <span className="font-bold text-foreground font-mono tabular-nums">{otherShops}</span>
                  </div>
                </div>

                {/* Delivery / return bars */}
                <div className="mt-3 space-y-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">Entregadas</span>
                    <span className="font-bold text-success font-mono tabular-nums">{totals.delivered} ({dropiScore === null ? '—' : `${dropiScore}%`})</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-foreground/10 overflow-hidden">
                    <div className="h-full rounded-full bg-success transition-all" style={{ width: `${dropiScore ?? 0}%` }} />
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">Devoluciones</span>
                    <span className="font-bold text-danger font-mono tabular-nums">{totals.returned} ({dropiScore === null ? '—' : `${100 - dropiScore}%`})</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-foreground/10 overflow-hidden">
                    <div className="h-full rounded-full bg-danger transition-all" style={{ width: `${dropiScore !== null ? 100 - dropiScore : 0}%` }} />
                  </div>
                  {dropiScore === null && (
                    <p className="text-[10px] text-muted-foreground pt-0.5">
                      Ningún pedido concluido todavía — sin base para calcular porcentajes.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {fpLoading && (
        <div className="px-5 py-3 border-b border-border flex items-center gap-2 text-xs text-info">
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
              data={deliveryScore !== null ? gaugeData : [{ value: 1 }]}
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
              {deliveryScore !== null ? (
                <>
                  <Cell fill={scoreConfig.color} />
                  <Cell fill={GAUGE_REST_COLOR} />
                </>
              ) : (
                <Cell fill={GAUGE_REST_COLOR} />
              )}
            </Pie>
          </PieChart>
          {/* Score number in center */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className={`text-3xl font-bold font-mono tabular-nums ${deliveryScore !== null ? scoreConfig.textClass : 'text-muted-foreground'}`}>
              {deliveryScore !== null ? gaugeScore : '—'}
            </span>
          </div>
        </div>

        {/* Label + insights */}
        <div className="flex-1 min-w-0 text-center sm:text-left">
          <div className="flex items-center justify-center sm:justify-start gap-2 mb-1">
            <span className="hud-label">
              {fingerprint ? 'Tu tienda' : 'Probabilidad de entrega'}
            </span>
          </div>
          <div className="flex items-center justify-center sm:justify-start gap-2 mb-3">
            <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-lg ${
              deliveryScore !== null
                ? `${scoreConfig.bgClass} ${scoreConfig.textClass}`
                : 'bg-muted/40 border border-border text-muted-foreground'
            }`}>
              {deliveryScore !== null ? scoreConfig.label : 'Sin datos'}
            </span>
          </div>
          <ul className="space-y-1.5">
            {insights.map((text, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                <span className={`mt-1 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  deliveryScore === null ? 'bg-muted-foreground'
                    : gaugeScore >= 80 ? 'bg-success' : gaugeScore >= 50 ? 'bg-warning' : 'bg-danger'
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
          <div className="hud-label">Total</div>
          <div className="text-lg font-bold text-foreground font-mono tabular-nums flex items-center justify-center gap-1 mt-0.5">
            <Package size={14} className="text-muted-foreground" />{totalLabel}
          </div>
        </div>
        <div className="p-3 text-center">
          <div className="hud-label">Entregados</div>
          <div className="text-lg font-bold text-success font-mono tabular-nums flex items-center justify-center gap-1 mt-0.5">
            <CheckCircle2 size={14} />{entregados}
          </div>
        </div>
        <div className="p-3 text-center">
          <div className="hud-label">Devueltos</div>
          <div className="text-lg font-bold text-danger font-mono tabular-nums flex items-center justify-center gap-1 mt-0.5">
            <RotateCcw size={14} />{devoluciones}
          </div>
        </div>
        <div className="p-3 text-center">
          <div className="hud-label">Efectividad</div>
          <div className={`text-lg font-bold font-mono tabular-nums flex items-center justify-center gap-1 mt-0.5 ${
            efectividad === null ? 'text-muted-foreground'
              : efectividad >= 80 ? 'text-success' : efectividad >= 50 ? 'text-warning' : 'text-danger'
          }`}>
            {efectividad !== null && efectividad >= 80 && <Star size={14} />}
            {efectividad !== null && efectividad < 50 && <AlertTriangle size={14} />}
            {efectividad === null ? '—' : `${efectividad}%`}
          </div>
          {efectividad === null && (
            <div className="text-[10px] text-muted-foreground mt-0.5 leading-tight">Sin pedidos concluidos</div>
          )}
        </div>
      </div>

      {/* La query del historial trae máximo 20 filas: avisamos que las métricas son de una muestra */}
      {esMuestra && (
        <div className="px-5 py-2 border-b border-border text-[11px] text-muted-foreground">
          Entregados, devueltos, efectividad, probabilidad de entrega y la etiqueta del cliente salen
          de los últimos <span className="font-mono tabular-nums">{orders.length}</span> pedidos
          {totalReal === null ? (
            <>, y no pudimos leer el total del historial: hay más de los que ves.</>
          ) : (
            <>, no de los <span className="font-mono tabular-nums">{totalReal}</span> del historial completo.</>
          )}
        </div>
      )}

      {/* ── AI customer profile ── */}
      {orders.length >= 2 && (() => {
        const aiKey = `profile-${currentPhone}`;
        const ai = getAi(aiKey);
        const buildCtx = () => [
          `Total pedidos: ${totalReal === null ? `al menos ${total}` : totalReal}${esMuestra ? ` (las cifras de abajo salen de los últimos ${orders.length})` : ''}`,
          `Entregados: ${entregados}`,
          `Devoluciones: ${devoluciones}`,
          efectividad === null
            ? 'Efectividad: sin datos — ningún pedido concluido todavía'
            : `Efectividad: ${efectividad}%`,
          deliveryScore === null
            ? 'Score probabilidad entrega: sin datos — cliente sin pedidos concluidos, no afirmes un nivel de riesgo'
            : `Score probabilidad entrega: ${deliveryScore}/100 (${scoreConfig.label})`,
          `Productos pedidos: ${[...new Set(orders.map(o => o.producto).filter(Boolean))].join(', ')}`,
          `Ciudades: ${[...new Set(orders.map(o => o.ciudad).filter(Boolean))].join(', ') || 'N/A'}`,
          `Transportadoras usadas: ${[...new Set(orders.map(o => o.transportadora).filter(Boolean))].join(', ')}`,
          `Pedidos con novedad: ${novedades}`,
          `Valor promedio: ${formatCOP(Math.round(orders.reduce((s, o) => s + (Number(o.valor) || 0), 0) / orders.length))}`,
        ].join('\n');
        return (
          <div className="px-5 py-3 border-b border-border">
            {!ai.reply && !ai.loading && (
              <button onClick={() => askAi(aiKey, 'customer_profile', buildCtx())}
                className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-ai/14 border border-ai/30 text-ai text-sm font-semibold hover:bg-ai/20 hover:border-ai/50 transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-ai/40 focus-visible:outline-none">
                <Sparkles size={12} aria-hidden="true" /> Perfil IA del cliente
              </button>
            )}
            {ai.loading && (
              <div className="flex items-center gap-1.5 py-2 text-xs text-ai">
                <RefreshCw size={12} className="animate-spin" aria-hidden="true" /> Analizando cliente...
              </div>
            )}
            {ai.reply && (
              <div className="relative p-3 pl-4 rounded-2xl bg-card/40 border border-border shadow-card3d text-xs text-foreground whitespace-pre-line leading-relaxed">
                <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-ai" aria-hidden="true" />
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
        <div className="inline-flex flex-wrap gap-2">
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 rounded-xl text-sm transition-colors ${
                activeTab === tab.key
                  ? `font-semibold ${tab.activeClass}`
                  : 'font-medium bg-card/40 border border-border text-muted-foreground hover:text-foreground hover:border-border-strong'
              }`}
            >
              {tab.label}{' '}
              <span className="opacity-70 font-mono tabular-nums">({tabCounts[tab.key]})</span>
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
                  borderRadius: 12,
                  backgroundColor: 'hsl(var(--card))',
                  borderColor: 'hsl(var(--border))',
                }}
                labelStyle={{ fontWeight: 600 }}
              />
              <Bar dataKey="entregados" stackId="a" fill="hsl(var(--success))" name="Entregados" />
              <Bar dataKey="noEntrega"  stackId="a" fill="hsl(var(--danger))"  name="No entrega" />
              <Bar dataKey="enCamino"   stackId="a" fill="hsl(var(--info))"    name="En camino" radius={[3, 3, 0, 0]} />
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
            aria-label={`Pedido #${o.external_id || 'sin ID'} — ${o.estado || 'sin estado'} — ${formatCOP(Number(o.valor) || 0)}`}
            className="w-full text-left px-5 py-3 hover:bg-secondary/40 transition-colors disabled:cursor-not-allowed"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-xs font-mono tabular-nums text-muted-foreground">#{o.external_id || 'sin ID'}</span>
                  <span className="text-[10px] text-muted-foreground">·</span>
                  <span className="text-xs text-muted-foreground font-mono tabular-nums">{o.fecha || '—'}</span>
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
                  <div className="text-[10px] text-muted-foreground mt-0.5 font-mono tabular-nums">{o.transportadora}{o.guia ? ` · ${o.guia}` : ''}</div>
                )}
              </div>
              <div className="flex flex-col items-end gap-1 flex-shrink-0">
                <span className="text-xs font-bold text-foreground font-mono tabular-nums">{formatCOP(Number(o.valor) || 0)}</span>
                <span className={`inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg font-semibold ${estadoColor(o.estado)}`}>
                  {o.estado || '—'}
                </span>
              </div>
            </div>
          </button>
        ))}
        {filteredOrders.length > 10 && (
          <div className="px-5 py-3 text-xs text-muted-foreground text-center bg-card/40 font-mono tabular-nums">
            + {filteredOrders.length - 10} pedidos más
          </div>
        )}
      </div>
    </motion.div>
  );
}
