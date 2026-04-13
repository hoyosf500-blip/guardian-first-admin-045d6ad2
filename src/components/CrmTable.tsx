import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { OrderData, truncate, getTrackingUrl, formatPhone } from '@/lib/orderUtils';
import { getAlertLevel, getFreshness, needsAction, getSuggestedAction, AlertInfo, FreshnessInfo } from '@/lib/alertSystem';
import { toast } from 'sonner';
import {
  Tag, AlertTriangle, ExternalLink, ChevronDown, ChevronRight,
  MessageSquare, Phone as PhoneIcon, Clock, User, Copy, ArrowUpDown, ArrowUp, ArrowDown,
  Package, Truck, MapPin, Bell, AlertCircle, RotateCcw, Layers, Target, List,
  Zap, Send, Download
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

type SortKey = 'nombre' | 'ciudad' | 'dias' | 'gestion' | 'transportadora';
type SortDir = 'asc' | 'desc';

interface StatusGroup {
  key: string;
  label: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
  match: (estado: string) => boolean;
}

const STATUS_GROUPS: StatusGroup[] = [
  { key: 'bodega', label: 'En Bodega', icon: <Package size={14} />, color: 'text-blue-400', bgColor: 'bg-blue-500/10', match: (e) => ['PENDIENTE', 'ALISTAMIENTO', 'GUIA GENERADA', 'EN PROCESAMIENTO', 'EN BODEGA DROPI', 'RECOGIDO POR DROPI'].includes(e) || e.includes('BODEGA') },
  { key: 'guia', label: 'Guia Generada', icon: <Tag size={14} />, color: 'text-cyan-400', bgColor: 'bg-cyan-500/10', match: (e) => e === 'GUIA_GENERADA' || e.includes('PREPARADO') || e === 'ENTREGADO A TRANSPORTADORA' },
  { key: 'transito', label: 'En Transito', icon: <Truck size={14} />, color: 'text-indigo-400', bgColor: 'bg-indigo-500/10', match: (e) => e.includes('REPARTO') || e.includes('DISTRIBUCION') || e.includes('TERMINAL') || e.includes('REEXPEDICION') || e.includes('DESPACHAD') || e.includes('REENVÍO') || e.includes('REENVIO') || e.includes('TRANSPORTE') || e === 'ADMITIDA' || e === 'EN DESPACHO' || e === 'TELEMERCADEO' },
  { key: 'novedad', label: 'Novedad', icon: <AlertTriangle size={14} />, color: 'text-orange-400', bgColor: 'bg-orange-500/10', match: (e) => e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA' },
  { key: 'oficina', label: 'Reclame en Oficina', icon: <MapPin size={14} />, color: 'text-purple-400', bgColor: 'bg-purple-500/10', match: (e) => e.includes('OFICINA') || e.includes('RECLAME') },
  { key: 'devolucion', label: 'Devolucion', icon: <RotateCcw size={14} />, color: 'text-red-400', bgColor: 'bg-red-500/10', match: (e) => e.includes('DEVOL') },
  { key: 'otros', label: 'Otros', icon: <Layers size={14} />, color: 'text-muted-foreground', bgColor: 'bg-secondary', match: () => true },
];

function classifyOrder(estado: string): string {
  const e = estado.toUpperCase();
  for (const g of STATUS_GROUPS) {
    if (g.key !== 'otros' && g.match(e)) return g.key;
  }
  return 'otros';
}

export default function CrmTable({ data, actions, module, emptyIcon, emptyTitle, emptyDesc }: CrmTableProps) {
  const { user } = useAuth();
  const [touchpoints, setTouchpoints] = useState<Touchpoint[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [results, setResults] = useState<Record<string, string>>({});
  const [expandedPhone, setExpandedPhone] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [gestionFilter, setGestionFilter] = useState<'all' | 'pendiente' | 'gestionado'>('all');
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('dias');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [workMode, setWorkMode] = useState(false);
  const [workIdx, setWorkIdx] = useState(0);

  // Load touchpoints & profiles
  useEffect(() => {
    if (!data.length) return;
    const phones = [...new Set(data.map(o => o.phone))];
    const prefix = module === 'SEG' ? 'SEG' : 'RESCUE';

    supabase.from('touchpoints')
      .select('*')
      .in('phone', phones.slice(0, 100))
      .order('created_at', { ascending: false })
      .then(({ data: tp }) => {
        if (tp) {
          const moduleTp = tp.filter(t => t.action.startsWith(`${prefix}:`) || t.action.startsWith(`${module}:`));
          setTouchpoints(moduleTp);
          const managed: Record<string, string> = {};
          const today = new Date().toISOString().split('T')[0];
          moduleTp.forEach(t => {
            if (t.action_date === today && !managed[t.phone]) {
              managed[t.phone] = t.action.replace(/^(SEG|RESCUE|SEG|RESCUE): ?/, '');
            }
          });
          setResults(managed);
        }
      });

    supabase.from('profiles').select('user_id, display_name').then(({ data: p }) => {
      if (p) setProfiles(p);
    });
  }, [data, module]);

  const getOperatorName = (opId: string) => {
    const p = profiles.find(pr => pr.user_id === opId);
    return p?.display_name || 'Operador';
  };

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

  // Filtered data
  const baseFiltered = useMemo(() => {
    return data.filter(o => {
      if (gestionFilter === 'pendiente' && results[o.phone]) return false;
      if (gestionFilter === 'gestionado' && !results[o.phone]) return false;
      if (stageFilter) {
        const stage = classifyOrder(o.estado);
        if (stage !== stageFilter) return false;
      }
      if (search) {
        const s = search.toLowerCase();
        return o.nombre.toLowerCase().includes(s) || o.phone.includes(s) ||
          (o.guia || '').toLowerCase().includes(s) || (o.ciudad || '').toLowerCase().includes(s);
      }
      return true;
    });
  }, [data, gestionFilter, stageFilter, search, results]);

  // Group by status
  const grouped = useMemo(() => {
    const groups: Record<string, OrderData[]> = {};
    STATUS_GROUPS.forEach(g => { groups[g.key] = []; });
    baseFiltered.forEach(o => {
      const key = classifyOrder(o.estado);
      groups[key].push(o);
    });
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => {
        let cmp = 0;
        switch (sortKey) {
          case 'nombre': cmp = a.nombre.localeCompare(b.nombre); break;
          case 'ciudad': cmp = (a.ciudad || '').localeCompare(b.ciudad || ''); break;
          case 'dias': cmp = (a.diasConf || a.dias) - (b.diasConf || b.dias); break;
          case 'transportadora': cmp = (a.transportadora || '').localeCompare(b.transportadora || ''); break;
          case 'gestion': cmp = (results[a.phone] ? 1 : 0) - (results[b.phone] ? 1 : 0); break;
        }
        return sortDir === 'desc' ? -cmp : cmp;
      });
    }
    return groups;
  }, [baseFiltered, sortKey, sortDir, results]);

  // Alert-level analysis
  const alertAnalysis = useMemo(() => {
    const byLevel: Record<string, OrderData[]> = { watch: [], alert: [], critical: [], lost: [] };
    const officeOrders: OrderData[] = [];
    const novedadOrders: OrderData[] = [];

    baseFiltered.forEach(o => {
      const alert = getAlertLevel(o.diasConf, o.dias, o.estado, o.transportadora);
      if (alert && byLevel[alert.level]) byLevel[alert.level].push(o);
      const e = o.estado.toUpperCase();
      if (e.includes('OFICINA') || e.includes('RECLAME')) officeOrders.push(o);
      if (e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA') novedadOrders.push(o);
    });

    const totalAlerts = byLevel.alert.length + byLevel.critical.length + byLevel.lost.length;
    return { byLevel, officeOrders, novedadOrders, totalAlerts };
  }, [baseFiltered]);

  // Urgent orders needing action
  const urgentOrders = useMemo(() => {
    return baseFiltered.filter(o => {
      const isResolved = !!results[o.phone];
      return needsAction(o.estado, o.diasConf, o.dias, isResolved, getLastTouchTime(o.phone));
    });
  }, [baseFiltered, results, getLastTouchTime]);

  // Alert-level analysis only for RESCUE module

  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'dias' ? 'desc' : 'asc'); }
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown size={11} className="opacity-30" />;
    return sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />;
  };

  const pendCount = data.filter(o => !results[o.phone]).length;
  const gestCount = data.filter(o => !!results[o.phone]).length;

  // CSV export
  const downloadCSV = () => {
    const rows = baseFiltered.map(o => ({
      Nombre: o.nombre, Telefono: o.phone, Ciudad: o.ciudad, Estado: o.estado,
      Dias: o.diasConf || o.dias, Guia: o.guia, Transportadora: o.transportadora,
      Novedad: o.novedad, Gestion: results[o.phone] || 'Pendiente',
    }));
    const headers = Object.keys(rows[0] || {});
    const csv = [headers.join(','), ...rows.map(r => headers.map(h => `"${(r as Record<string, unknown>)[h] || ''}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `crm_${module}_${new Date().toISOString().split('T')[0]}.csv`; a.click();
    URL.revokeObjectURL(url);
    toast.success('CSV descargado');
  };

  // ── WORK MODE ──
  const workQueue = useMemo(() => {
    return urgentOrders.length > 0 ? urgentOrders : baseFiltered.filter(o => {
      const diasT = o.diasConf || o.dias;
      return diasT >= 2 && !results[o.phone];
    }).sort((a, b) => (b.diasConf || b.dias) - (a.diasConf || a.dias));
  }, [urgentOrders, baseFiltered, results]);

  const currentWorkOrder = workMode && workQueue.length > 0 ? workQueue[Math.min(workIdx, workQueue.length - 1)] : null;

  const handleWorkAction = async (action: string) => {
    if (!currentWorkOrder) return;
    await markAction(currentWorkOrder.phone, action);
    setWorkIdx(prev => Math.min(prev + 1, workQueue.length - 1));
  };

  if (!data.length) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-16 h-16 rounded-2xl bg-secondary flex items-center justify-center mb-4">{emptyIcon}</div>
        <h3 className="text-base font-semibold text-foreground mb-1">{emptyTitle}</h3>
        <p className="text-sm text-muted-foreground max-w-xs">{emptyDesc}</p>
      </div>
    );
  }

  // ── WORK MODE VIEW ──
  if (workMode && currentWorkOrder) {
    const o = currentWorkOrder;
    const diasT = o.diasConf || o.dias;
    const alert = getAlertLevel(o.diasConf, o.dias, o.estado, o.transportadora);
    const fresh = getFreshness(getLastTouchTime(o.phone), diasT);
    const suggested = getSuggestedAction(o.estado, o.novedad, o.transportadora, diasT);
    const tps = phoneTouchpoints[o.phone] || [];
    const waMsg = encodeURIComponent(`Hola ${o.nombre}, le escribo sobre su pedido${o.guia ? ` (guia ${o.guia})` : ''}. ¿Cómo va la entrega?`);

    return (
      <div className="space-y-4">
        {/* Work mode header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Target size={16} className="text-primary" />
            <span className="text-sm font-semibold">Modo trabajo</span>
            <span className="text-xs text-muted-foreground">{workIdx + 1} / {workQueue.length} pendientes</span>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setWorkIdx(prev => Math.min(prev + 1, workQueue.length - 1))}
              className="px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground">
              Saltar
            </button>
            <button onClick={() => { setWorkMode(false); setWorkIdx(0); }}
              className="px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-foreground hover:bg-secondary/80">
              <List size={12} className="inline mr-1" /> Lista
            </button>
          </div>
        </div>

        {/* Order card */}
        <motion.div key={o.phone} initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }}
          className="bg-card rounded-2xl border border-border p-5" style={{ borderLeftWidth: 4, borderLeftColor: alert?.color || 'var(--border)' }}>
          <div className="text-xl font-bold text-foreground mb-1">{o.nombre}</div>
          <div className="text-xs text-muted-foreground mb-3 flex flex-wrap gap-x-3 gap-y-1">
            <span>#{o.externalId}</span>
            <span className="inline-flex items-center gap-1"><MapPin size={10} /> {o.ciudad}</span>
            <span>{o.transportadora || '?'}</span>
            {o.guia && <span className="font-mono">Guia: {o.guia}</span>}
            <span className="font-bold">D{diasT}</span>
          </div>

          <div className="flex flex-wrap gap-2 mb-3">
            <span className="text-xs px-2 py-1 rounded-lg bg-secondary font-medium">Estado: <strong>{o.estado}</strong></span>
            {alert && (
              <span className={`text-xs px-2 py-1 rounded-lg font-bold ${alert.level === 'critical' || alert.level === 'lost' ? 'bg-red-500/10 text-red-400' : alert.level === 'alert' ? 'bg-orange-500/10 text-orange-400' : 'bg-yellow-500/10 text-yellow-400'}`}>
                {alert.icon} {alert.label}
              </span>
            )}
            {alert?.officeCD && (
              <span className="text-xs px-2 py-1 rounded-lg bg-purple-500/10 text-purple-400 font-bold">
                Countdown: {alert.officeCD.remaining}d restantes (max {alert.officeCD.deadline}d)
              </span>
            )}
            {alert?.novedadW && (
              <span className={`text-xs px-2 py-1 rounded-lg font-bold ${alert.novedadW.remaining <= 0 ? 'bg-red-500/10 text-red-400' : 'bg-orange-500/10 text-orange-400'}`}>
                {alert.novedadW.remaining <= 0 ? 'Ventana cerrada' : `${alert.novedadW.remaining}d para rescatar`}
              </span>
            )}
            <span className={`text-xs px-2 py-1 rounded-lg font-medium ${fresh.tailwindColor}`} style={{ background: `color-mix(in srgb, ${fresh.color} 15%, transparent)` }}>
              {fresh.label}
            </span>
          </div>

          {o.novedad && (
            <div className="text-sm text-orange-400 mb-3 flex items-center gap-1">
              <AlertTriangle size={12} /> Novedad: {o.novedad}
            </div>
          )}

          {tps.length > 0 && (
            <div className="text-xs text-muted-foreground mb-3">
              Historial: {tps.slice(0, 3).map(t => `${t.action.replace(/^(SEG|RESCUE): ?/, '')} ${t.action_time || ''}`).join(' → ')}
            </div>
          )}
        </motion.div>

        {/* Suggested action */}
        <div className="bg-primary/5 border border-primary/20 rounded-xl p-4">
          <div className="text-[10px] text-primary font-bold mb-1 flex items-center gap-1"><Zap size={10} /> ACCION SUGERIDA</div>
          <div className="text-sm font-semibold text-foreground">{suggested}</div>
        </div>

        {/* Action buttons */}
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => handleWorkAction('Llame cliente')}
            className="py-3 rounded-xl bg-primary/10 text-primary font-semibold text-sm hover:bg-primary/20 flex items-center justify-center gap-2">
            <PhoneIcon size={14} /> Llame al cliente
          </button>
          <a href={`https://wa.me/57${o.phone}?text=${waMsg}`} target="_blank" rel="noopener noreferrer"
            onClick={() => handleWorkAction('WhatsApp enviado')}
            className="py-3 rounded-xl bg-emerald-500/10 text-emerald-400 font-semibold text-sm hover:bg-emerald-500/20 flex items-center justify-center gap-2 no-underline">
            <Send size={14} /> WhatsApp
          </a>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => handleWorkAction('Reclame transportadora')}
            className="py-2.5 rounded-xl bg-secondary text-foreground text-xs font-medium hover:bg-secondary/80">
            Reclame transportadora
          </button>
          <button onClick={() => handleWorkAction('Esperando respuesta')}
            className="py-2.5 rounded-xl bg-secondary text-foreground text-xs font-medium hover:bg-secondary/80">
            Esperando respuesta
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 border-t border-border pt-2">
          <button onClick={() => handleWorkAction('Resuelto')}
            className="py-2.5 rounded-xl bg-green-500/10 text-green-400 text-xs font-bold hover:bg-green-500/20">
            Resuelto
          </button>
          <button onClick={() => handleWorkAction('Devolucion solicitada')}
            className="py-2.5 rounded-xl bg-red-500/10 text-red-400 text-xs font-bold hover:bg-red-500/20">
            Devolucion
          </button>
        </div>

        {workQueue.length === 0 && (
          <div className="text-center py-8">
            <div className="text-3xl mb-2">🎉</div>
            <p className="text-sm text-muted-foreground font-medium">Todo al dia, no hay pedidos urgentes.</p>
          </div>
        )}
      </div>
    );
  }

  // ── LIST MODE ──
  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3">
        <input type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Buscar nombre, telefono, guia, ciudad..."
          className="flex-1 pl-3 pr-3 py-2 bg-secondary border-none rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="flex gap-2">
          <button onClick={() => { setWorkMode(true); setWorkIdx(0); }}
            className="px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-semibold hover:bg-primary/20 flex items-center gap-1.5">
            <Target size={12} /> Modo trabajo {urgentOrders.length > 0 && <span className="px-1.5 rounded-full bg-red-500/20 text-red-400 text-[10px] font-bold">{urgentOrders.length}</span>}
          </button>
          <button onClick={downloadCSV} className="px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground flex items-center gap-1">
            <Download size={12} /> CSV
          </button>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1.5 flex-wrap">
        <div className="inline-flex bg-secondary rounded-lg p-0.5 mr-2">
          {([
            { id: 'all' as const, label: 'Todos', count: data.length },
            { id: 'pendiente' as const, label: 'Pendientes', count: pendCount },
            { id: 'gestionado' as const, label: 'Gestionados', count: gestCount },
          ]).map(f => (
            <button key={f.id} onClick={() => setGestionFilter(f.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                gestionFilter === f.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}>
              {f.label} <span className="ml-1 opacity-60">{f.count}</span>
            </button>
          ))}
        </div>
        {/* Stage filters */}
        <button onClick={() => setStageFilter(null)}
          className={`px-2.5 py-1 rounded-lg text-[10px] font-medium transition-all ${!stageFilter ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground'}`}>
          Todos
        </button>
        {urgentOrders.length > 0 && (
          <button onClick={() => setStageFilter('_urgent')}
            className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all ${stageFilter === '_urgent' ? 'bg-red-500/15 text-red-400' : 'bg-red-500/5 text-red-400/70'}`}>
            Urgente {urgentOrders.length}
          </button>
        )}
        {STATUS_GROUPS.filter(g => grouped[g.key].length > 0).map(g => (
          <button key={g.key} onClick={() => setStageFilter(stageFilter === g.key ? null : g.key)}
            className={`px-2.5 py-1 rounded-lg text-[10px] font-medium transition-all ${stageFilter === g.key ? `${g.bgColor} ${g.color}` : 'bg-secondary text-muted-foreground'}`}>
            {g.label} {grouped[g.key].length}
          </button>
        ))}
      </div>

      {/* 5-Level Alerts */}
      {alertAnalysis.totalAlerts > 0 && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
          className="bg-gradient-to-br from-red-500/5 to-orange-500/5 border border-red-500/20 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-sm font-bold text-foreground flex items-center gap-1.5"><Bell size={14} className="text-red-400" /> Centro de Alertas</div>
              <div className="text-[10px] text-muted-foreground">Basado en dias sin movimiento</div>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap mb-3">
            {alertAnalysis.byLevel.lost.length > 0 && (
              <span className="text-[10px] px-2.5 py-1 rounded-lg bg-muted/30 text-muted-foreground font-bold cursor-pointer hover:bg-muted/50" onClick={() => setStageFilter('devolucion')}>
                ⚫ Devolucion segura {alertAnalysis.byLevel.lost.length}
              </span>
            )}
            {alertAnalysis.byLevel.critical.length > 0 && (
              <span className="text-[10px] px-2.5 py-1 rounded-lg bg-red-500/10 text-red-400 font-bold cursor-pointer hover:bg-red-500/20">
                🔴 Critico {alertAnalysis.byLevel.critical.length}
              </span>
            )}
            {alertAnalysis.byLevel.alert.length > 0 && (
              <span className="text-[10px] px-2.5 py-1 rounded-lg bg-orange-500/10 text-orange-400 font-bold cursor-pointer hover:bg-orange-500/20">
                🟠 Alerta {alertAnalysis.byLevel.alert.length}
              </span>
            )}
            {alertAnalysis.byLevel.watch.length > 0 && (
              <span className="text-[10px] px-2.5 py-1 rounded-lg bg-yellow-500/10 text-yellow-400 font-bold cursor-pointer hover:bg-yellow-500/20">
                🟡 Monitorear {alertAnalysis.byLevel.watch.length}
              </span>
            )}
          </div>

          {/* Office countdown */}
          {alertAnalysis.officeOrders.length > 0 && (
            <div className="bg-purple-500/5 border border-purple-500/15 rounded-lg p-3 mb-2">
              <div className="text-[10px] font-bold text-purple-400 mb-1.5">Countdown Oficina — {alertAnalysis.officeOrders.length} pedidos</div>
              {alertAnalysis.officeOrders.slice(0, 5).map(o => {
                const al = getAlertLevel(o.diasConf, o.dias, o.estado, o.transportadora);
                const cd = al?.officeCD;
                return (
                  <div key={o.phone + o.idx} onClick={() => setExpandedPhone(o.phone)}
                    className="flex justify-between items-center py-1 px-2 rounded bg-card/50 mb-1 text-[10px] cursor-pointer hover:bg-card">
                    <span className="text-foreground">{o.nombre} · {o.ciudad}</span>
                    <span className={`font-bold ${cd && cd.remaining <= 1 ? 'text-red-400' : cd && cd.remaining <= 3 ? 'text-orange-400' : 'text-yellow-400'}`}>
                      {cd ? `${cd.remaining}d restantes (${cd.carrier} max ${cd.deadline}d)` : '?'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Novedad rescue window - only in RESCUE */}
          {module === 'RESCUE' && alertAnalysis.novedadOrders.length > 0 && (
            <div className="bg-orange-500/5 border border-orange-500/15 rounded-lg p-3">
              <div className="text-[10px] font-bold text-orange-400 mb-1.5">Ventana de rescate — {alertAnalysis.novedadOrders.length} novedades</div>
              {alertAnalysis.novedadOrders.slice(0, 5).map(o => {
                const al = getAlertLevel(o.diasConf, o.dias, o.estado, o.transportadora);
                const w = al?.novedadW;
                return (
                  <div key={o.phone + o.idx} onClick={() => setExpandedPhone(o.phone)}
                    className="flex justify-between items-center py-1 px-2 rounded bg-card/50 mb-1 text-[10px] cursor-pointer hover:bg-card">
                    <span className="text-foreground">{o.nombre} · {o.novedad ? truncate(o.novedad, 30) : 'sin detalle'}</span>
                    <span className={`font-bold ${w && w.remaining <= 0 ? 'text-red-400' : 'text-orange-400'}`}>
                      {w ? (w.remaining <= 0 ? 'Ventana cerrada' : `${w.remaining}d para rescatar`) : '?'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </motion.div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {STATUS_GROUPS.filter(g => ['bodega', 'transito', 'novedad', 'devolucion'].includes(g.key) && grouped[g.key].length > 0).map(g => (
          <div key={g.key} className="bg-card rounded-xl border border-border p-3 text-center cursor-pointer hover:bg-secondary/20" onClick={() => setStageFilter(g.key)}>
            <div className={`text-2xl font-bold font-mono ${g.color}`}>{grouped[g.key].length}</div>
            <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide">{g.label}</div>
          </div>
        ))}
      </div>

      {/* Carrier stats & toxic cities (collapsible) */}
      {carrierStats.length > 0 && (
        <details className="bg-card rounded-xl border border-border">
          <summary className="px-4 py-3 text-xs font-semibold text-muted-foreground cursor-pointer hover:text-foreground flex items-center gap-1.5">
            <Truck size={12} /> Rendimiento por transportadora
          </summary>
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full text-xs">
              <thead><tr className="text-[10px] text-muted-foreground bg-secondary/30">
                <th className="text-left px-3 py-2">Carrier</th><th className="text-right px-3 py-2">Total</th>
                <th className="text-right px-3 py-2">Entregados</th><th className="text-right px-3 py-2">Devol</th>
                <th className="text-right px-3 py-2">%Devol</th><th className="text-right px-3 py-2">%Efect</th>
              </tr></thead>
              <tbody>{carrierStats.map(c => (
                <tr key={c.carrier} className="border-b border-border/30">
                  <td className="px-3 py-2 font-semibold">{c.carrier}</td>
                  <td className="px-3 py-2 text-right">{c.total}</td>
                  <td className="px-3 py-2 text-right text-green-400">{c.entregado}</td>
                  <td className="px-3 py-2 text-right text-red-400">{c.devol}</td>
                  <td className={`px-3 py-2 text-right font-bold ${c.devolRate > 20 ? 'text-red-400' : c.devolRate > 15 ? 'text-orange-400' : 'text-green-400'}`}>{c.devolRate}%</td>
                  <td className={`px-3 py-2 text-right font-bold ${c.efectividad >= 55 ? 'text-green-400' : c.efectividad >= 40 ? 'text-orange-400' : 'text-red-400'}`}>{c.efectividad}%</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      )}

      {toxicCities.length > 0 && (
        <details className="bg-card rounded-xl border border-border">
          <summary className="px-4 py-3 text-xs font-semibold text-muted-foreground cursor-pointer hover:text-foreground flex items-center gap-1.5">
            <AlertCircle size={12} /> Ciudades toxicas ({toxicCities.length} con &gt;25% problema)
          </summary>
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full text-xs">
              <thead><tr className="text-[10px] text-muted-foreground bg-secondary/30">
                <th className="text-left px-3 py-2">Ciudad</th><th className="text-right px-3 py-2">Total</th>
                <th className="text-right px-3 py-2">Devol</th><th className="text-right px-3 py-2">Oficina</th>
                <th className="text-right px-3 py-2">% Riesgo</th>
              </tr></thead>
              <tbody>{toxicCities.map(c => (
                <tr key={c.city} className="border-b border-border/30 cursor-pointer hover:bg-secondary/20" onClick={() => setSearch(c.city)}>
                  <td className="px-3 py-2 font-semibold">{c.city}</td>
                  <td className="px-3 py-2 text-right">{c.total}</td>
                  <td className="px-3 py-2 text-right text-red-400">{c.devol}</td>
                  <td className="px-3 py-2 text-right text-purple-400">{c.oficina}</td>
                  <td className={`px-3 py-2 text-right font-bold ${c.risk >= 50 ? 'text-red-400' : c.risk >= 30 ? 'text-orange-400' : 'text-yellow-400'}`}>{c.risk}%</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      )}

      {/* Grouped tables */}
      {STATUS_GROUPS.filter(g => grouped[g.key].length > 0).map(group => {
        const items = grouped[group.key];
        const isCollapsed = collapsedGroups.has(group.key);

        return (
          <div key={group.key} className="bg-card rounded-xl border border-border overflow-hidden">
            <button onClick={() => toggleGroup(group.key)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-secondary/30 transition-colors">
              <div className="flex items-center gap-2">
                {isCollapsed ? <ChevronRight size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
                <span className={group.color}>{group.icon}</span>
                <span className="text-sm font-semibold text-foreground">{group.label}</span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${group.bgColor} ${group.color}`}>{items.length}</span>
              </div>
              <div className="flex items-center gap-2">
                {items.filter(o => (o.diasConf || o.dias) >= 2 && !results[o.phone]).length > 0 && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-500/10 text-red-400">
                    <AlertCircle size={9} /> {items.filter(o => (o.diasConf || o.dias) >= 2 && !results[o.phone]).length} alertas
                  </span>
                )}
              </div>
            </button>

            {!isCollapsed && (
              <div className="overflow-x-auto border-t border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] text-muted-foreground bg-secondary/30">
                      <th className="text-left px-3 py-2 font-medium cursor-pointer select-none" onClick={() => toggleSort('nombre')}>
                        <span className="inline-flex items-center gap-1">Cliente <SortIcon col="nombre" /></span>
                      </th>
                      <th className="text-left px-3 py-2 font-medium hidden md:table-cell">Guia</th>
                      <th className="text-left px-3 py-2 font-medium hidden md:table-cell cursor-pointer select-none" onClick={() => toggleSort('ciudad')}>
                        <span className="inline-flex items-center gap-1">Ciudad <SortIcon col="ciudad" /></span>
                      </th>
                      <th className="text-left px-3 py-2 font-medium">Alerta</th>
                      <th className="text-center px-3 py-2 font-medium cursor-pointer select-none" onClick={() => toggleSort('dias')}>
                        <span className="inline-flex items-center gap-1">Dias <SortIcon col="dias" /></span>
                      </th>
                      <th className="text-left px-3 py-2 font-medium hidden lg:table-cell">Frescura</th>
                      <th className="text-center px-3 py-2 font-medium cursor-pointer select-none" onClick={() => toggleSort('gestion')}>
                        <span className="inline-flex items-center gap-1">Gestion <SortIcon col="gestion" /></span>
                      </th>
                      <th className="text-right px-3 py-2 font-medium">Accion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.slice(0, 100).map(o => {
                      const diasT = o.diasConf || o.dias;
                      const managed = results[o.phone];
                      const alert = getAlertLevel(o.diasConf, o.dias, o.estado, o.transportadora);
                      const fresh = getFreshness(getLastTouchTime(o.phone), diasT);
                      const trackUrl = getTrackingUrl(o.transportadora, o.guia);
                      const isExpanded = expandedPhone === o.phone;
                      const riskClass = diasT >= 7 ? 'bg-red-500/10 text-red-400' : diasT >= 4 ? 'bg-yellow-500/10 text-yellow-400' : diasT >= 2 ? 'bg-orange-500/10 text-orange-400' : 'bg-green-500/10 text-green-400';

                      return (
                        <>
                          <tr key={o.phone + o.idx}
                            className={`border-b border-border/50 last:border-0 hover:bg-secondary/20 transition-colors cursor-pointer ${alert && (alert.level === 'critical' || alert.level === 'lost') ? 'border-l-2 border-l-red-400/40' : alert?.level === 'alert' ? 'border-l-2 border-l-orange-400/40' : ''} ${managed ? 'opacity-60' : ''}`}
                            onClick={() => setExpandedPhone(isExpanded ? null : o.phone)}>
                            <td className="px-3 py-2.5">
                              <div className="flex items-center gap-1.5">
                                {isExpanded ? <ChevronDown size={12} className="text-muted-foreground flex-shrink-0" /> : <ChevronRight size={12} className="text-muted-foreground flex-shrink-0" />}
                                <div>
                                  <div className="font-medium text-foreground text-xs">{o.nombre}</div>
                                  <div className="text-[10px] text-muted-foreground inline-flex items-center gap-1 mt-0.5">
                                    <PhoneIcon size={8} /> {o.phone}
                                    <button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.phone); toast.success('Tel copiado'); }}
                                      className="hover:text-foreground"><Copy size={8} /></button>
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-xs text-muted-foreground hidden md:table-cell">
                              {o.guia ? (
                                <div className="inline-flex items-center gap-1">
                                  <span className="font-mono text-[11px]">{o.guia.slice(-8)}</span>
                                  <button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.guia); toast.success('Guia copiada'); }}
                                    className="hover:text-foreground"><Copy size={9} /></button>
                                  {trackUrl && (
                                    <a href={trackUrl} target="_blank" rel="noopener noreferrer"
                                      onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.guia); toast.success('Guia copiada'); }}
                                      className="text-blue-400 hover:text-blue-300"><ExternalLink size={10} /></a>
                                  )}
                                </div>
                              ) : '—'}
                            </td>
                            <td className="px-3 py-2.5 text-xs text-muted-foreground hidden md:table-cell">{o.ciudad || '—'}</td>
                            <td className="px-3 py-2.5">
                              {alert ? (
                                <span className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-bold ${
                                  alert.level === 'lost' ? 'bg-muted/30 text-muted-foreground' :
                                  alert.level === 'critical' ? 'bg-red-500/10 text-red-400' :
                                  alert.level === 'alert' ? 'bg-orange-500/10 text-orange-400' :
                                  alert.level === 'watch' ? 'bg-yellow-500/10 text-yellow-400' :
                                  'bg-green-500/10 text-green-400'
                                }`}>
                                  {alert.icon} {alert.sinEscaneo}d
                                </span>
                              ) : (
                                <span className="text-[10px] text-green-400">OK</span>
                              )}
                              {o.novedad && <div className="text-[10px] text-orange-400 mt-0.5 flex items-center gap-0.5"><AlertTriangle size={8} /> {truncate(o.novedad, 20)}</div>}
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              <span className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-xs font-bold ${riskClass}`}>
                                D{diasT}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 hidden lg:table-cell">
                              <span className={`text-[10px] font-medium ${fresh.tailwindColor}`}>{fresh.label}</span>
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              {managed ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-green-500/10 text-green-400">{managed}</span>
                              ) : (
                                <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-medium bg-yellow-500/10 text-yellow-400">Pendiente</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-right" onClick={e => e.stopPropagation()}>
                              {!managed && (
                                <details className="inline-block">
                                  <summary className="text-xs text-primary cursor-pointer font-medium">Gestionar</summary>
                                  <div className="flex gap-1 mt-1.5 flex-wrap justify-end">
                                    {actions.map(a => (
                                      <button key={a} onClick={() => markAction(o.phone, a)}
                                        className="text-[10px] px-2 py-1 rounded bg-secondary text-foreground font-medium hover:bg-secondary/80 whitespace-nowrap">
                                        {a}
                                      </button>
                                    ))}
                                  </div>
                                </details>
                              )}
                            </td>
                          </tr>
                          {/* Expanded row */}
                          {isExpanded && (
                            <tr key={`exp-${o.phone}`}>
                              <td colSpan={8} className="px-0 py-0">
                                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                                  className="bg-secondary/20 px-4 py-4 space-y-3">
                                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                                    {[
                                      { label: 'Producto', value: truncate(o.producto || '—', 30) },
                                      { label: 'Valor', value: `$${o.valor.toLocaleString()}` },
                                      { label: 'Direccion', value: truncate(o.direccion || '—', 35) },
                                      { label: 'Departamento', value: o.departamento || '—' },
                                      { label: 'Transportadora', value: o.transportadora || '—' },
                                      { label: 'Guia completa', value: o.guia || '—' },
                                      { label: 'Novedad', value: o.novedad || '—' },
                                      { label: 'Tienda', value: o.tienda || '—' },
                                    ].map(d => (
                                      <div key={d.label} className="bg-card rounded-lg p-2">
                                        <div className="text-[10px] text-muted-foreground mb-0.5">{d.label}</div>
                                        <div className="font-medium text-foreground text-[11px]">{d.value}</div>
                                      </div>
                                    ))}
                                  </div>
                                  {/* Touchpoint history */}
                                  <div>
                                    <h4 className="text-[11px] font-semibold text-foreground mb-1.5 inline-flex items-center gap-1">
                                      <MessageSquare size={11} /> Historial ({(phoneTouchpoints[o.phone] || []).length})
                                    </h4>
                                    {!(phoneTouchpoints[o.phone] || []).length ? (
                                      <p className="text-[10px] text-muted-foreground">Sin gestiones registradas</p>
                                    ) : (
                                      <div className="space-y-1 max-h-36 overflow-y-auto">
                                        {(phoneTouchpoints[o.phone] || []).map(tp => (
                                          <div key={tp.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-card text-[10px]">
                                            <div className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                                              <User size={9} className="text-primary" />
                                            </div>
                                            <span className="font-medium text-foreground">{getOperatorName(tp.operator_id)}</span>
                                            <span className="text-muted-foreground">—</span>
                                            <span className="text-foreground">{tp.action.replace(/^(SEG|RESCUE): ?/, '')}</span>
                                            <span className="ml-auto text-muted-foreground flex items-center gap-0.5 flex-shrink-0">
                                              <Clock size={8} /> {tp.action_date} {tp.action_time || ''}
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                  {/* Quick WA */}
                                  <div className="flex gap-2">
                                    <a href={`https://wa.me/57${o.phone}?text=${encodeURIComponent(`Hola ${o.nombre}, le escribo sobre su pedido${o.guia ? ` (guia ${o.guia})` : ''}.`)}`}
                                      target="_blank" rel="noopener noreferrer"
                                      onClick={() => markAction(o.phone, 'WhatsApp enviado')}
                                      className="text-[10px] px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 font-medium hover:bg-emerald-500/20 no-underline inline-flex items-center gap-1">
                                      <Send size={10} /> WhatsApp
                                    </a>
                                    <button onClick={() => { navigator.clipboard.writeText(o.phone); toast.success('Tel copiado'); }}
                                      className="text-[10px] px-3 py-1.5 rounded-lg bg-secondary text-foreground font-medium hover:bg-secondary/80 inline-flex items-center gap-1">
                                      <PhoneIcon size={10} /> Copiar tel
                                    </button>
                                  </div>
                                </motion.div>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
                {items.length > 100 && (
                  <div className="px-4 py-2 border-t border-border text-center text-[10px] text-muted-foreground">
                    Mostrando 100 de {items.length}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
