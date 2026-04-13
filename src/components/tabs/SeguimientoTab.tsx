import { useOrders } from '@/contexts/OrderContext';
import { isDespachado, isNovedad, isOficina, truncate, getTrackingUrl } from '@/lib/orderUtils';
import { SEG_ACTIONS } from '@/lib/constants';
import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { Package, Tag, AlertTriangle } from 'lucide-react';

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
  const novCount = segData.filter(o => isNovedad(o.estado) && !results[o.phone]).length;
  const ofiCount = segData.filter(o => isOficina(o.estado) && !results[o.phone]).length;
  const gestCount = segData.filter(o => !!results[o.phone]).length;

  return (
    <div className="max-w-5xl mx-auto">
      <p className="text-sm text-muted-foreground mb-5">Pedidos despachados en tránsito</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        {[
          { label: 'Pendientes', value: pendCount, color: 'text-blue' },
          { label: 'Novedades', value: novCount, color: 'text-orange' },
          { label: 'Oficina', value: ofiCount, color: 'text-purple' },
          { label: 'Gestionados', value: gestCount, color: 'text-green' },
        ].map(kpi => (
          <div key={kpi.label} className="bg-card rounded-xl border border-border p-4">
            <div className="text-xs text-muted-foreground font-medium mb-1">{kpi.label}</div>
            <div className={`font-mono text-2xl font-bold ${kpi.color}`}>{kpi.value}</div>
          </div>
        ))}
      </div>

      <div className="bg-card rounded-xl border border-border p-4 mb-4">
        <div className="flex gap-2 flex-wrap mb-3">
          {[
            { id: 'all', label: `Todos (${segData.length})` },
            { id: 'pendiente', label: `Pendientes (${pendCount})` },
            { id: 'novedad', label: `Novedad (${novCount})` },
            { id: 'oficina', label: `Oficina (${ofiCount})` },
            { id: 'gestionado', label: `Gestionados (${gestCount})` },
          ].map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                filter === f.id ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'
              }`}>
              {f.label}
            </button>
          ))}
        </div>
        <input type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Buscar guía, nombre o teléfono..."
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-12 text-center">
          <Package size={40} className="mx-auto mb-3 text-muted-foreground" />
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
                const riskClass = diasT >= 7 ? 'bg-red/10 text-red' : diasT >= 5 ? 'bg-orange/10 text-orange' : 'bg-green/10 text-green';
                return (
                  <tr key={o.phone + o.idx} className={`border-b border-border last:border-0 hover:bg-secondary/30 transition-colors ${managed ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{o.nombre}</div>
                      {o.guia && (
                        <div className="text-xs text-muted-foreground mt-0.5 inline-flex items-center gap-1">
                          <Tag size={10} /> {o.guia.slice(-8)} {o.transportadora || ''}
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
        </div>
      )}
    </div>
  );
}
