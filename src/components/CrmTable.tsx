import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { OrderData, truncate, getTrackingUrl, calcDias, calcBusinessDays } from '@/lib/orderUtils';
import { getAlertLevel } from '@/lib/alertSystem';
import { toast } from 'sonner';
import {
  AlertTriangle, ExternalLink,
  MessageSquare, Phone as PhoneIcon, Clock, User, Copy,
  Package, Truck, MapPin, RotateCcw, Layers,
  Send, Tag, CheckCircle, ChevronDown, Search
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface Touchpoint {
  id: string;
  phone: string;
  action: string;
  action_date: string;
  action_time: string | null;
  operator_id: string;
  created_at: string;
}

interface Profile {
  user_id: string;
  display_name: string;
}

interface CrmTableProps {
  data: OrderData[];
  actions: string[];
  module: 'SEG' | 'RESCUE';
  emptyIcon: React.ReactNode;
  emptyTitle: string;
  emptyDesc: string;
}

interface StatusColumn {
  key: string;
  label: string;
  icon: React.ReactNode;
  color: string;       // Tailwind color for accents
  bgGradient: string;  // Header gradient
  pillBg: string;      // Filter pill background
  pillText: string;    // Filter pill text
  match: (estado: string) => boolean;
}

const STATUS_COLUMNS: StatusColumn[] = [
  {
    key: 'procesamiento', label: 'En Procesamiento', icon: <Package size={14} />,
    color: 'blue', bgGradient: 'from-blue-500 to-blue-600',
    pillBg: 'bg-blue-500/10 border-blue-500/20 hover:bg-blue-500/20', pillText: 'text-blue-600 dark:text-blue-400',
    match: (e) => ['PENDIENTE', 'EN PROCESAMIENTO', 'EN PUNTO DROOP', 'ALISTAMIENTO', 'EN BODEGA DROPI', 'RECOGIDO POR DROPI'].includes(e)
  },
  {
    key: 'guia', label: 'Guía Generada', icon: <Tag size={14} />,
    color: 'cyan', bgGradient: 'from-cyan-500 to-teal-500',
    pillBg: 'bg-cyan-500/10 border-cyan-500/20 hover:bg-cyan-500/20', pillText: 'text-cyan-600 dark:text-cyan-400',
    match: (e) => ['GUIA GENERADA', 'GUIA_GENERADA', 'PREPARADO PARA TRANSPORTADORA', 'ENTREGADO A TRANSPORTADORA'].includes(e)
  },
  {
    key: 'bodega_trans', label: 'Bodega Transportadora', icon: <Package size={14} />,
    color: 'indigo', bgGradient: 'from-indigo-500 to-indigo-600',
    pillBg: 'bg-indigo-500/10 border-indigo-500/20 hover:bg-indigo-500/20', pillText: 'text-indigo-600 dark:text-indigo-400',
    match: (e) => ['EN BODEGA TRANSPORTADORA', 'ADMITIDA'].includes(e)
  },
  {
    key: 'transito', label: 'En Tránsito', icon: <Truck size={14} />,
    color: 'orange', bgGradient: 'from-orange-500 to-amber-500',
    pillBg: 'bg-orange-500/10 border-orange-500/20 hover:bg-orange-500/20', pillText: 'text-orange-600 dark:text-orange-400',
    match: (e) => ['EN TRANSPORTE', 'EN DESPACHO', 'EN TRASLADO NACIONAL', 'EN TERMINAL ORIGEN', 'EN TERMINAL DESTINO', 'ENTREGADA A CONEXIONES'].includes(e)
  },
  {
    key: 'reparto', label: 'En Reparto', icon: <Truck size={14} />,
    color: 'amber', bgGradient: 'from-amber-500 to-yellow-500',
    pillBg: 'bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/20', pillText: 'text-amber-600 dark:text-amber-400',
    match: (e) => ['EN REPARTO', 'TELEMERCADEO', 'REENVÍO', 'REENVIO', 'EN DISTRIBUCION', 'EN REEXPEDICION'].includes(e)
  },
  {
    key: 'novedad', label: 'Novedad', icon: <AlertTriangle size={14} />,
    color: 'red', bgGradient: 'from-red-500 to-rose-500',
    pillBg: 'bg-red-500/10 border-red-500/20 hover:bg-red-500/20', pillText: 'text-red-600 dark:text-red-400',
    match: (e) => e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA'
  },
  {
    key: 'oficina', label: 'Reclame en Oficina', icon: <MapPin size={14} />,
    color: 'purple', bgGradient: 'from-fuchsia-500 to-purple-600',
    pillBg: 'bg-purple-500/10 border-purple-500/20 hover:bg-purple-500/20', pillText: 'text-purple-600 dark:text-purple-400',
    match: (e) => e.includes('OFICINA') || e.includes('RECLAME')
  },
  {
    key: 'rechazado', label: 'Rechazado', icon: <AlertTriangle size={14} />,
    color: 'yellow', bgGradient: 'from-yellow-600 to-orange-600',
    pillBg: 'bg-yellow-500/10 border-yellow-500/20 hover:bg-yellow-500/20', pillText: 'text-yellow-600 dark:text-yellow-400',
    match: (e) => e === 'RECHAZADO'
  },
  {
    key: 'novedad_sol', label: 'Novedad Solucionada', icon: <CheckCircle size={14} />,
    color: 'teal', bgGradient: 'from-teal-500 to-emerald-500',
    pillBg: 'bg-teal-500/10 border-teal-500/20 hover:bg-teal-500/20', pillText: 'text-teal-600 dark:text-teal-400',
    match: (e) => e === 'NOVEDAD SOLUCIONADA'
  },
  {
    key: 'devolucion_transito', label: 'Devolución en Tránsito', icon: <RotateCcw size={14} />,
    color: 'pink', bgGradient: 'from-pink-500 to-rose-500',
    pillBg: 'bg-pink-500/10 border-pink-500/20 hover:bg-pink-500/20', pillText: 'text-pink-600 dark:text-pink-400',
    match: (e) => e === 'DEVOLUCION EN TRANSITO'
  },
  {
    key: 'devolucion', label: 'Devolución', icon: <RotateCcw size={14} />,
    color: 'rose', bgGradient: 'from-rose-600 to-red-600',
    pillBg: 'bg-rose-500/10 border-rose-500/20 hover:bg-rose-500/20', pillText: 'text-rose-600 dark:text-rose-400',
    match: (e) => e === 'DEVOLUCION'
  },
  {
    key: 'indemnizada', label: 'Indemnizada', icon: <DollarSign size={14} />,
    color: 'violet', bgGradient: 'from-violet-500 to-purple-600',
    pillBg: 'bg-violet-500/10 border-violet-500/20 hover:bg-violet-500/20', pillText: 'text-violet-600 dark:text-violet-400',
    match: (e) => e.includes('INDEMNIZADA')
  },
  {
    key: 'entregado', label: 'Entregado', icon: <CheckCircle size={14} />,
    color: 'emerald', bgGradient: 'from-emerald-500 to-green-500',
    pillBg: 'bg-emerald-500/10 border-emerald-500/20 hover:bg-emerald-500/20', pillText: 'text-emerald-600 dark:text-emerald-400',
    match: (e) => e === 'ENTREGADO'
  },
  {
    key: 'cancelado', label: 'Cancelado', icon: <Layers size={14} />,
    color: 'slate', bgGradient: 'from-slate-500 to-slate-600',
    pillBg: 'bg-slate-500/10 border-slate-500/20 hover:bg-slate-500/20', pillText: 'text-slate-600 dark:text-slate-400',
    match: (e) => e === 'CANCELADO'
  },
  {
    key: 'otros', label: 'Otros', icon: <Layers size={14} />,
    color: 'slate', bgGradient: 'from-gray-500 to-gray-600',
    pillBg: 'bg-gray-500/10 border-gray-500/20 hover:bg-gray-500/20', pillText: 'text-gray-600 dark:text-gray-400',
    match: () => true
  },
];

function classifyOrder(estado: string): string {
  const e = estado.toUpperCase();
  for (const col of STATUS_COLUMNS) {
    if (col.key !== 'otros' && col.match(e)) return col.key;
  }
  return 'otros';
}

function getOrderStatusAgeDays(order: OrderData): number {
  const baseDate = (order.fechaConf || order.fecha || '').trim();
  if (baseDate && baseDate !== 'undefined') {
    return calcBusinessDays(baseDate);
  }
  const calendarDays = order.diasConf || order.dias || 0;
  return Math.round(calendarDays * 5 / 7);
}

function isExcludedFromDelay(estado: string): boolean {
  const e = estado.toUpperCase();
  return e === 'ENTREGADO' || e.includes('DEVOL') || e === 'CANCELADO' || e === 'RECHAZADO';
}

export default function CrmTable({ data, actions, module, emptyIcon, emptyTitle, emptyDesc }: CrmTableProps) {
  const { user } = useAuth();
  const [touchpoints, setTouchpoints] = useState<Touchpoint[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [results, setResults] = useState<Record<string, string>>({});
  const [expandedPhone, setExpandedPhone] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [onlyDelayed, setOnlyDelayed] = useState(false);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  useEffect(() => {
    if (!data.length) return;
    const phones = [...new Set(data.map(o => o.phone))];
    const prefix = module === 'SEG' ? 'SEG' : 'RESCUE';

    const fetchAllTouchpoints = async () => {
      const allTp: Touchpoint[] = [];
      for (let i = 0; i < phones.length; i += 100) {
        const batch = phones.slice(i, i + 100);
        const { data: tp } = await supabase.from('touchpoints')
          .select('*')
          .in('phone', batch)
          .order('created_at', { ascending: false });
        if (tp) allTp.push(...(tp as Touchpoint[]));
      }
      return allTp;
    };

    fetchAllTouchpoints().then(allTp => {
      const moduleTp = allTp.filter(t => t.action.startsWith(`${prefix}:`) || t.action.startsWith(`${module}:`));
      setTouchpoints(moduleTp);
      const managed: Record<string, string> = {};
      const today = new Date().toISOString().split('T')[0];
      moduleTp.forEach(t => {
        if (t.action_date === today && !managed[t.phone]) {
          managed[t.phone] = t.action.replace(/^(SEG|RESCUE): ?/, '');
        }
      });
      setResults(managed);
    });

    supabase.from('profiles').select('user_id, display_name').then(({ data: p }) => {
      if (p) setProfiles(p);
    });
  }, [data, module]);

  const getOperatorName = (opId: string) => profiles.find(pr => pr.user_id === opId)?.display_name || 'Operador';

  const phoneTouchpoints = useMemo(() => {
    const map: Record<string, Touchpoint[]> = {};
    touchpoints.forEach(tp => {
      if (!map[tp.phone]) map[tp.phone] = [];
      map[tp.phone].push(tp);
    });
    return map;
  }, [touchpoints]);

  const getLastTouchTime = useCallback((phone: string): number | null => {
    const tps = phoneTouchpoints[phone];
    if (!tps || !tps.length) return null;
    return new Date(tps[0].created_at).getTime();
  }, [phoneTouchpoints]);

  const markAction = async (phone: string, action: string) => {
    setResults(prev => ({ ...prev, [phone]: action }));
    if (user) {
      const now = new Date();
      const tp = {
        phone,
        action: `${module}: ${action}`,
        operator_id: user.id,
        action_date: now.toISOString().split('T')[0],
        action_time: now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }),
      };
      const { data: inserted } = await supabase.from('touchpoints').insert(tp).select();
      if (inserted) setTouchpoints(prev => [...inserted, ...prev]);
    }
    toast.success(action);
  };

  const delayedCount = useMemo(() => data.filter(order => !isExcludedFromDelay(order.estado) && getOrderStatusAgeDays(order) >= 2).length, [data]);

  const filtered = useMemo(() => {
    let list = data;
    if (search) {
      const s = search.toLowerCase();
      list = list.filter(o =>
        o.nombre.toLowerCase().includes(s) || o.phone.includes(s) ||
        (o.guia || '').toLowerCase().includes(s) || (o.ciudad || '').toLowerCase().includes(s)
      );
    }
    if (onlyDelayed) {
      list = list.filter(order => !isExcludedFromDelay(order.estado) && getOrderStatusAgeDays(order) >= 2);
    }
    if (activeFilter) {
      list = list.filter(o => classifyOrder(o.estado) === activeFilter);
    }
    return list;
  }, [data, search, onlyDelayed, activeFilter]);

  const columns = useMemo(() => {
    const groups: Record<string, OrderData[]> = {};
    STATUS_COLUMNS.forEach(c => { groups[c.key] = []; });
    filtered.forEach(o => {
      const key = classifyOrder(o.estado);
      groups[key].push(o);
    });
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => getOrderStatusAgeDays(b) - getOrderStatusAgeDays(a));
    }
    return groups;
  }, [filtered]);

  // Count all data (not filtered) for pills
  const allCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    STATUS_COLUMNS.forEach(c => { counts[c.key] = 0; });
    data.forEach(o => { counts[classifyOrder(o.estado)]++; });
    return counts;
  }, [data]);

  if (!data.length) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-16 h-16 rounded-2xl bg-secondary flex items-center justify-center mb-4">{emptyIcon}</div>
        <h3 className="text-base font-semibold text-foreground mb-1">{emptyTitle}</h3>
        <p className="text-sm text-muted-foreground max-w-xs">{emptyDesc}</p>
      </div>
    );
  }

  const activeColumns = activeFilter
    ? STATUS_COLUMNS.filter(c => c.key === activeFilter && columns[c.key].length > 0)
    : STATUS_COLUMNS.filter(c => columns[c.key].length > 0);

  return (
    <div className="space-y-5">
      {/* Search + delayed filter */}
      <div className="flex flex-col gap-3 lg:flex-row">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Buscar nombre, teléfono, guía, ciudad..."
            className="w-full pl-11 pr-4 py-3 bg-card border border-border rounded-xl text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all"
          />
        </div>
        <button
          type="button"
          aria-pressed={onlyDelayed}
          onClick={() => setOnlyDelayed(prev => !prev)}
          className={`inline-flex items-center justify-center gap-2 rounded-xl border px-5 py-3 text-sm font-semibold transition-all whitespace-nowrap ${
            onlyDelayed
              ? 'border-orange-500 bg-orange-500 text-white shadow-lg shadow-orange-500/25'
              : 'border-border bg-card text-foreground hover:border-orange-400/40 hover:text-orange-500'
          }`}
        >
          <Clock size={15} />
          <span>Retrasados (2d+)</span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${onlyDelayed ? 'bg-white/25 text-white' : 'bg-secondary text-foreground'}`}>
            {delayedCount}
          </span>
        </button>
      </div>

      {/* Status filter pills */}
      <div className="flex gap-2 flex-wrap">
        {STATUS_COLUMNS.filter(c => allCounts[c.key] > 0).map(col => {
          const isActive = activeFilter === col.key;
          return (
            <button
              key={col.key}
              onClick={() => setActiveFilter(isActive ? null : col.key)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border transition-all ${
                isActive
                  ? `bg-gradient-to-r ${col.bgGradient} text-white border-transparent shadow-lg`
                  : `${col.pillBg} ${col.pillText} border`
              }`}
            >
              {col.icon}
              <span>{col.label}</span>
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                isActive ? 'bg-white/25' : 'bg-secondary'
              }`}>
                {allCounts[col.key]}
              </span>
            </button>
          );
        })}
      </div>

      {onlyDelayed && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-orange-500/20 bg-orange-500/5 px-4 py-3">
          <div className="text-sm font-semibold text-foreground flex items-center gap-2">
            <AlertTriangle size={14} className="text-orange-500" />
            Mostrando solo pedidos con 2+ días hábiles sin movimiento
          </div>
          <div className="text-xs text-muted-foreground">{filtered.length} de {data.length} pedidos</div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/40 px-6 py-16 text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
            <Search size={20} />
          </div>
          <h3 className="text-base font-semibold text-foreground">No hay pedidos para este filtro</h3>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {onlyDelayed ? 'No encontramos pedidos retrasados.' : 'Prueba ajustando la búsqueda.'}
          </p>
        </div>
      ) : (
        <div className="relative">
          {/* Scroll fade indicators */}
          <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-6 z-10 bg-gradient-to-r from-background to-transparent opacity-0 transition-opacity" id="scroll-fade-left" />
          <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-6 z-10 bg-gradient-to-l from-background to-transparent" />
          <div className="overflow-x-auto pb-4 -mx-2 px-2 scroll-hint">
            <div className="flex gap-3" style={{ minWidth: `${activeColumns.length * 300}px` }}>
            {activeColumns.map((col, colIdx) => {
              const items = columns[col.key];
              return (
                <motion.div
                  key={col.key}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: colIdx * 0.04, duration: 0.25 }}
                  className="flex-1 min-w-[280px] max-w-[340px] flex flex-col"
                >
                  {/* Column header */}
                  <div className={`bg-gradient-to-r ${col.bgGradient} rounded-t-xl px-4 py-3 flex items-center justify-between`}>
                    <div className="flex items-center gap-2.5 text-white">
                      <div className="w-7 h-7 rounded-lg bg-white/15 backdrop-blur-sm flex items-center justify-center">
                        {col.icon}
                      </div>
                      <span className="text-sm font-bold">{col.label}</span>
                    </div>
                    <span className="text-white/90 text-lg font-black bg-white/20 backdrop-blur-sm rounded-lg px-3 py-0.5 min-w-[36px] text-center">
                      {items.length}
                    </span>
                  </div>

                  {/* Column body */}
                  <div className="bg-card/50 rounded-b-xl border border-border/40 border-t-0 flex-1 p-2 space-y-2 max-h-[70vh] overflow-y-auto">
                    {items.map((o, i) => (
                      <OrderCard
                        key={o.phone + o.idx}
                        order={o}
                        managed={results[o.phone]}
                        expanded={expandedPhone === o.phone}
                        onToggle={() => setExpandedPhone(expandedPhone === o.phone ? null : o.phone)}
                        onAction={(action) => markAction(o.phone, action)}
                        actions={actions}
                        touchpoints={phoneTouchpoints[o.phone] || []}
                        getOperatorName={getOperatorName}
                        getLastTouchTime={getLastTouchTime}
                        module={module}
                        index={i}
                        statusColor={col.color}
                      />
                    ))}
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
        </div>
      )}
    </div>
  );
}

/* ── Order Card ── */
interface OrderCardProps {
  order: OrderData;
  managed: string | undefined;
  expanded: boolean;
  onToggle: () => void;
  onAction: (action: string) => void;
  actions: string[];
  touchpoints: Touchpoint[];
  getOperatorName: (id: string) => string;
  getLastTouchTime: (phone: string) => number | null;
  module: string;
  index: number;
  statusColor: string;
}

function OrderCard({ order: o, managed, expanded, onToggle, onAction, actions, touchpoints: tps, getOperatorName, index, statusColor }: OrderCardProps) {
  const diasEnEstatus = getOrderStatusAgeDays(o);
  const alert = getAlertLevel(diasEnEstatus, o.dias, o.estado, o.transportadora);
  const trackUrl = getTrackingUrl(o.transportadora, o.guia);
  const waMsg = encodeURIComponent(`Hola ${o.nombre}, le escribo sobre su pedido${o.guia ? ` (guía ${o.guia})` : ''}. ¿Cómo va la entrega?`);

  const isDelayed = diasEnEstatus >= 2;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.015, 0.3), duration: 0.2 }}
      className={`group bg-card rounded-xl border border-border/50 overflow-hidden transition-all duration-200 hover:border-border hover:shadow-md ${managed ? 'opacity-40' : ''}`}
    >
      {/* Card body */}
      <div className="px-3.5 pt-3.5 pb-3 cursor-pointer" onClick={onToggle}>
        {/* Name + ID + days */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-bold text-foreground truncate">{o.nombre}</div>
            {o.externalId && (
              <a href={`/pedido/${o.externalId}`} onClick={e => e.stopPropagation()} className="text-[10px] text-primary hover:underline font-mono mt-0.5 block truncate">
                {o.externalId}
              </a>
            )}
            {!o.externalId && <div className="text-[10px] text-muted-foreground font-mono mt-0.5">Sin ID</div>}
          </div>
          <span className="flex-shrink-0 text-[9px] font-bold px-2 py-0.5 rounded-md bg-secondary text-muted-foreground uppercase tracking-wide leading-tight max-w-[120px] truncate">
            {o.estado}
          </span>
        </div>

        {/* Phone row */}
        <div className="flex items-center gap-1.5 mt-2.5">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground bg-secondary/70 rounded-lg px-2.5 py-1.5 flex-1 min-w-0">
            <PhoneIcon size={11} className="flex-shrink-0 text-muted-foreground/70" />
            <span className="truncate font-mono">{o.phone}</span>
          </div>
          <button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.phone); toast.success('Tel copiado'); }}
            className="p-2 rounded-lg bg-secondary/70 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
            <Copy size={11} />
          </button>
        </div>

        {/* Location & carrier */}
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          {o.ciudad && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground bg-secondary/50 rounded-md px-2 py-1">
              <MapPin size={9} className="text-muted-foreground/60" />{o.ciudad}
            </span>
          )}
          {o.transportadora && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground bg-secondary/50 rounded-md px-2 py-1">
              <Truck size={9} className="text-muted-foreground/60" />{o.transportadora}
            </span>
          )}
        </div>

        {/* Guía + tracking */}
        {o.guia && (
          <div className="mt-2.5 flex items-center gap-2">
            <div className="flex flex-1 min-w-0 items-center gap-1.5 rounded-lg bg-secondary/50 px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground">
              <Tag size={9} className="text-muted-foreground/60 flex-shrink-0" />
              <span className="truncate">{o.guia}</span>
              <button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.guia); toast.success('Guía copiada'); }}
                className="flex-shrink-0 transition-colors hover:text-foreground"><Copy size={9} /></button>
            </div>
            {trackUrl && (
              <a
                href={trackUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.guia); toast.success('Guía copiada'); }}
                className="inline-flex flex-shrink-0 items-center gap-1 rounded-lg bg-orange-500 px-3 py-1.5 text-[10px] font-bold text-white shadow-sm transition-all hover:bg-orange-600 no-underline"
              >
                <ExternalLink size={10} /> Rastrear
              </a>
            )}
          </div>
        )}

        {/* Delay warning */}
        {isDelayed && !isExcludedFromDelay(o.estado) && (
          <div className={`mt-2.5 flex items-center gap-2 rounded-lg px-3 py-2 ${
            diasEnEstatus >= 5 ? 'bg-red-500/10 border border-red-500/20' :
            diasEnEstatus >= 3 ? 'bg-amber-500/10 border border-amber-500/20' :
            'bg-orange-400/10 border border-orange-400/20'
          }`}>
            <Clock size={11} className={diasEnEstatus >= 5 ? 'text-red-500' : diasEnEstatus >= 3 ? 'text-amber-500' : 'text-orange-400'} />
            <span className={`text-[10px] font-semibold ${diasEnEstatus >= 5 ? 'text-red-500' : diasEnEstatus >= 3 ? 'text-amber-500' : 'text-orange-400'}`}>
              {diasEnEstatus}d sin movimiento — {diasEnEstatus >= 5 ? 'Posible pérdida' : diasEnEstatus >= 3 ? 'Llamar + reclamar' : 'Monitorear'}
            </span>
          </div>
        )}

        {/* Alert badge */}
        {alert && alert.level !== 'ok' && alert.level !== 'watch' && (
          <div className="mt-2">
            <span className={`inline-block text-[10px] font-semibold px-2.5 py-1 rounded-md ${
              alert.level === 'lost' ? 'bg-muted text-muted-foreground' :
              alert.level === 'critical' ? 'bg-red-500/10 text-red-500' :
              'bg-orange-500/10 text-orange-500'
            }`}>
              {alert.label}
            </span>
          </div>
        )}

        {/* Managed badge */}
        {managed && (
          <div className="mt-2">
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <CheckCircle size={10} /> {managed}
            </span>
          </div>
        )}
      </div>

      {/* Expanded panel */}
      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="border-t border-border/40 overflow-hidden">
            <div className="px-3.5 py-3.5 space-y-3 bg-secondary/30">
              {/* Info grid */}
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'Producto', value: truncate(o.producto || '—', 30) },
                  { label: 'Valor', value: `$${o.valor.toLocaleString()}` },
                  { label: 'Dirección', value: truncate(o.direccion || '—', 35) },
                  { label: 'Departamento', value: o.departamento || '—' },
                ].map(d => (
                  <div key={d.label} className="bg-card rounded-lg p-2.5 border border-border/30">
                    <div className="text-[9px] text-muted-foreground uppercase tracking-wider font-medium">{d.label}</div>
                    <div className="text-[11px] font-semibold text-foreground mt-0.5 truncate">{d.value}</div>
                  </div>
                ))}
              </div>

              {/* Novedad */}
              {o.novedad && (
                <div className="flex items-start gap-2 bg-orange-500/5 border border-orange-500/10 rounded-lg px-3 py-2">
                  <AlertTriangle size={12} className="text-orange-500 mt-0.5 flex-shrink-0" />
                  <span className="text-[11px] text-foreground/80 leading-snug">{truncate(o.novedad, 100)}</span>
                </div>
              )}

              {/* History */}
              {tps.length > 0 && (
                <div>
                  <h4 className="text-[10px] font-semibold text-muted-foreground mb-2 inline-flex items-center gap-1 uppercase tracking-wider">
                    <MessageSquare size={10} /> Historial ({tps.length})
                  </h4>
                  <div className="space-y-1 max-h-28 overflow-y-auto">
                    {tps.slice(0, 5).map(tp => (
                      <div key={tp.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-card border border-border/20 text-[10px]">
                        <div className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                          <User size={9} className="text-primary/70" />
                        </div>
                        <span className="font-semibold text-foreground">{getOperatorName(tp.operator_id)}</span>
                        <span className="text-muted-foreground truncate">{tp.action.replace(/^(SEG|RESCUE): ?/, '')}</span>
                        <span className="ml-auto text-muted-foreground/70 flex-shrink-0 text-[9px]">
                          {tp.action_time || ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Quick actions */}
              <div className="flex gap-2">
                <a href={`https://wa.me/57${o.phone}?text=${waMsg}`} target="_blank" rel="noopener noreferrer"
                  onClick={() => onAction('WhatsApp enviado')}
                  className="flex-1 text-[11px] py-2.5 rounded-lg bg-emerald-500 text-white font-semibold hover:bg-emerald-600 no-underline inline-flex items-center justify-center gap-1.5 transition-colors">
                  <Send size={12} /> WhatsApp
                </a>
                <a href={`tel:+57${o.phone}`}
                  className="flex-1 text-[11px] py-2.5 rounded-lg bg-secondary text-foreground font-semibold hover:bg-secondary/80 no-underline inline-flex items-center justify-center gap-1.5 border border-border/50 transition-colors">
                  <PhoneIcon size={12} /> Llamar
                </a>
              </div>

              {/* CRM actions */}
              {!managed && (
                <div className="flex flex-wrap gap-1.5">
                  {actions.map(a => (
                    <button key={a} onClick={() => onAction(a)}
                      className="text-[10px] px-3 py-1.5 rounded-lg bg-primary/10 text-primary font-semibold hover:bg-primary/20 border border-primary/15 whitespace-nowrap transition-colors">
                      {a}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
