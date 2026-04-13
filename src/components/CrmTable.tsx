import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { OrderData, truncate, getTrackingUrl, formatPhone } from '@/lib/orderUtils';
import { getAlertLevel, getFreshness, needsAction, getSuggestedAction } from '@/lib/alertSystem';
import { toast } from 'sonner';
import {
  AlertTriangle, ExternalLink, ChevronDown, ChevronRight,
  MessageSquare, Phone as PhoneIcon, Clock, User, Copy,
  Package, Truck, MapPin, RotateCcw, Layers,
  Send, Tag, CheckCircle, AlertCircle, Archive
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
  headerColor: string;
  match: (estado: string) => boolean;
}

const STATUS_COLUMNS: StatusColumn[] = [
  { key: 'bodega', label: 'En Bodega', icon: <Package size={14} />, headerColor: 'bg-blue-500/80', match: (e) => ['PENDIENTE', 'ALISTAMIENTO', 'EN PROCESAMIENTO', 'EN BODEGA DROPI', 'RECOGIDO POR DROPI'].includes(e) || (e.includes('BODEGA') && !e.includes('DEVOL')) },
  { key: 'guia', label: 'Guía Generada', icon: <Tag size={14} />, headerColor: 'bg-cyan-500/80', match: (e) => e === 'GUIA GENERADA' || e === 'GUIA_GENERADA' || e.includes('PREPARADO') || e === 'ENTREGADO A TRANSPORTADORA' },
  { key: 'transito', label: 'En Tránsito', icon: <Truck size={14} />, headerColor: 'bg-indigo-500/80', match: (e) => e.includes('REPARTO') || e.includes('DISTRIBUCION') || e.includes('TERMINAL') || e.includes('REEXPEDICION') || e.includes('DESPACHAD') || e.includes('REENVÍO') || e.includes('REENVIO') || e.includes('TRANSPORTE') || e === 'ADMITIDA' || e === 'EN DESPACHO' || e === 'TELEMERCADEO' },
  { key: 'novedad', label: 'Novedad', icon: <AlertTriangle size={14} />, headerColor: 'bg-orange-500/80', match: (e) => e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA' },
  { key: 'oficina', label: 'En Oficina', icon: <MapPin size={14} />, headerColor: 'bg-purple-500/80', match: (e) => e.includes('OFICINA') || e.includes('RECLAME') },
  { key: 'devolucion', label: 'Devolución', icon: <RotateCcw size={14} />, headerColor: 'bg-red-500/80', match: (e) => e.includes('DEVOL') },
  { key: 'entregado', label: 'Entregado', icon: <CheckCircle size={14} />, headerColor: 'bg-green-500/80', match: (e) => e === 'ENTREGADO' },
  { key: 'otros', label: 'Otros', icon: <Layers size={14} />, headerColor: 'bg-muted-foreground/60', match: () => true },
];

function classifyOrder(estado: string): string {
  const e = estado.toUpperCase();
  for (const col of STATUS_COLUMNS) {
    if (col.key !== 'otros' && col.match(e)) return col.key;
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
              managed[t.phone] = t.action.replace(/^(SEG|RESCUE): ?/, '');
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

  // Filter by search
  const filtered = useMemo(() => {
    if (!search) return data;
    const s = search.toLowerCase();
    return data.filter(o =>
      o.nombre.toLowerCase().includes(s) || o.phone.includes(s) ||
      (o.guia || '').toLowerCase().includes(s) || (o.ciudad || '').toLowerCase().includes(s)
    );
  }, [data, search]);

  // Group into columns
  const columns = useMemo(() => {
    const groups: Record<string, OrderData[]> = {};
    STATUS_COLUMNS.forEach(c => { groups[c.key] = []; });
    filtered.forEach(o => {
      const key = classifyOrder(o.estado);
      groups[key].push(o);
    });
    // Sort each column by days desc (most urgent first)
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => (b.diasConf || b.dias) - (a.diasConf || a.dias));
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
    <div className="space-y-3">
      {/* Search bar */}
      <div className="flex gap-2">
        <input type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Buscar nombre, teléfono, guía, ciudad..."
          className="flex-1 pl-3 pr-3 py-2 bg-secondary border-none rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Kanban board */}
      <div className="overflow-x-auto pb-4">
        <div className="flex gap-3" style={{ minWidth: `${activeColumns.length * 280}px` }}>
          {activeColumns.map(col => {
            const items = columns[col.key];
            return (
              <div key={col.key} className="flex-1 min-w-[260px] max-w-[320px] flex flex-col">
                {/* Column header */}
                <div className={`${col.headerColor} rounded-t-xl px-3 py-2.5 flex items-center justify-between`}>
                  <div className="flex items-center gap-1.5 text-white">
                    {col.icon}
                    <span className="text-xs font-semibold">{col.label}</span>
                  </div>
                  <span className="text-white/90 text-xs font-bold bg-white/20 rounded-full px-2 py-0.5">{items.length}</span>
                </div>

                {/* Cards container */}
                <div className="bg-secondary/30 rounded-b-xl border border-border border-t-0 flex-1 p-2 space-y-2 max-h-[65vh] overflow-y-auto">
                  {items.map(o => (
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
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
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
}

function OrderCard({ order: o, managed, expanded, onToggle, onAction, actions, touchpoints: tps, getOperatorName, getLastTouchTime, module }: OrderCardProps) {
  const diasT = o.diasConf || o.dias;
  const alert = getAlertLevel(o.diasConf, o.dias, o.estado, o.transportadora);
  const trackUrl = getTrackingUrl(o.transportadora, o.guia);
  const waMsg = encodeURIComponent(`Hola ${o.nombre}, le escribo sobre su pedido${o.guia ? ` (guía ${o.guia})` : ''}. ¿Cómo va la entrega?`);

  const diasColor = diasT >= 7 ? 'text-red-400' : diasT >= 4 ? 'text-yellow-400' : diasT >= 2 ? 'text-orange-400' : 'text-green-400';
  const borderColor = alert && (alert.level === 'critical' || alert.level === 'lost') ? 'border-l-red-400' : alert?.level === 'alert' ? 'border-l-orange-400' : 'border-l-transparent';

  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className={`bg-card rounded-xl border border-border border-l-[3px] ${borderColor} overflow-hidden ${managed ? 'opacity-60' : ''}`}>

      {/* Card header - clickable */}
      <div className="px-3 py-2.5 cursor-pointer hover:bg-secondary/30 transition-colors" onClick={onToggle}>
        <div className="flex items-start justify-between gap-1">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-foreground truncate">{o.nombre}</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">{o.externalId}</div>
          </div>
          {diasT > 0 && (
            <span className={`text-[10px] font-bold ${diasColor} flex-shrink-0`}>D{diasT}</span>
          )}
        </div>

        {/* Phone */}
        <div className="flex items-center gap-1 mt-1.5 text-[10px] text-muted-foreground">
          <PhoneIcon size={9} />
          <span>{o.phone}</span>
          <button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.phone); toast.success('Tel copiado'); }}
            className="hover:text-foreground"><Copy size={8} /></button>
        </div>

        {/* City & carrier */}
        <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
          {o.ciudad && <span className="flex items-center gap-0.5"><MapPin size={8} />{o.ciudad}</span>}
          {o.transportadora && <span className="flex items-center gap-0.5"><Truck size={8} />{o.transportadora}</span>}
        </div>

        {/* Guia */}
        {o.guia && (
          <div className="flex items-center gap-1 mt-1 text-[10px]">
            <span className="font-mono text-muted-foreground">{o.guia.slice(-8)}</span>
            <button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.guia); toast.success('Guía copiada'); }}
              className="text-muted-foreground hover:text-foreground"><Copy size={8} /></button>
            {trackUrl && (
              <a href={trackUrl} target="_blank" rel="noopener noreferrer"
                onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.guia); toast.success('Guía copiada'); }}
                className="text-blue-400 hover:text-blue-300"><ExternalLink size={9} /></a>
            )}
          </div>
        )}

        {/* Novedad */}
        {o.novedad && (
          <div className="text-[10px] text-orange-400 mt-1.5 flex items-start gap-1">
            <AlertTriangle size={9} className="mt-0.5 flex-shrink-0" />
            <span>{truncate(o.novedad, 50)}</span>
          </div>
        )}

        {/* Alert badge */}
        {alert && alert.level !== 'ok' && (
          <div className="mt-1.5">
            <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold ${
              alert.level === 'lost' ? 'bg-muted/30 text-muted-foreground' :
              alert.level === 'critical' ? 'bg-red-500/10 text-red-400' :
              alert.level === 'alert' ? 'bg-orange-500/10 text-orange-400' :
              'bg-yellow-500/10 text-yellow-400'
            }`}>
              {alert.icon} {alert.label}
            </span>
          </div>
        )}

        {/* Managed status */}
        {managed && (
          <div className="mt-1.5">
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-green-500/10 text-green-400">
              <CheckCircle size={8} /> {managed}
            </span>
          </div>
        )}
      </div>

      {/* Expanded details */}
      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="border-t border-border overflow-hidden">
            <div className="px-3 py-2.5 space-y-2">
              {/* Details grid */}
              <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                {[
                  { label: 'Producto', value: truncate(o.producto || '—', 25) },
                  { label: 'Valor', value: `$${o.valor.toLocaleString()}` },
                  { label: 'Dirección', value: truncate(o.direccion || '—', 30) },
                  { label: 'Depto', value: o.departamento || '—' },
                ].map(d => (
                  <div key={d.label} className="bg-secondary/50 rounded-lg p-1.5">
                    <div className="text-[9px] text-muted-foreground">{d.label}</div>
                    <div className="font-medium text-foreground">{d.value}</div>
                  </div>
                ))}
              </div>

              {/* Touchpoint history */}
              {tps.length > 0 && (
                <div>
                  <h4 className="text-[10px] font-semibold text-foreground mb-1 inline-flex items-center gap-1">
                    <MessageSquare size={9} /> Historial ({tps.length})
                  </h4>
                  <div className="space-y-1 max-h-24 overflow-y-auto">
                    {tps.slice(0, 5).map(tp => (
                      <div key={tp.id} className="flex items-center gap-1.5 px-2 py-1 rounded bg-secondary/50 text-[9px]">
                        <User size={8} className="text-primary flex-shrink-0" />
                        <span className="font-medium text-foreground">{getOperatorName(tp.operator_id)}</span>
                        <span className="text-muted-foreground">—</span>
                        <span className="text-foreground truncate">{tp.action.replace(/^(SEG|RESCUE): ?/, '')}</span>
                        <span className="ml-auto text-muted-foreground flex-shrink-0 flex items-center gap-0.5">
                          <Clock size={7} /> {tp.action_time || ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Quick actions */}
              <div className="flex gap-1.5">
                <a href={`https://wa.me/57${o.phone}?text=${waMsg}`} target="_blank" rel="noopener noreferrer"
                  onClick={() => onAction('WhatsApp enviado')}
                  className="flex-1 text-[10px] py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 font-medium hover:bg-emerald-500/20 no-underline inline-flex items-center justify-center gap-1">
                  <Send size={9} /> WhatsApp
                </a>
                <button onClick={() => { navigator.clipboard.writeText(o.phone); toast.success('Tel copiado'); }}
                  className="flex-1 text-[10px] py-1.5 rounded-lg bg-secondary text-foreground font-medium hover:bg-secondary/80 inline-flex items-center justify-center gap-1">
                  <PhoneIcon size={9} /> Llamar
                </button>
              </div>

              {/* Action buttons */}
              {!managed && (
                <div className="flex flex-wrap gap-1">
                  {actions.map(a => (
                    <button key={a} onClick={() => onAction(a)}
                      className="text-[9px] px-2 py-1 rounded-lg bg-primary/10 text-primary font-medium hover:bg-primary/20 whitespace-nowrap">
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
