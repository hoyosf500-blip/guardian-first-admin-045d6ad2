import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { OrderData, truncate, getTrackingUrl, isNovedad, isOficina, isDespachado } from '@/lib/orderUtils';
import { toast } from 'sonner';
import {
  Tag, AlertTriangle, ExternalLink, ChevronDown, ChevronRight,
  MessageSquare, Phone as PhoneIcon, Clock, User, Copy, ArrowUpDown, ArrowUp, ArrowDown
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

type SortKey = 'nombre' | 'ciudad' | 'estado' | 'dias' | 'gestion' | 'transportadora';
type SortDir = 'asc' | 'desc';

export default function CrmTable({ data, actions, module, emptyIcon, emptyTitle, emptyDesc }: CrmTableProps) {
  const { user } = useAuth();
  const [touchpoints, setTouchpoints] = useState<Touchpoint[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [results, setResults] = useState<Record<string, string>>({});
  const [expandedPhone, setExpandedPhone] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [gestionFilter, setGestionFilter] = useState<'all' | 'pendiente' | 'gestionado'>('all');
  const [sortKey, setSortKey] = useState<SortKey>('dias');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Load touchpoints and profiles
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
          // Mark managed ones
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

  // Unique statuses for dynamic filter
  const uniqueStatuses = useMemo(() => {
    const set = new Set(data.map(o => o.estado));
    return Array.from(set).sort();
  }, [data]);

  // Filtered + sorted data
  const filtered = useMemo(() => {
    let items = data.filter(o => {
      if (statusFilter !== 'all' && o.estado !== statusFilter) return false;
      if (gestionFilter === 'pendiente' && results[o.phone]) return false;
      if (gestionFilter === 'gestionado' && !results[o.phone]) return false;
      if (search) {
        const s = search.toLowerCase();
        return o.nombre.toLowerCase().includes(s) || o.phone.includes(s) ||
          (o.guia || '').toLowerCase().includes(s) || (o.ciudad || '').toLowerCase().includes(s);
      }
      return true;
    });

    items.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'nombre': cmp = a.nombre.localeCompare(b.nombre); break;
        case 'ciudad': cmp = (a.ciudad || '').localeCompare(b.ciudad || ''); break;
        case 'estado': cmp = a.estado.localeCompare(b.estado); break;
        case 'dias': cmp = (a.diasConf || a.dias) - (b.diasConf || b.dias); break;
        case 'transportadora': cmp = (a.transportadora || '').localeCompare(b.transportadora || ''); break;
        case 'gestion': {
          const aM = results[a.phone] ? 1 : 0;
          const bM = results[b.phone] ? 1 : 0;
          cmp = aM - bM;
          break;
        }
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });

    return items;
  }, [data, statusFilter, gestionFilter, search, sortKey, sortDir, results]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'dias' ? 'desc' : 'asc');
    }
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown size={12} className="opacity-30" />;
    return sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />;
  };

  const pendCount = data.filter(o => !results[o.phone]).length;
  const gestCount = data.filter(o => !!results[o.phone]).length;

  if (!data.length) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-16 h-16 rounded-2xl bg-secondary flex items-center justify-center mb-4">
          {emptyIcon}
        </div>
        <h3 className="text-base font-semibold text-foreground mb-1">{emptyTitle}</h3>
        <p className="text-sm text-muted-foreground max-w-xs">{emptyDesc}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar: search + filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Buscar nombre, teléfono, guía, ciudad..."
            className="w-full pl-3 pr-3 py-2 bg-secondary border-none rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          {/* Status filter */}
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="px-3 py-2 bg-secondary rounded-lg text-xs text-foreground border-none focus:outline-none focus:ring-1 focus:ring-ring">
            <option value="all">Todos los estados ({data.length})</option>
            {uniqueStatuses.map(s => (
              <option key={s} value={s}>{s} ({data.filter(o => o.estado === s).length})</option>
            ))}
          </select>
          {/* Gestion filter */}
          <div className="inline-flex bg-secondary rounded-lg p-0.5">
            {([
              { id: 'all' as const, label: 'Todos', count: data.length },
              { id: 'pendiente' as const, label: 'Pendientes', count: pendCount },
              { id: 'gestionado' as const, label: 'Gestionados', count: gestCount },
            ]).map(f => (
              <button key={f.id} onClick={() => setGestionFilter(f.id)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  gestionFilter === f.id
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}>
                {f.label} <span className="ml-1 opacity-60">{f.count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Summary badges */}
      <div className="flex gap-2 flex-wrap text-xs">
        <span className="px-2.5 py-1 rounded-lg bg-blue/10 text-blue font-medium">{data.length} total</span>
        <span className="px-2.5 py-1 rounded-lg bg-yellow/10 text-yellow font-medium">{pendCount} sin gestionar</span>
        <span className="px-2.5 py-1 rounded-lg bg-green/10 text-green font-medium">{gestCount} gestionados</span>
        {filtered.length !== data.length && (
          <span className="px-2.5 py-1 rounded-lg bg-secondary text-muted-foreground font-medium">Mostrando {filtered.length}</span>
        )}
      </div>

      {/* CRM Table */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground bg-secondary/50">
                <th className="w-8 px-2 py-3" />
                <th className="text-left px-3 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort('nombre')}>
                  <span className="inline-flex items-center gap-1">Cliente <SortIcon col="nombre" /></span>
                </th>
                <th className="text-left px-3 py-3 font-medium cursor-pointer select-none hidden md:table-cell" onClick={() => toggleSort('ciudad')}>
                  <span className="inline-flex items-center gap-1">Ciudad <SortIcon col="ciudad" /></span>
                </th>
                <th className="text-left px-3 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort('estado')}>
                  <span className="inline-flex items-center gap-1">Estado <SortIcon col="estado" /></span>
                </th>
                <th className="text-center px-3 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort('dias')}>
                  <span className="inline-flex items-center gap-1">Días <SortIcon col="dias" /></span>
                </th>
                <th className="text-left px-3 py-3 font-medium hidden lg:table-cell cursor-pointer select-none" onClick={() => toggleSort('transportadora')}>
                  <span className="inline-flex items-center gap-1">Transportadora <SortIcon col="transportadora" /></span>
                </th>
                <th className="text-center px-3 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort('gestion')}>
                  <span className="inline-flex items-center gap-1">Gestión <SortIcon col="gestion" /></span>
                </th>
                <th className="text-right px-3 py-3 font-medium">Acción</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">Sin resultados para este filtro</td></tr>
              ) : filtered.slice(0, 100).map(o => {
                const diasT = o.diasConf || o.dias;
                const managed = results[o.phone];
                const riskClass = diasT >= 7 ? 'bg-red/10 text-red' : diasT >= 4 ? 'bg-yellow/10 text-yellow' : 'bg-green/10 text-green';
                const trackUrl = getTrackingUrl(o.transportadora, o.guia);
                const history = phoneTouchpoints[o.phone] || [];
                const isExpanded = expandedPhone === o.phone;
                const statusClass = isNovedad(o.estado) ? 'bg-orange/10 text-orange' :
                  isOficina(o.estado) ? 'bg-purple/10 text-purple' :
                  isDespachado(o.estado) ? 'bg-blue/10 text-blue' :
                  o.estado.includes('DEVOL') ? 'bg-red/10 text-red' : 'bg-secondary text-muted-foreground';

                return (
                  <motion.tr
                    key={o.phone + o.idx}
                    initial={false}
                    className={`border-b border-border last:border-0 hover:bg-secondary/30 transition-colors cursor-pointer ${managed ? 'bg-green/[0.02]' : ''}`}
                    onClick={() => setExpandedPhone(isExpanded ? null : o.phone)}
                  >
                    <td className="px-2 py-3 text-muted-foreground">
                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </td>
                    <td className="px-3 py-3">
                      <div className="font-medium text-foreground text-xs">{o.nombre}</div>
                      <div className="text-[10px] text-muted-foreground inline-flex items-center gap-1 mt-0.5">
                        <PhoneIcon size={9} /> {o.phone}
                        <button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.phone); toast.success('Teléfono copiado'); }}
                          className="hover:text-foreground"><Copy size={9} /></button>
                      </div>
                      {o.guia && (
                        <div className="text-[10px] text-muted-foreground mt-0.5 inline-flex items-center gap-1">
                          <Tag size={9} /> {o.guia.slice(-8)}
                          {trackUrl && (
                            <a href={trackUrl} target="_blank" rel="noopener noreferrer"
                              onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.guia); toast.success('Guía copiada: ' + o.guia); }}
                              className="text-blue hover:underline" title="Rastrear (guía copiada)">
                              <ExternalLink size={9} />
                            </a>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground hidden md:table-cell">{o.ciudad || '—'}</td>
                    <td className="px-3 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium ${statusClass}`}>
                        {o.estado || '—'}
                      </span>
                      {o.novedad && !o.novedadSol && (
                        <div className="text-[10px] text-orange mt-0.5 inline-flex items-center gap-1">
                          <AlertTriangle size={9} /> {truncate(o.novedad, 30)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs font-bold ${riskClass}`}>D{diasT}</span>
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground hidden lg:table-cell">
                      {o.transportadora || '—'}
                    </td>
                    <td className="px-3 py-3 text-center">
                      {managed ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-green/10 text-green">
                          {managed}
                        </span>
                      ) : (
                        <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-medium bg-yellow/10 text-yellow">
                          Pendiente
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right" onClick={e => e.stopPropagation()}>
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
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length > 100 && (
          <div className="px-4 py-3 border-t border-border text-center text-xs text-muted-foreground">
            Mostrando 100 de {filtered.length} pedidos
          </div>
        )}
      </div>

      {/* Expanded detail panel */}
      <AnimatePresence>
        {expandedPhone && (() => {
          const order = data.find(o => o.phone === expandedPhone);
          const history = phoneTouchpoints[expandedPhone] || [];
          if (!order) return null;
          return (
            <motion.div
              key={expandedPhone}
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="bg-card rounded-xl border border-border p-5 space-y-4"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">{order.nombre}</h3>
                <button onClick={() => setExpandedPhone(null)} className="text-xs text-muted-foreground hover:text-foreground">Cerrar</button>
              </div>

              {/* Order detail grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                {[
                  { label: 'Teléfono', value: order.phone },
                  { label: 'Ciudad', value: order.ciudad || '—' },
                  { label: 'Estado', value: order.estado },
                  { label: 'Días', value: `D${order.diasConf || order.dias}` },
                  { label: 'Producto', value: truncate(order.producto || '—', 30) },
                  { label: 'Guía', value: order.guia || '—' },
                  { label: 'Transportadora', value: order.transportadora || '—' },
                  { label: 'Valor', value: `$${order.valor.toLocaleString()}` },
                  { label: 'Dirección', value: truncate(order.direccion || '—', 40) },
                  { label: 'Departamento', value: order.departamento || '—' },
                  { label: 'Novedad', value: order.novedad || '—' },
                  { label: 'Tienda', value: order.tienda || '—' },
                ].map(d => (
                  <div key={d.label} className="bg-secondary/50 rounded-lg p-2.5">
                    <div className="text-[10px] text-muted-foreground mb-0.5">{d.label}</div>
                    <div className="font-medium text-foreground">{d.value}</div>
                  </div>
                ))}
              </div>

              {/* Touchpoint history */}
              <div>
                <h4 className="text-xs font-semibold text-foreground mb-2 inline-flex items-center gap-1.5">
                  <MessageSquare size={12} /> Historial de gestiones ({history.length})
                </h4>
                {history.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-3">Sin gestiones registradas para este cliente</p>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {history.map(tp => (
                      <div key={tp.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-secondary/50 text-xs">
                        <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                          <User size={11} className="text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="font-medium text-foreground">{getOperatorName(tp.operator_id)}</span>
                          <span className="text-muted-foreground mx-1.5">—</span>
                          <span className="text-foreground">{tp.action.replace(`${module}: `, '')}</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground flex items-center gap-1 flex-shrink-0">
                          <Clock size={9} /> {tp.action_date} {tp.action_time || ''}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          );
        })()}
      </AnimatePresence>
    </div>
  );
}
