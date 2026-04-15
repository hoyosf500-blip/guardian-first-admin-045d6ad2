import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { History, CheckCircle2, RotateCcw, Package, Star, AlertTriangle, User, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { truncate } from '@/lib/orderUtils';

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
}

type CustomerBadge =
  | { kind: 'vip'; label: string; className: string }
  | { kind: 'risk'; label: string; className: string }
  | { kind: 'recurrent'; label: string; className: string }
  | null;

function calcBadge(total: number, entregados: number, devoluciones: number): CustomerBadge {
  if (total < 3) return null;
  const effectiveness = (entregados / total) * 100;
  if (effectiveness >= 80) {
    return { kind: 'vip', label: '⭐ CLIENTE VIP', className: 'bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20' };
  }
  if (effectiveness < 50 && devoluciones >= 2) {
    return { kind: 'risk', label: '⚠️ RIESGO — devuelve seguido', className: 'bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20' };
  }
  if (total >= 5) {
    return { kind: 'recurrent', label: 'Cliente recurrente', className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20' };
  }
  return null;
}

function estadoColor(estado: string | null): string {
  if (!estado) return 'bg-muted text-muted-foreground';
  const e = estado.toUpperCase();
  if (e === 'ENTREGADO') return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20';
  if (e.includes('DEVOL')) return 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20';
  if (e === 'NOVEDAD' || e.includes('INTENTO DE ENTREGA')) return 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20';
  if (e.includes('OFICINA') || e.includes('RECLAME')) return 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border border-yellow-500/20';
  if (e === 'PENDIENTE CONFIRMACION') return 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border border-gray-500/20';
  return 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20';
}

export default function CustomerHistoryCard({ currentPhone, currentOrderId }: Props) {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<HistoryOrder[]>([]);
  const [loading, setLoading] = useState(true);

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
        .select('id, external_id, nombre, estado, fecha, fecha_conf, valor, guia, novedad, novedad_sol, producto, transportadora')
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

  if (loading) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-card border border-border rounded-2xl p-5"
      >
        <div className="flex items-center gap-2 mb-4">
          <RefreshCw size={16} className="text-muted-foreground animate-spin" />
          <span className="text-sm text-muted-foreground">Cargando historial del cliente…</span>
        </div>
      </motion.div>
    );
  }

  if (orders.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-card border border-border rounded-2xl p-5"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center flex-shrink-0">
            <User size={18} className="text-blue-500" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-foreground">Historial del cliente</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Este es el primer pedido de este cliente 👋</p>
          </div>
        </div>
      </motion.div>
    );
  }

  // Stats
  const total = orders.length + 1; // +1 for the current order
  const entregados = orders.filter((o) => /ENTREGADO/i.test(o.estado || '')).length;
  const devoluciones = orders.filter((o) => /DEVOL/i.test(o.estado || '')).length;
  const efectividad = Math.round((entregados / total) * 100);

  const badge = calcBadge(total, entregados, devoluciones);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-card border border-border rounded-2xl overflow-hidden"
    >
      {/* Header */}
      <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <History size={16} className="text-primary" />
          <h3 className="text-sm font-bold text-foreground">Historial del cliente</h3>
          <span className="text-xs text-muted-foreground">· {total} pedido{total === 1 ? '' : 's'}</span>
        </div>
        {badge && (
          <span className={`text-[10px] px-2 py-1 rounded-full font-bold ${badge.className}`}>
            {badge.label}
          </span>
        )}
      </div>

      {/* KPI grid */}
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

      {/* Orders list */}
      <div className="max-h-80 overflow-y-auto divide-y divide-border">
        {orders.slice(0, 10).map((o) => (
          <button
            key={o.id}
            onClick={() => o.external_id && navigate(`/pedido/${o.external_id}`)}
            disabled={!o.external_id}
            className="w-full text-left px-5 py-3 hover:bg-secondary/40 transition-colors disabled:cursor-not-allowed"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-xs font-mono text-muted-foreground">#{o.external_id || 'sin ID'}</span>
                  <span className="text-[10px] text-muted-foreground">·</span>
                  <span className="text-xs text-muted-foreground">{o.fecha || '—'}</span>
                </div>
                <div className="text-xs text-foreground truncate">{truncate(o.producto || '—', 50)}</div>
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
        {orders.length > 10 && (
          <div className="px-5 py-3 text-xs text-muted-foreground text-center bg-muted/20">
            + {orders.length - 10} pedidos más no mostrados
          </div>
        )}
      </div>
    </motion.div>
  );
}
