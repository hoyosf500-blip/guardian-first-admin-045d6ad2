import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { OrderData, truncate, getTrackingUrl, calcDias, calcBusinessDays } from '@/lib/orderUtils';
import { getAlertLevel } from '@/lib/alertSystem';
import { toast } from 'sonner';
import {
  AlertTriangle, ExternalLink,
  MessageSquare, Phone as PhoneIcon, Clock, User, Copy,
  Package, Truck, MapPin, RotateCcw, Layers,
  Send, Tag, CheckCircle
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
  gradient: string;
  glow: string;
  dotColor: string;
  match: (estado: string) => boolean;
}

const STATUS_COLUMNS: StatusColumn[] = [
  { key: 'bodega', label: 'En Bodega', icon: <Package size={15} />, gradient: 'from-blue-600 to-blue-400', glow: 'shadow-blue-500/20', dotColor: 'bg-blue-400', match: (e) => ['PENDIENTE', 'ALISTAMIENTO', 'EN PROCESAMIENTO', 'EN BODEGA DROPI', 'RECOGIDO POR DROPI'].includes(e) || (e.includes('BODEGA') && !e.includes('DEVOL')) },
  { key: 'guia', label: 'Guía Generada', icon: <Tag size={15} />, gradient: 'from-cyan-600 to-cyan-400', glow: 'shadow-cyan-500/20', dotColor: 'bg-cyan-400', match: (e) => e === 'GUIA GENERADA' || e === 'GUIA_GENERADA' || e.includes('PREPARADO') || e === 'ENTREGADO A TRANSPORTADORA' },
  { key: 'transito', label: 'En Tránsito', icon: <Truck size={15} />, gradient: 'from-violet-600 to-indigo-400', glow: 'shadow-violet-500/20', dotColor: 'bg-violet-400', match: (e) => e.includes('REPARTO') || e.includes('DISTRIBUCION') || e.includes('TERMINAL') || e.includes('REEXPEDICION') || e.includes('DESPACHAD') || e.includes('REENVÍO') || e.includes('REENVIO') || e.includes('TRANSPORTE') || e === 'ADMITIDA' || e === 'EN DESPACHO' || e === 'TELEMERCADEO' },
  { key: 'novedad', label: 'Novedad', icon: <AlertTriangle size={15} />, gradient: 'from-amber-600 to-orange-400', glow: 'shadow-orange-500/20', dotColor: 'bg-orange-400', match: (e) => e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA' },
  { key: 'oficina', label: 'En Oficina', icon: <MapPin size={15} />, gradient: 'from-fuchsia-600 to-purple-400', glow: 'shadow-purple-500/20', dotColor: 'bg-purple-400', match: (e) => e.includes('OFICINA') || e.includes('RECLAME') },
  { key: 'devolucion', label: 'Devolución', icon: <RotateCcw size={15} />, gradient: 'from-red-600 to-rose-400', glow: 'shadow-red-500/20', dotColor: 'bg-red-400', match: (e) => e.includes('DEVOL') },
  { key: 'entregado', label: 'Entregado', icon: <CheckCircle size={15} />, gradient: 'from-emerald-600 to-green-400', glow: 'shadow-green-500/20', dotColor: 'bg-green-400', match: (e) => e === 'ENTREGADO' },
  { key: 'otros', label: 'Otros', icon: <Layers size={15} />, gradient: 'from-slate-600 to-slate-400', glow: 'shadow-slate-500/10', dotColor: 'bg-slate-400', match: () => true },
];

function classifyOrder(estado: string): string {
  const e = estado.toUpperCase();
  for (const col of STATUS_COLUMNS) {
    if (col.key !== 'otros' && col.match(e)) return col.key;
  }
  return 'otros';
}

function getOrderStatusAgeDays(order: OrderData): number {
  // Use business days (Mon-Fri) — carriers don't work weekends
  const baseDate = (order.fechaConf || order.fecha || '').trim();
  if (baseDate && baseDate !== 'undefined') {
    return calcBusinessDays(baseDate);
  }
  // Fallback: rough estimate from pre-calculated fields (calendar days * 5/7)
  const calendarDays = order.diasConf || order.dias || 0;
  return Math.round(calendarDays * 5 / 7);
}

/** Returns true if this order's status should be excluded from "delayed" tracking */
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

  useEffect(() => {
    if (!data.length) return;
    const phones = [...new Set(data.map(o => o.phone))];
    const prefix = module === 'SEG' ? 'SEG' : 'RESCUE';

    // Fetch touchpoints in batches of 100 phones to avoid Supabase .in() limit
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
    return list;
  }, [data, search, onlyDelayed]);

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

  if (!data.length) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-16 h-16 rounded-2xl bg-secondary flex items-center justify-center mb-4">{emptyIcon}</div>
        <h3 className="text-base font-semibold text-foreground mb-1">{emptyTitle}</h3>
        <p className="text-sm text-muted-foreground max-w-xs">{emptyDesc}</p>
      </div>
    );
  }

  const activeColumns = STATUS_COLUMNS.filter(c => columns[c.key].length > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row">
        <input type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Buscar nombre, teléfono, guía, ciudad..."
          className="flex-1 pl-4 pr-4 py-3 bg-card border border-border rounded-2xl text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all shadow-sm"
        />
        <button
          type="button"
          aria-pressed={onlyDelayed}
          onClick={() => setOnlyDelayed(prev => !prev)}
          className={`inline-flex items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold transition-all whitespace-nowrap ${
            onlyDelayed
              ? 'border-orange bg-orange text-primary-foreground shadow-lg shadow-orange/25'
              : 'border-border bg-card text-foreground hover:border-orange/40 hover:text-orange'
          }`}
        >
          <Clock size={15} />
          <span>{onlyDelayed ? 'Viendo retrasados' : 'Retrasados (2d+)'}</span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${onlyDelayed ? 'bg-background/20 text-primary-foreground' : 'bg-secondary text-foreground'}`}>
            {delayedCount}
          </span>
        </button>
      </div>

      {onlyDelayed && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-orange/20 bg-orange/10 px-4 py-3">
          <div className="text-sm font-semibold text-foreground">Mostrando solo pedidos con 2+ días sin movimiento</div>
          <div className="text-xs text-muted-foreground">{filtered.length} de {data.length} pedidos</div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-border bg-card/40 px-6 py-16 text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-secondary text-muted-foreground">
            <Clock size={20} />
          </div>
          <h3 className="text-base font-semibold text-foreground">No hay pedidos para este filtro</h3>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {onlyDelayed ? 'No encontramos pedidos con 2 o más días sin movimiento.' : 'Prueba ajustando la búsqueda para ver resultados.'}
          </p>
        </div>
      ) : (
        <>
          <div className="flex gap-2 flex-wrap">
            {activeColumns.map(col => (
              <div key={col.key} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gradient-to-r ${col.gradient} shadow-lg ${col.glow} text-white text-[11px] font-semibold`}>
                {col.icon}
                <span>{col.label}</span>
                <span className="bg-white/25 backdrop-blur-sm rounded-full px-1.5 py-0.5 text-[10px] font-bold ml-0.5">{columns[col.key].length}</span>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto pb-4 -mx-2 px-2">
            <div className="flex gap-4" style={{ minWidth: `${activeColumns.length * 290}px` }}>
              {activeColumns.map((col, colIdx) => {
                const items = columns[col.key];
                return (
                  <motion.div
                    key={col.key}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: colIdx * 0.05, duration: 0.3 }}
                    className="flex-1 min-w-[270px] max-w-[330px] flex flex-col"
                  >
                    <div className={`bg-gradient-to-r ${col.gradient} rounded-t-2xl px-4 py-3 flex items-center justify-between shadow-lg ${col.glow}`}>
                      <div className="flex items-center gap-2 text-white">
                        <div className="w-7 h-7 rounded-lg bg-white/20 backdrop-blur-sm flex items-center justify-center">
                          {col.icon}
                        </div>
                        <span className="text-sm font-bold tracking-tight">{col.label}</span>
                      </div>
                      <span className="text-white text-sm font-black bg-white/25 backdrop-blur-sm rounded-xl px-3 py-1">{items.length}</span>
                    </div>

                    <div className="bg-card/30 backdrop-blur-sm rounded-b-2xl border border-border/50 border-t-0 flex-1 p-2.5 space-y-2.5 max-h-[68vh] overflow-y-auto scrollbar-thin">
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
                        />
                      ))}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </>
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
}

