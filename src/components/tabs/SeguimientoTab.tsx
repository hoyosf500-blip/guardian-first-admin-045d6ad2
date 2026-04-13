import { useOrders } from '@/contexts/OrderContext';
import { isDespachado, isNovedad, isOficina, truncate, getTrackingUrl, formatPhone } from '@/lib/orderUtils';
import { SEG_ACTIONS } from '@/lib/constants';
import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

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
    toast.success(`✅ ${action}`);
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
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight">📦 Seguimiento</h1>
          <div className="text-xs text-muted-foreground">Pedidos despachados en tránsito</div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-3">
        <div className="bg-card border border-border rounded-lg p-3 text-center border-l-[3px] border-l-blue">
          <div className="font-mono text-2xl font-bold text-blue">{pendCount}</div>
          <div className="text-[10px] text-muted-foreground font-semibold uppercase">Pendientes</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-3 text-center border-l-[3px] border-l-orange">
          <div className="font-mono text-2xl font-bold text-orange">{novCount}</div>
          <div className="text-[10px] text-muted-foreground font-semibold uppercase">Novedades</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-3 text-center border-l-[3px] border-l-purple">
          <div className="font-mono text-2xl font-bold text-purple">{ofiCount}</div>
          <div className="text-[10px] text-muted-foreground font-semibold uppercase">Oficina</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-3 text-center border-l-[3px] border-l-green">
          <div className="font-mono text-2xl font-bold text-green">{gestCount}</div>
          <div className="text-[10px] text-muted-foreground font-semibold uppercase">Gestionados</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-1.5 flex-wrap mb-3">
        {[
          { id: 'all', label: `Todos (${segData.length})` },
          { id: 'pendiente', label: `⏳ Pendientes (${pendCount})` },
          { id: 'novedad', label: `⚠️ Novedad (${novCount})` },
          { id: 'oficina', label: `🏢 Oficina (${ofiCount})` },
          { id: 'gestionado', label: `✅ (${gestCount})` },
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
          placeholder="Buscar guía, nombre o teléfono..."
          className="w-full pl-9 pr-3 py-2.5 bg-card border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">
          <div className="text-5xl mb-3">📦</div>
          <p className="text-sm">No hay pedidos en este filtro</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-2">
          {filtered.slice(0, 50).map(o => {
            const diasT = o.diasConf || o.dias;
            const e = o.estado.toUpperCase();
            const managed = results[o.phone];
            const riskClass = diasT >= 7 ? 'bg-red/15 text-red' : diasT >= 5 ? 'bg-orange/15 text-orange' : 'bg-green/15 text-green';

            return (
              <div key={o.phone + o.idx} className={`flex flex-wrap items-center gap-3 p-3.5 bg-card border border-border rounded-lg transition-all ${managed ? 'opacity-50' : ''}`}>
                <div className={`w-1.5 h-9 rounded-sm flex-shrink-0 ${isNovedad(e) ? 'bg-orange' : isOficina(e) ? 'bg-purple' : 'bg-blue'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold truncate">
                    {o.nombre}
                    {managed && <span className="text-[10px] text-green ml-1">{managed}</span>}
                  </div>
                  <div className="text-[11px] text-muted-foreground flex gap-2 mt-0.5">
                    <span>📍 {o.ciudad || '—'}</span>
                    {o.guia && <span>🏷️{o.guia.slice(-8)}</span>}
                    <span>{o.transportadora || ''}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{o.estado}</div>
                  {o.novedad && !o.novedadSol && (
                    <div className="text-[10px] text-orange mt-0.5">⚠️ {truncate(o.novedad, 50)}</div>
                  )}
                </div>
                <div className="text-right">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${riskClass}`}>D{diasT}</span>
                  {o.guia && (
                    <div className="mt-1">
                      <a href={getTrackingUrl(o.transportadora, o.guia) || '#'} target="_blank" rel="noreferrer" className="text-cyan text-[10px]">🔍</a>
                    </div>
                  )}
                </div>
                {!managed && (
                  <details className="w-full pl-4 mt-1" onClick={e => e.stopPropagation()}>
                    <summary className="text-xs text-cyan cursor-pointer py-1.5">Gestionar →</summary>
                    <div className="flex gap-1 mt-1.5 flex-wrap">
                      {SEG_ACTIONS.map(a => (
                        <button key={a} onClick={() => markSeg(o.phone, a)}
                          className="text-[10px] px-2.5 py-1.5 rounded-md bg-muted text-muted-foreground font-semibold hover:bg-muted/80 transition-colors">
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
