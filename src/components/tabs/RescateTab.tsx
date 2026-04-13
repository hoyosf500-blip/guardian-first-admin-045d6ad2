import { useOrders } from '@/contexts/OrderContext';
import { isDespachado, isNovedad, isOficina, truncate, getTrackingUrl } from '@/lib/orderUtils';
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
    if (filter === 'd5plus' && (!(( o.diasConf || o.dias) >= 5 && isDespachado(o.estado)) || managed)) return false;
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
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight">🆘 Rescate</h1>
          <div className="text-xs text-muted-foreground">Pedidos en riesgo que necesitan acción</div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-3">
        <div className="bg-card border border-border rounded-lg p-3 text-center border-l-[3px] border-l-red">
          <div className="font-mono text-2xl font-bold text-red">{d5plus.length}</div>
          <div className="text-[10px] text-muted-foreground font-semibold uppercase">D5+ riesgo</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-3 text-center border-l-[3px] border-l-orange">
          <div className="font-mono text-2xl font-bold text-orange">{novedades.length}</div>
          <div className="text-[10px] text-muted-foreground font-semibold uppercase">Novedades</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-3 text-center border-l-[3px] border-l-purple">
          <div className="font-mono text-2xl font-bold text-purple">{oficina.length}</div>
          <div className="text-[10px] text-muted-foreground font-semibold uppercase">Oficina</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-3 text-center border-l-[3px] border-l-green">
          <div className="font-mono text-2xl font-bold text-green">{gestionados.length}</div>
          <div className="text-[10px] text-muted-foreground font-semibold uppercase">Gestionados</div>
        </div>
      </div>

      <div className="flex gap-1.5 flex-wrap mb-3">
        {[
          { id: 'pendiente', label: `⏳ Sin gestionar (${sinGestionar.length})` },
          { id: 'd5plus', label: `🔴 D5+ (${d5plus.length})` },
          { id: 'novedad', label: `⚠️ Novedad (${novedades.length})` },
          { id: 'oficina', label: `🏢 Oficina (${oficina.length})` },
          { id: 'gestionado', label: `✅ (${gestionados.length})` },
          { id: 'all', label: `📋 Todos (${resData.length})` },
        ].map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-all ${filter === f.id ? 'bg-cyan/10 text-cyan border-cyan/30' : 'bg-muted/50 text-muted-foreground border-border'}`}>
            {f.label}
          </button>
        ))}
      </div>

      <div className="relative mb-3">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm">🔍</span>
        <input
          type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Buscar nombre, teléfono o guía..."
          className="w-full pl-9 pr-3 py-2.5 bg-card border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">
          <div className="text-5xl mb-3">✅</div>
          <p className="text-sm">No hay pedidos en este filtro</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-2">
          {filtered.slice(0, 50).map(o => {
            const diasT = o.diasConf || o.dias;
            const managed = results[o.phone];
            return (
              <div key={o.phone + o.idx} className={`flex flex-wrap items-center gap-3 p-3.5 bg-card border border-border rounded-lg transition-all ${managed ? 'opacity-50' : ''}`}>
                <div className="w-1.5 h-9 rounded-sm bg-red flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold truncate">
                    {o.nombre}
                    {managed && <span className="text-[10px] text-green ml-1">{managed}</span>}
                  </div>
                  <div className="text-[11px] text-muted-foreground flex gap-2 mt-0.5">
                    <span>📍 {o.ciudad || '—'}</span>
                    <span>📦 {truncate(o.producto || '—', 15)}</span>
                  </div>
                  {o.novedad && <div className="text-[10px] text-orange mt-0.5">⚠️ {truncate(o.novedad, 50)}</div>}
                </div>
                <div className="text-right">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red/15 text-red">D{diasT}</span>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {isNovedad(o.estado) ? '⚠️ Novedad' : isOficina(o.estado) ? '🏢 Oficina' : o.estado.includes('DEVOL') ? '↩️ Devol' : `🚚 D${diasT}`}
                  </div>
                </div>
                {!managed && (
                  <details className="w-full pl-4 mt-1" onClick={e => e.stopPropagation()}>
                    <summary className="text-xs text-cyan cursor-pointer py-1.5">Gestionar →</summary>
                    <div className="flex gap-1 mt-1.5 flex-wrap">
                      {RES_ACTIONS.map(a => (
                        <button key={a} onClick={() => markRes(o.phone, a)}
                          className="text-[10px] px-2.5 py-1.5 rounded-md bg-muted text-muted-foreground font-semibold">
                          {a}
                        </button>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
