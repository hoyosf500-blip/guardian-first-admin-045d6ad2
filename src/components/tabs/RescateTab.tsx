import { useOrders } from '@/contexts/OrderContext';
import { isDespachado, isNovedad, isOficina, truncate } from '@/lib/orderUtils';
import { RES_ACTIONS } from '@/lib/constants';
import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import {
  CheckCircle2, AlertTriangle, AlertOctagon, Building2,
  LifeBuoy, Search, Flame
} from 'lucide-react';
import { motion } from 'framer-motion';

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

export default function RescateTab() {
  const { resData } = useOrders();
  const { user } = useAuth();
  const [filter, setFilter] = useState('pendiente');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Record<string, string>>({});

  const markRes = async (phone: string, action: string) => {
    setResults(prev => ({ ...prev, [phone]: action }));
    if (user) {
      await supabase.from('touchpoints').insert({
        phone, action: `RESCUE: ${action}`, operator_id: user.id,
        action_date: new Date().toISOString().split('T')[0],
        action_time: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }),
      });
    }
    toast.success(action);
  };

  const sinGestionar = resData.filter(o => !results[o.phone]);
  const gestionados = resData.filter(o => !!results[o.phone]);
  const d5plus = sinGestionar.filter(o => (o.diasConf || o.dias) >= 5 && isDespachado(o.estado));
  const novedades = sinGestionar.filter(o => isNovedad(o.estado));
  const oficina = sinGestionar.filter(o => isOficina(o.estado));

  const filtered = resData.filter(o => {
    const managed = !!results[o.phone];
    if (filter === 'pendiente' && managed) return false;
    if (filter === 'd5plus' && (!((o.diasConf || o.dias) >= 5 && isDespachado(o.estado)) || managed)) return false;
    if (filter === 'novedad' && (!isNovedad(o.estado) || managed)) return false;
    if (filter === 'oficina' && (!isOficina(o.estado) || managed)) return false;
    if (filter === 'gestionado' && !managed) return false;
    if (search) {
      const s = search.toLowerCase();
      return o.nombre.toLowerCase().includes(s) || o.phone.includes(s) || (o.guia || '').includes(s);
    }
    return true;
  }).sort((a, b) => (b.diasConf || b.dias) - (a.diasConf || a.dias));

  const hasData = resData.length > 0;

  return (
    <div className="max-w-6xl mx-auto">
      {/* Toolbar */}
      <motion.div {...fadeUp(0)} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Rescate</h2>
          <p className="text-xs text-muted-foreground">Pedidos en riesgo que necesitan acción</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Buscar..."
              className="pl-8 pr-3 py-1.5 w-48 bg-secondary border-none rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>
      </motion.div>

      {!hasData ? (
        <motion.div {...fadeUp(0.05)} className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-16 h-16 rounded-2xl bg-secondary flex items-center justify-center mb-4">
            <LifeBuoy size={28} className="text-muted-foreground" />
          </div>
          <h3 className="text-base font-semibold text-foreground mb-1">Sin pedidos en rescate</h3>
          <p className="text-sm text-muted-foreground max-w-xs">
            Los pedidos en riesgo (D5+, novedades, oficina) aparecerán aquí.
          </p>
        </motion.div>
      ) : (
        <>
          {/* KPI Cards — Dashboard style */}
          <motion.div {...fadeUp(0.05)} className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
            {[
              { icon: LifeBuoy, label: 'Sin gestionar', value: sinGestionar.length, iconBg: 'bg-blue/10', iconColor: 'text-blue', color: 'text-foreground' },
              { icon: Flame, label: 'D5+ riesgo', value: d5plus.length, iconBg: 'bg-red/10', iconColor: 'text-red', color: 'text-red' },
              { icon: AlertOctagon, label: 'Novedades', value: novedades.length, iconBg: 'bg-orange/10', iconColor: 'text-orange', color: 'text-orange' },
              { icon: Building2, label: 'Oficina', value: oficina.length, iconBg: 'bg-purple/10', iconColor: 'text-purple', color: 'text-purple' },
              { icon: CheckCircle2, label: 'Gestionados', value: gestionados.length, iconBg: 'bg-green/10', iconColor: 'text-green', color: 'text-green' },
            ].map((kpi, i) => {
              const Icon = kpi.icon;
              return (
                <motion.div key={kpi.label} {...fadeUp(0.05 + i * 0.03)}
                  className="bg-card rounded-xl border border-border p-4 flex flex-col justify-between">
                  <div className="flex items-center justify-between mb-2">
                    <div className={`w-7 h-7 rounded-lg ${kpi.iconBg} flex items-center justify-center`}>
                      <Icon size={14} className={kpi.iconColor} />
                    </div>
                  </div>
                  <div>
                    <div className={`font-mono text-2xl font-bold ${kpi.color} leading-none`}>{kpi.value}</div>
                    <div className="text-[10px] text-muted-foreground mt-1">{kpi.label}</div>
                  </div>
                </motion.div>
              );
            })}
          </motion.div>

          {/* Filter tabs — inline style */}
          <motion.div {...fadeUp(0.18)} className="flex items-center gap-3 mb-4">
            <div className="inline-flex bg-secondary rounded-lg p-0.5 flex-wrap">
              {[
                { id: 'pendiente', label: 'Sin gestionar', count: sinGestionar.length },
                { id: 'd5plus', label: 'D5+', count: d5plus.length },
                { id: 'novedad', label: 'Novedad', count: novedades.length },
                { id: 'oficina', label: 'Oficina', count: oficina.length },
                { id: 'gestionado', label: 'Gestionados', count: gestionados.length },
                { id: 'all', label: 'Todos', count: resData.length },
              ].map(f => (
                <button key={f.id} onClick={() => setFilter(f.id)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                    filter === f.id
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}>
                  {f.label} <span className="ml-1 opacity-60">{f.count}</span>
                </button>
              ))}
            </div>
          </motion.div>

          {/* Table */}
          <motion.div {...fadeUp(0.22)}>
            {filtered.length === 0 ? (
              <div className="bg-card rounded-xl border border-border p-12 text-center">
                <CheckCircle2 size={32} className="mx-auto mb-3 text-green" />
                <p className="text-sm text-muted-foreground">No hay pedidos en este filtro</p>
              </div>
            ) : (
              <div className="bg-card rounded-xl border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="text-left px-4 py-3 font-medium">Cliente</th>
                      <th className="text-left px-4 py-3 font-medium hidden md:table-cell">Producto</th>
                      <th className="text-left px-4 py-3 font-medium hidden md:table-cell">Tipo</th>
                      <th className="text-center px-4 py-3 font-medium">Días</th>
                      <th className="text-right px-4 py-3 font-medium">Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.slice(0, 50).map(o => {
                      const diasT = o.diasConf || o.dias;
                      const managed = results[o.phone];
                      const riskClass = diasT >= 7 ? 'bg-red/10 text-red' : diasT >= 4 ? 'bg-yellow/10 text-yellow' : 'bg-green/10 text-green';
                      return (
                        <tr key={o.phone + o.idx} className={`border-b border-border last:border-0 hover:bg-secondary/30 transition-colors ${managed ? 'opacity-50' : ''}`}>
                          <td className="px-4 py-3">
                            <div className="font-medium text-foreground">{o.nombre}</div>
                            <div className="text-xs text-muted-foreground">{o.ciudad || '—'}</div>
                            {o.novedad && (
                              <div className="text-xs text-orange mt-0.5 inline-flex items-center gap-1">
                                <AlertTriangle size={10} /> {truncate(o.novedad, 40)}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{truncate(o.producto || '—', 20)}</td>
                          <td className="px-4 py-3 hidden md:table-cell">
                            <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium ${
                              isNovedad(o.estado) ? 'bg-orange/10 text-orange' : isOficina(o.estado) ? 'bg-purple/10 text-purple' : 'bg-red/10 text-red'
                            }`}>
                              {isNovedad(o.estado) ? 'Novedad' : isOficina(o.estado) ? 'Oficina' : o.estado.includes('DEVOL') ? 'Devolución' : `D${diasT}`}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className={`inline-flex px-2 py-0.5 rounded text-xs font-bold ${riskClass}`}>D{diasT}</span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            {managed ? (
                              <span className="text-xs text-green font-medium">{managed}</span>
                            ) : (
                              <details className="inline-block">
                                <summary className="text-xs text-blue cursor-pointer font-medium">Gestionar</summary>
                                <div className="flex gap-1 mt-1.5 flex-wrap justify-end">
                                  {RES_ACTIONS.map(a => (
                                    <button key={a} onClick={() => markRes(o.phone, a)}
                                      className="text-[10px] px-2 py-1 rounded bg-secondary text-foreground font-medium hover:bg-secondary/80">
                                      {a}
                                    </button>
                                  ))}
                                </div>
                              </details>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filtered.length > 50 && (
                  <div className="px-4 py-3 border-t border-border text-center text-xs text-muted-foreground">
                    Mostrando 50 de {filtered.length} pedidos
                  </div>
                )}
              </div>
            )}
          </motion.div>
        </>
      )}
    </div>
  );
}
