import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { OrderData, truncate, getTrackingUrl } from '@/lib/orderUtils';
import { toast } from 'sonner';
import {
  Tag, AlertTriangle, ExternalLink, ChevronDown, ChevronRight,
  MessageSquare, Phone as PhoneIcon, Clock, User, Copy, ArrowUpDown, ArrowUp, ArrowDown,
  Package, Truck, MapPin, Bell, AlertCircle, RotateCcw, Layers
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
  {
    key: 'bodega',
    label: 'En Bodega',
    icon: <Package size={14} />,
    color: 'text-blue',
    bgColor: 'bg-blue/10',
    match: (e) => e.includes('BODEGA'),
  },
  {
    key: 'guia',
    label: 'Guía Generada',
    icon: <Tag size={14} />,
    color: 'text-cyan-500',
    bgColor: 'bg-cyan-500/10',
    match: (e) => e === 'GUIA_GENERADA' || e.includes('GUIA GENERADA') || e.includes('PREPARADO'),
  },
  {
    key: 'transito',
    label: 'En Tránsito',
    icon: <Truck size={14} />,
    color: 'text-indigo-500',
    bgColor: 'bg-indigo-500/10',
    match: (e) => e.includes('REPARTO') || e.includes('DISTRIBUCION') || e.includes('TERMINAL') || e.includes('REEXPEDICION') || e.includes('DESPACHAD') || e.includes('REENVÍO') || e.includes('REENVIO'),
  },
  {
    key: 'novedad',
    label: 'Novedad',
    icon: <AlertTriangle size={14} />,
    color: 'text-orange',
    bgColor: 'bg-orange/10',
    match: (e) => e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA',
  },
  {
    key: 'oficina',
    label: 'Reclame en Oficina',
    icon: <MapPin size={14} />,
    color: 'text-purple-500',
    bgColor: 'bg-purple-500/10',
    match: (e) => e.includes('OFICINA') || e.includes('RECLAME'),
  },
  {
    key: 'devolucion',
    label: 'Devolución',
    icon: <RotateCcw size={14} />,
    color: 'text-red',
    bgColor: 'bg-red/10',
    match: (e) => e.includes('DEVOL'),
  },
  {
    key: 'otros',
    label: 'Otros',
    icon: <Layers size={14} />,
    color: 'text-muted-foreground',
    bgColor: 'bg-secondary',
    match: () => true, // catch-all
  },
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
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('dias');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  useEffect(() => {
    if (!data.length) return;
    const phones = [...new Set(data.map(o => o.phone))];
    const prefix = module === 'SEG' ? 'SEG:' : 'RESCUE:';

    supabase.from('touchpoints')
      .select('*')
      .in('phone', phones.slice(0, 100))
      .like('action', `${prefix}%`)
      .order('created_at', { ascending: false })
      .then(({ data: tp }) => {
        if (tp) {
          setTouchpoints(tp);
          const managed: Record<string, string> = {};
          const today = new Date().toISOString().split('T')[0];
          tp.forEach(t => {
            if (t.action_date === today && !managed[t.phone]) {
              managed[t.phone] = t.action.replace(`${prefix} `, '');
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
      if (inserted) {
        setTouchpoints(prev => [...inserted, ...prev]);
      }
    }
    toast.success(action);
  };

  // Filter
  const baseFiltered = useMemo(() => {
    return data.filter(o => {
      if (gestionFilter === 'pendiente' && results[o.phone]) return false;
      if (gestionFilter === 'gestionado' && !results[o.phone]) return false;
      if (search) {
        const s = search.toLowerCase();
        return o.nombre.toLowerCase().includes(s) || o.phone.includes(s) ||
          (o.guia || '').toLowerCase().includes(s) || (o.ciudad || '').toLowerCase().includes(s);
      }
      return true;
    });
  }, [data, gestionFilter, search, results]);

  // Group by status
  const grouped = useMemo(() => {
    const groups: Record<string, OrderData[]> = {};
    STATUS_GROUPS.forEach(g => { groups[g.key] = []; });
    baseFiltered.forEach(o => {
      const key = classifyOrder(o.estado);
      groups[key].push(o);
    });
    // Sort within each group
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

  // Stale orders: 2+ days without movement
  const staleOrders = useMemo(() => {
    return baseFiltered.filter(o => {
      const dias = o.diasConf || o.dias;
      return dias >= 2;
    });
  }, [baseFiltered]);

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

  if (!data.length) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-16 h-16 rounded-2xl bg-secondary flex items-center justify-center mb-4">{emptyIcon}</div>
        <h3 className="text-base font-semibold text-foreground mb-1">{emptyTitle}</h3>
        <p className="text-sm text-muted-foreground max-w-xs">{emptyDesc}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3">
        <input type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Buscar nombre, teléfono, guía, ciudad..."
          className="flex-1 pl-3 pr-3 py-2 bg-secondary border-none rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="inline-flex bg-secondary rounded-lg p-0.5">
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
      </div>

      {/* Stale orders alert */}
      {staleOrders.length > 0 && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
          className="bg-red/10 border border-red/20 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Bell size={16} className="text-red" />
            <h4 className="text-sm font-semibold text-red">
              Alerta: {staleOrders.length} pedidos con 2+ días sin movimiento
            </h4>
          </div>
          <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
            {staleOrders.slice(0, 30).map(o => (
              <button key={o.phone + o.idx}
                onClick={() => { setExpandedPhone(o.phone); setSearch(o.guia || o.phone); }}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-red/10 hover:bg-red/20 text-xs text-red font-medium transition-colors">
                <AlertCircle size={10} />
                {o.guia ? `Guía ${o.guia.slice(-6)}` : o.nombre.split(' ')[0]}
                <span className="font-bold">D{o.diasConf || o.dias}</span>
              </button>
            ))}
            {staleOrders.length > 30 && (
              <span className="text-xs text-red/70 self-center ml-1">+{staleOrders.length - 30} más</span>
            )}
          </div>
        </motion.div>
      )}

      {/* Summary */}
      <div className="flex gap-2 flex-wrap text-xs">
        {STATUS_GROUPS.filter(g => grouped[g.key].length > 0).map(g => (
          <span key={g.key} className={`px-2.5 py-1 rounded-lg ${g.bgColor} ${g.color} font-medium`}>
            {g.label}: {grouped[g.key].length}
          </span>
        ))}
      </div>

      {/* Grouped tables by status */}
      {STATUS_GROUPS.filter(g => grouped[g.key].length > 0).map(group => {
        const items = grouped[group.key];
        const isCollapsed = collapsedGroups.has(group.key);
        const staleInGroup = items.filter(o => (o.diasConf || o.dias) >= 2).length;

        return (
          <div key={group.key} className="bg-card rounded-xl border border-border overflow-hidden">
            {/* Group header */}
            <button onClick={() => toggleGroup(group.key)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-secondary/30 transition-colors">
              <div className="flex items-center gap-2">
                {isCollapsed ? <ChevronRight size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
                <span className={`${group.color}`}>{group.icon}</span>
                <span className="text-sm font-semibold text-foreground">{group.label}</span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${group.bgColor} ${group.color}`}>{items.length}</span>
              </div>
              <div className="flex items-center gap-2">
                {staleInGroup > 0 && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-red/10 text-red">
                    <AlertCircle size={9} /> {staleInGroup} alertas
                  </span>
                )}
              </div>
            </button>

            {/* Group table */}
            {!isCollapsed && (
              <div className="overflow-x-auto border-t border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] text-muted-foreground bg-secondary/30">
                      <th className="text-left px-3 py-2 font-medium cursor-pointer select-none" onClick={() => toggleSort('nombre')}>
                        <span className="inline-flex items-center gap-1">Cliente <SortIcon col="nombre" /></span>
                      </th>
                      <th className="text-left px-3 py-2 font-medium hidden md:table-cell">Guía</th>
                      <th className="text-left px-3 py-2 font-medium hidden md:table-cell cursor-pointer select-none" onClick={() => toggleSort('ciudad')}>
                        <span className="inline-flex items-center gap-1">Ciudad <SortIcon col="ciudad" /></span>
                      </th>
                      <th className="text-left px-3 py-2 font-medium">Estado</th>
                      <th className="text-center px-3 py-2 font-medium cursor-pointer select-none" onClick={() => toggleSort('dias')}>
                        <span className="inline-flex items-center gap-1">Días <SortIcon col="dias" /></span>
                      </th>
                      <th className="text-left px-3 py-2 font-medium hidden lg:table-cell cursor-pointer select-none" onClick={() => toggleSort('transportadora')}>
                        <span className="inline-flex items-center gap-1">Transp. <SortIcon col="transportadora" /></span>
                      </th>
                      <th className="text-center px-3 py-2 font-medium cursor-pointer select-none" onClick={() => toggleSort('gestion')}>
                        <span className="inline-flex items-center gap-1">Gestión <SortIcon col="gestion" /></span>
                      </th>
                      <th className="text-right px-3 py-2 font-medium">Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.slice(0, 100).map(o => {
                      const diasT = o.diasConf || o.dias;
                      const managed = results[o.phone];
                      const isStale = diasT >= 2;
                      const riskClass = diasT >= 7 ? 'bg-red/10 text-red' : diasT >= 4 ? 'bg-yellow/10 text-yellow' : diasT >= 2 ? 'bg-orange/10 text-orange' : 'bg-green/10 text-green';
                      const trackUrl = getTrackingUrl(o.transportadora, o.guia);
                      const isExpanded = expandedPhone === o.phone;

                      return (
                        <>
                          <tr key={o.phone + o.idx}
                            className={`border-b border-border/50 last:border-0 hover:bg-secondary/20 transition-colors cursor-pointer ${isStale ? 'border-l-2 border-l-red/40' : ''} ${managed ? 'opacity-60' : ''}`}
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
                                  <button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.guia); toast.success('Guía copiada'); }}
                                    className="hover:text-foreground"><Copy size={9} /></button>
                                  {trackUrl && (
                                    <a href={trackUrl} target="_blank" rel="noopener noreferrer"
                                      onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.guia); toast.success('Guía copiada'); }}
                                      className="text-blue hover:text-blue/80"><ExternalLink size={10} /></a>
                                  )}
                                </div>
                              ) : '—'}
                            </td>
                            <td className="px-3 py-2.5 text-xs text-muted-foreground hidden md:table-cell">{o.ciudad || '—'}</td>
                            <td className="px-3 py-2.5">
                              <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium ${group.bgColor} ${group.color}`}>
                                {o.estado || '—'}
                              </span>
                              {o.novedad && (
                                <div className="text-[10px] text-orange mt-0.5 inline-flex items-center gap-1">
                                  <AlertTriangle size={8} /> {truncate(o.novedad, 25)}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              <span className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-xs font-bold ${riskClass}`}>
                                {isStale && <AlertCircle size={10} />}
                                D{diasT}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-xs text-muted-foreground hidden lg:table-cell">{o.transportadora || '—'}</td>
                            <td className="px-3 py-2.5 text-center">
                              {managed ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-green/10 text-green">{managed}</span>
                              ) : (
                                <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-medium bg-yellow/10 text-yellow">Pendiente</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-right" onClick={e => e.stopPropagation()}>
                              {!managed && (
                                <details className="inline-block">
                                  <summary className="text-xs text-blue cursor-pointer font-medium">Gestionar</summary>
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
                          {/* Expanded detail inline */}
                          {isExpanded && (
                            <tr key={`exp-${o.phone}`}>
                              <td colSpan={8} className="px-0 py-0">
                                <motion.div
                                  initial={{ opacity: 0, height: 0 }}
                                  animate={{ opacity: 1, height: 'auto' }}
                                  exit={{ opacity: 0, height: 0 }}
                                  className="bg-secondary/20 px-4 py-4 space-y-3"
                                >
                                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                                    {[
                                      { label: 'Producto', value: truncate(o.producto || '—', 30) },
                                      { label: 'Valor', value: `$${o.valor.toLocaleString()}` },
                                      { label: 'Dirección', value: truncate(o.direccion || '—', 35) },
                                      { label: 'Departamento', value: o.departamento || '—' },
                                      { label: 'Transportadora', value: o.transportadora || '—' },
                                      { label: 'Guía completa', value: o.guia || '—' },
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
                                            <span className="text-foreground">{tp.action.replace(`${module}: `, '')}</span>
                                            <span className="ml-auto text-muted-foreground flex items-center gap-0.5 flex-shrink-0">
                                              <Clock size={8} /> {tp.action_date} {tp.action_time || ''}
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    )}
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
