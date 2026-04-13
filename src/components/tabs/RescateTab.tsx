import { useOrders } from '@/contexts/OrderContext';
import { isDespachado, isNovedad, isOficina, truncate } from '@/lib/orderUtils';
import { RES_ACTIONS } from '@/lib/constants';
import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

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
    toast.success(`✅ ${action}`);
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

  return (
    <div className="max-w-5xl mx-auto">
      <p className="text-sm text-muted-foreground mb-5">Pedidos en riesgo que necesitan acción</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        {[
          { label: 'D5+ riesgo', value: d5plus.length, color: 'text-red' },
          { label: 'Novedades', value: novedades.length, color: 'text-orange' },
          { label: 'Oficina', value: oficina.length, color: 'text-purple' },
          { label: 'Gestionados', value: gestionados.length, color: 'text-green' },
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
            { id: 'pendiente', label: `Sin gestionar (${sinGestionar.length})` },
            { id: 'd5plus', label: `D5+ (${d5plus.length})` },
            { id: 'novedad', label: `Novedad (${novedades.length})` },
            { id: 'oficina', label: `Oficina (${oficina.length})` },
            { id: 'gestionado', label: `Gestionados (${gestionados.length})` },
            { id: 'all', label: `Todos (${resData.length})` },
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
          placeholder="Buscar nombre, teléfono o guía..."
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-12 text-center">
          <div className="text-4xl mb-3">✅</div>
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
                return (
                  <tr key={o.phone + o.idx} className={`border-b border-border last:border-0 hover:bg-secondary/30 transition-colors ${managed ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{o.nombre}</div>
                      <div className="text-xs text-muted-foreground">{o.ciudad || '—'}</div>
                      {o.novedad && <div className="text-xs text-orange mt-0.5">⚠️ {truncate(o.novedad, 40)}</div>}
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
                      <span className="inline-flex px-2 py-0.5 rounded text-xs font-bold bg-red/10 text-red">D{diasT}</span>
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
        </div>
      )}
    </div>
  );
}
