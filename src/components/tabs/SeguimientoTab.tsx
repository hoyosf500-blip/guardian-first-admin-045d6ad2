import { useOrders } from '@/contexts/OrderContext';
import { isDespachado, isNovedad, isOficina, truncate, getTrackingUrl } from '@/lib/orderUtils';
import { SEG_ACTIONS } from '@/lib/constants';
import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import {
  Package, Tag, AlertTriangle, Truck, AlertCircle, Building2,
  CheckCircle2, Search, ExternalLink
} from 'lucide-react';
import { motion } from 'framer-motion';

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

export default function SeguimientoTab() {
  const { segData } = useOrders();
  const { user } = useAuth();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Record<string, string>>({});

  const markSeg = async (phone: string, action: string) => {
    setResults(prev => ({ ...prev, [phone]: action }));
    if (user) {
      await supabase.from('touchpoints').insert({
        phone, action: `SEG: ${action}`, operator_id: user.id,
        action_date: new Date().toISOString().split('T')[0],
        action_time: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }),
      });
    }
    toast.success(action);
  };

  const filtered = segData.filter(o => {
    const managed = !!results[o.phone];
    if (filter === 'pendiente' && managed) return false;
    if (filter === 'transito' && (!isDespachado(o.estado) || managed)) return false;
    if (filter === 'novedad' && (!isNovedad(o.estado) || managed)) return false;
    if (filter === 'oficina' && (!isOficina(o.estado) || managed)) return false;
    if (filter === 'gestionado' && !managed) return false;
    if (search) {
      const s = search.toLowerCase();
      return o.nombre.toLowerCase().includes(s) || o.phone.includes(s) || (o.guia || '').toLowerCase().includes(s);
    }
    return true;
  }).sort((a, b) => (b.diasConf || b.dias) - (a.diasConf || a.dias));

  const pendCount = segData.filter(o => !results[o.phone]).length;
  const transitCount = segData.filter(o => isDespachado(o.estado) && !results[o.phone]).length;
  const novCount = segData.filter(o => isNovedad(o.estado) && !results[o.phone]).length;
  const ofiCount = segData.filter(o => isOficina(o.estado) && !results[o.phone]).length;
  const gestCount = segData.filter(o => !!results[o.phone]).length;

  const hasData = segData.length > 0;

  return (
    <div className="max-w-6xl mx-auto">
      {/* Toolbar */}
      <motion.div {...fadeUp(0)} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Seguimiento</h2>
          <p className="text-xs text-muted-foreground">Pedidos despachados en tránsito</p>
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
            <Truck size={28} className="text-muted-foreground" />
          </div>
          <h3 className="text-base font-semibold text-foreground mb-1">Sin pedidos en seguimiento</h3>
          <p className="text-sm text-muted-foreground max-w-xs">
            Los pedidos despachados aparecerán aquí para que puedas rastrear su estado.
          </p>
        </motion.div>
      ) : (
        <>
          {/* KPI Cards — Dashboard style */}
          <motion.div {...fadeUp(0.05)} className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
            {[
              { icon: Package, label: 'Total', value: segData.length, iconBg: 'bg-blue/10', iconColor: 'text-blue', color: 'text-foreground' },
              { icon: Truck, label: 'En tránsito', value: transitCount, iconBg: 'bg-blue/10', iconColor: 'text-blue', color: 'text-blue' },
              { icon: AlertCircle, label: 'Novedades', value: novCount, iconBg: 'bg-orange/10', iconColor: 'text-orange', color: 'text-orange' },
              { icon: Building2, label: 'Oficina', value: ofiCount, iconBg: 'bg-purple/10', iconColor: 'text-purple', color: 'text-purple' },
              { icon: CheckCircle2, label: 'Gestionados', value: gestCount, iconBg: 'bg-green/10', iconColor: 'text-green', color: 'text-green' },
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

          {/* Filter tabs — inline style like Dashboard period selector */}
          <motion.div {...fadeUp(0.18)} className="flex items-center gap-3 mb-4">
            <div className="inline-flex bg-secondary rounded-lg p-0.5 flex-wrap">
              {[
                { id: 'all', label: 'Todos', count: segData.length },
                { id: 'pendiente', label: 'Pendientes', count: pendCount },
                { id: 'novedad', label: 'Novedad', count: novCount },
                { id: 'oficina', label: 'Oficina', count: ofiCount },
                { id: 'gestionado', label: 'Gestionados', count: gestCount },
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
                <Package size={32} className="mx-auto mb-3 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">No hay pedidos en este filtro</p>
              </div>
            ) : (
              <div className="bg-card rounded-xl border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="text-left px-4 py-3 font-medium">Cliente</th>
                      <th className="text-left px-4 py-3 font-medium hidden md:table-cell">Ciudad</th>
                      <th className="text-left px-4 py-3 font-medium hidden md:table-cell">Estado</th>
                      <th className="text-center px-4 py-3 font-medium">Días</th>
                      <th className="text-right px-4 py-3 font-medium">Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.slice(0, 50).map(o => {
                      const diasT = o.diasConf || o.dias;
                      const managed = results[o.phone];
                      const riskClass = diasT >= 7 ? 'bg-red/10 text-red' : diasT >= 4 ? 'bg-yellow/10 text-yellow' : 'bg-green/10 text-green';
                      const trackUrl = getTrackingUrl(o.transportadora, o.guia);
                      return (
                        <tr key={o.phone + o.idx} className={`border-b border-border last:border-0 hover:bg-secondary/30 transition-colors ${managed ? 'opacity-50' : ''}`}>
                          <td className="px-4 py-3">
                            <div className="font-medium text-foreground">{o.nombre}</div>
                            {o.guia && (
                              <div className="text-xs text-muted-foreground mt-0.5 inline-flex items-center gap-1">
                                <Tag size={10} />
                                <span>{o.guia.slice(-8)}</span>
                                {o.transportadora && <span className="text-[10px] opacity-60">{o.transportadora}</span>}
                                {trackUrl && (
                                  <a href={trackUrl} target="_blank" rel="noopener noreferrer"
                                    onClick={() => {
                                      navigator.clipboard.writeText(o.guia).then(() => {
                                        toast.success('Guía copiada: ' + o.guia);
                                      });
                                    }}
                                    className="text-blue hover:underline" title="Abrir rastreo (guía copiada al portapapeles)">
                                    <ExternalLink size={10} />
                                  </a>
                                )}
                              </div>
                            )}
                            {o.novedad && !o.novedadSol && (
                              <div className="text-xs text-orange mt-0.5 inline-flex items-center gap-1">
                                <AlertTriangle size={10} /> {truncate(o.novedad, 40)}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{o.ciudad || '—'}</td>
                          <td className="px-4 py-3 hidden md:table-cell">
                            <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium ${
                              isNovedad(o.estado) ? 'bg-orange/10 text-orange' : isOficina(o.estado) ? 'bg-purple/10 text-purple' : 'bg-blue/10 text-blue'
                            }`}>{o.estado}</span>
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
                                  {SEG_ACTIONS.map(a => (
                                    <button key={a} onClick={() => markSeg(o.phone, a)}
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