function OrderCard({ order: o, managed, expanded, onToggle, onAction, actions, touchpoints: tps, getOperatorName, index }: OrderCardProps) {
  const diasEnEstatus = getOrderStatusAgeDays(o);
  const alert = getAlertLevel(diasEnEstatus, o.dias, o.estado, o.transportadora);
  const trackUrl = getTrackingUrl(o.transportadora, o.guia);
  const waMsg = encodeURIComponent(`Hola ${o.nombre}, le escribo sobre su pedido${o.guia ? ` (guía ${o.guia})` : ''}. ¿Cómo va la entrega?`);

  const isDelayed = diasEnEstatus >= 2;
  const diasBg = diasEnEstatus >= 7 ? 'bg-red-500' : diasEnEstatus >= 5 ? 'bg-red-400' : diasEnEstatus >= 3 ? 'bg-amber-500' : diasEnEstatus >= 2 ? 'bg-orange-400' : 'bg-emerald-500';
  const borderAlert = diasEnEstatus >= 5 ? 'border-l-red-500' : diasEnEstatus >= 3 ? 'border-l-amber-500' : diasEnEstatus >= 2 ? 'border-l-orange-400' : 'border-l-transparent';

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: index * 0.02, duration: 0.2 }}
      className={`group bg-card rounded-xl border border-border/60 border-l-[3px] ${borderAlert} overflow-hidden transition-all duration-200 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5 ${managed ? 'opacity-50' : ''}`}
    >
      {/* Card header */}
      <div className="px-3.5 py-3 cursor-pointer" onClick={onToggle}>
        {/* Top row: name + days badge */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-bold text-foreground truncate leading-tight">{o.nombre}</div>
            <div className="text-[10px] text-muted-foreground/70 font-mono mt-0.5">{o.externalId}</div>
          </div>
          <span className={`${diasBg} text-white text-[11px] font-black px-2.5 py-1 rounded-lg shadow-sm flex-shrink-0`}>
            D{diasEnEstatus}
          </span>
        </div>

        {/* Phone + copy */}
        <div className="flex items-center gap-1.5 mt-2">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground bg-secondary/60 rounded-lg px-2.5 py-1.5 flex-1 min-w-0">
            <PhoneIcon size={11} className="flex-shrink-0" />
            <span className="truncate font-mono">{o.phone}</span>
          </div>
          <button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.phone); toast.success('Tel copiado'); }}
            className="p-2 rounded-lg bg-secondary/60 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
            <Copy size={11} />
          </button>
        </div>

        {/* Location & carrier */}
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          {o.ciudad && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground bg-secondary/40 rounded-md px-2 py-1">
              <MapPin size={9} className="text-primary/60" />{o.ciudad}
            </span>
          )}
          {o.transportadora && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground bg-secondary/40 rounded-md px-2 py-1">
              <Truck size={9} className="text-primary/60" />{o.transportadora}
            </span>
          )}
        </div>

        {/* Guía + PROMINENT tracking button */}
        {o.guia && (
          <div className="mt-2.5 flex items-center gap-2">
            <div className="flex flex-1 min-w-0 items-center gap-1.5 rounded-lg bg-secondary/40 px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground">
              <Tag size={9} className="text-primary/60" />
              <span className="truncate">{o.guia}</span>
              <button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.guia); toast.success('Guía copiada'); }}
                className="flex-shrink-0 transition-colors hover:text-foreground"><Copy size={9} /></button>
            </div>
            {trackUrl && (
              <a
                href={trackUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.guia); toast.success('Guía copiada al portapapeles'); }}
                className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-xl border border-orange/30 bg-orange px-3.5 py-2 text-[11px] font-black text-primary-foreground shadow-lg shadow-orange/30 transition-all hover:scale-[1.03] hover:shadow-xl hover:shadow-orange/40 no-underline"
              >
                <ExternalLink size={12} /> Rastrear
              </a>
            )}
          </div>
        )}

        {/* Delay warning */}
        {isDelayed && (
          <div className={`mt-2.5 flex items-center gap-2 rounded-lg px-3 py-2 ${
            diasEnEstatus >= 5 ? 'bg-red-500/10 border border-red-500/20' :
            diasEnEstatus >= 3 ? 'bg-amber-500/10 border border-amber-500/20' :
            'bg-orange-400/10 border border-orange-400/20'
          }`}>
            <Clock size={12} className={diasEnEstatus >= 5 ? 'text-red-400' : diasEnEstatus >= 3 ? 'text-amber-400' : 'text-orange-400'} />
            <span className={`text-[11px] font-bold ${diasEnEstatus >= 5 ? 'text-red-400' : diasEnEstatus >= 3 ? 'text-amber-400' : 'text-orange-400'}`}>
              {diasEnEstatus}d sin movimiento — {diasEnEstatus >= 5 ? 'Posible pérdida' : diasEnEstatus >= 3 ? 'Llamar + reclamar' : 'Monitorear'}
            </span>
          </div>
        )}

        {/* Novedad */}
        {o.novedad && (
          <div className="mt-2 flex items-start gap-1.5 bg-orange-500/5 border border-orange-500/10 rounded-lg px-2.5 py-2">
            <AlertTriangle size={11} className="text-orange-400 mt-0.5 flex-shrink-0" />
            <span className="text-[10px] text-orange-300 leading-tight">{truncate(o.novedad, 80)}</span>
          </div>
        )}

        {/* Alert badge */}
        {alert && alert.level !== 'ok' && alert.level !== 'watch' && (
          <div className="mt-2">
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-bold ${
              alert.level === 'lost' ? 'bg-muted/40 text-muted-foreground border border-muted-foreground/20' :
              alert.level === 'critical' ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
              'bg-orange-500/10 text-orange-400 border border-orange-500/20'
            }`}>
              {alert.label}
            </span>
          </div>
        )}

        {/* Managed badge */}
        {managed && (
          <div className="mt-2">
            <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
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
            className="border-t border-border/50 overflow-hidden">
            <div className="px-3.5 py-3.5 space-y-3 bg-secondary/20">
              {/* Info grid */}
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'PRODUCTO', value: truncate(o.producto || '—', 30) },
                  { label: 'VALOR', value: `$${o.valor.toLocaleString()}` },
                  { label: 'DIRECCIÓN', value: truncate(o.direccion || '—', 35) },
                  { label: 'DEPTO', value: o.departamento || '—' },
                ].map(d => (
                  <div key={d.label} className="bg-card/80 rounded-xl p-2.5 border border-border/30">
                    <div className="text-[9px] text-muted-foreground/60 uppercase tracking-widest font-semibold">{d.label}</div>
                    <div className="text-[12px] font-bold text-foreground mt-1">{d.value}</div>
                  </div>
                ))}
              </div>

              {/* History */}
              {tps.length > 0 && (
                <div>
                  <h4 className="text-[10px] font-bold text-foreground/80 mb-2 inline-flex items-center gap-1 uppercase tracking-wider">
                    <MessageSquare size={10} /> Historial ({tps.length})
                  </h4>
                  <div className="space-y-1.5 max-h-28 overflow-y-auto">
                    {tps.slice(0, 5).map(tp => (
                      <div key={tp.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-card/60 border border-border/20 text-[10px]">
                        <div className="w-5 h-5 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0">
                          <User size={9} className="text-primary" />
                        </div>
                        <span className="font-bold text-foreground">{getOperatorName(tp.operator_id)}</span>
                        <span className="text-foreground/60 truncate">{tp.action.replace(/^(SEG|RESCUE): ?/, '')}</span>
                        <span className="ml-auto text-muted-foreground flex-shrink-0 flex items-center gap-0.5">
                          <Clock size={8} /> {tp.action_time || ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Quick actions — bigger */}
              <div className="flex gap-2">
                <a href={`https://wa.me/57${o.phone}?text=${waMsg}`} target="_blank" rel="noopener noreferrer"
                  onClick={() => onAction('WhatsApp enviado')}
                  className="flex-1 text-[12px] py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-bold hover:from-emerald-500 hover:to-emerald-400 no-underline inline-flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/25 transition-all">
                  <Send size={13} /> WhatsApp
                </a>
                <a href={`tel:+57${o.phone}`}
                  className="flex-1 text-[12px] py-2.5 rounded-xl bg-secondary text-foreground font-bold hover:bg-secondary/80 no-underline inline-flex items-center justify-center gap-2 border border-border/50 transition-all">
                  <PhoneIcon size={13} /> Llamar
                </a>
              </div>

              {/* CRM actions */}
              {!managed && (
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {actions.map(a => (
                    <button key={a} onClick={() => onAction(a)}
                      className="text-[10px] px-3 py-2 rounded-lg bg-primary/10 text-primary font-bold hover:bg-primary/20 border border-primary/15 whitespace-nowrap transition-all hover:scale-[1.02]">
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
