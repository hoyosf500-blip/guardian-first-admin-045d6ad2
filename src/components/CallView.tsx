import { useState, useEffect } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { useAuth } from '@/contexts/AuthContext';
import { useOrderLock } from '@/hooks/useOrderLock';
import { OrderData, formatPhone, getTrackingUrl, truncate } from '@/lib/orderUtils';
import { CANCEL_REASONS } from '@/lib/constants';
import { useSessionState } from '@/hooks/useSessionState';
import { useAiInsight } from '@/hooks/useAiInsight';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { CheckCircle2, XCircle, PhoneOff, Phone, MapPin, Package, DollarSign, Tag, AlertTriangle, ChevronLeft, ChevronRight, Mail, RotateCcw, Star, Sparkles, RefreshCw, Lock, Pencil } from 'lucide-react';
import FingerprintBadge from '@/components/FingerprintBadge';
import EditOrderDialog from '@/components/EditOrderDialog';

interface VipInfo {
  isVip: boolean;
  total: number;
  entregados: number;
  efectividad: number;
}

interface Props {
  items: OrderData[];
}

export default function CallView({ items }: Props) {
  const { markResult, undoLast } = useOrders();
  const { user } = useAuth();
  const { claimOrder, releaseOrder } = useOrderLock();
  // Persist callIdx across tab discards so the operator returns to the
  // exact same order after going out to the transportadora's page.
  const [callIdx, setCallIdx] = useSessionState<number>('confirmar:callIdx', 0);

  // Re-clamp index when items change (queue shrink, data refresh) and jump
  // to the first pending order if current one is already resolved.
  useEffect(() => {
    if (!items.length) return;
    if (callIdx >= items.length) {
      setCallIdx(Math.max(0, items.length - 1));
      return;
    }
    const current = items[callIdx];
    if (!current || current.result) {
      const firstPending = items.findIndex(o => !o.result);
      if (firstPending >= 0 && firstPending !== callIdx) {
        setCallIdx(firstPending);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  const [showCancelModal, setShowCancelModal] = useState(false);
  const [editingOrder, setEditingOrder] = useState<OrderData | null>(null);
  const [vip, setVip] = useState<VipInfo | null>(null);
  const { ask: askAi, get: getAi } = useAiInsight();

  const o = items[Math.min(callIdx, items.length - 1)];

  // VIP check: query order history for this phone (F4)
  useEffect(() => {
    if (!o?.phone) { setVip(null); return; }
    let cancelled = false;
    supabase
      .from('orders')
      .select('estado')
      .eq('phone', o.phone)
      .then(({ data }) => {
        if (cancelled || !data) return;
        const total = data.length;
        const entregados = data.filter(r => (r.estado || '').toUpperCase().includes('ENTREGADO')).length;
        const efectividad = total > 0 ? Math.round((entregados / total) * 100) : 0;
        setVip({
          isVip: total >= 3 && efectividad >= 80,
          total,
          entregados,
          efectividad,
        });
      });
    return () => { cancelled = true; };
  }, [o?.phone]);

  // Claim a lock on the current order; if held by someone else, skip forward.
  useEffect(() => {
    if (!o?.dbId || !user || o.result) return;
    const orderId = o.dbId;
    let cancelled = false;
    claimOrder(orderId).then(claimed => {
      if (cancelled) return;
      if (!claimed) {
        const nextIdx = items.findIndex((it, i) => i > callIdx && !it.result);
        if (nextIdx >= 0) {
          setCallIdx(nextIdx);
          toast.info('Pedido en uso por otra operadora — saltando al siguiente');
        } else {
          toast.info('Pedidos disponibles agotados — todos están en atención');
        }
      }
    });
    return () => {
      cancelled = true;
      // Release if the operator navigates away without marking a result.
      void releaseOrder(orderId);
    };
  }, [o?.dbId, user, claimOrder, releaseOrder, callIdx, items, setCallIdx, o?.result]);

  if (!items.length || !o) {
    return (
      <div className="text-center py-10 text-muted-foreground">
        <CheckCircle2 size={40} className="mx-auto mb-3 text-green" />
        <p className="text-sm">¡Todos gestionados!</p>
      </div>
    );
  }

  const pColor = o.dias >= 7 ? 'text-red' : o.dias >= 4 ? 'text-yellow' : 'text-green';
  const pDot = o.dias >= 7 ? 'bg-red' : o.dias >= 4 ? 'bg-yellow' : 'bg-green';

  const handleMark = async (result: string, reason?: string) => {
    await markResult(o, result, reason);
    // Release the lock immediately after registering the result.
    if (o.dbId) void releaseOrder(o.dbId);
    setShowCancelModal(false);
    toast.success(
      result === 'conf' ? `Confirmado — ${o.nombre.split(' ')[0]}` :
      result === 'canc' ? `Cancelado — ${o.nombre.split(' ')[0]}` :
      `No respondió — ${o.nombre.split(' ')[0]}`,
    );
    setTimeout(() => {
      const nextIdx = items.findIndex((item, i) => i > callIdx && !item.result);
      if (nextIdx >= 0) setCallIdx(nextIdx);
    }, 400);
  };

  const navCall = (dir: number) => {
    setCallIdx(Math.max(0, Math.min(items.length - 1, callIdx + dir)));
  };

  const copyPhone = () => {
    navigator.clipboard.writeText(o.phone).then(() => toast.success(`${o.phone} copiado`));
  };

  return (
    <>
      <div className="flex justify-between items-center mb-2">
        <span className="text-xs text-muted-foreground">{callIdx + 1} / {items.length}</span>
        <div className="flex gap-1.5">
          <button onClick={() => navCall(-1)} disabled={callIdx <= 0} className="px-3 py-1.5 rounded-md bg-muted text-muted-foreground text-xs font-semibold disabled:opacity-30 inline-flex items-center">
            <ChevronLeft size={14} />
          </button>
          <button onClick={() => navCall(1)} disabled={callIdx >= items.length - 1} className="px-3 py-1.5 rounded-md bg-muted text-muted-foreground text-xs font-semibold disabled:opacity-30 inline-flex items-center">
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div className="bg-gradient-to-b from-card to-surface border border-input rounded-2xl p-5 mb-4">
        {o.retryCount && !o.result && (
          <div className="flex items-center gap-2 mb-3 rounded-lg bg-orange-500/10 border border-orange-500/20 px-3 py-2">
            <RotateCcw size={14} className="text-orange-500" />
            <span className="text-[11px] font-semibold text-orange-500">
              Reintento {o.retryCount}/3 — No contestó antes, volver a llamar
            </span>
          </div>
        )}
        {vip?.isVip && !o.result && (
          <div className="flex items-center justify-between gap-2 mb-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2">
            <div className="flex items-center gap-2">
              <Star size={14} className="text-emerald-500 fill-emerald-500" />
              <span className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                CLIENTE VIP — {vip.entregados}/{vip.total} entregados ({vip.efectividad}%)
              </span>
            </div>
            <button
              onClick={() => handleMark('conf')}
              className="text-[10px] font-bold px-2.5 py-1 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors whitespace-nowrap"
            >
              Confirmar sin llamar
            </button>
          </div>
        )}
        {!o.result && <div className="mb-3"><FingerprintBadge phone={o.phone} /></div>}
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <div className={`w-2 h-2 rounded-full ${pDot}`} />
          <span className={`text-xs font-bold ${pColor}`}>D{o.dias}</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted font-semibold">{o.estado}</span>
        </div>

        <div className="text-xl font-bold mb-1">{o.nombre}</div>

        <div className="text-sm text-muted-foreground mb-4 leading-relaxed space-y-1">
          <div className="flex items-center gap-1.5">
            <Phone size={12} /> <button onClick={copyPhone} className="text-cyan hover:underline">{formatPhone(o.phone)}</button>
            <span className="mx-2" />
            <MapPin size={12} /> {o.ciudad || '—'}
          </div>
          <div className="flex items-center gap-1.5">
            <Package size={12} /> {o.producto || '—'}
            {o.valor > 0 && <><span className="mx-2" /><DollarSign size={12} /> ${o.valor.toLocaleString()}</>}
          </div>
        </div>

        {o.novedad && (
          <div className={`p-2.5 rounded-lg mb-3 text-xs inline-flex items-start gap-1.5 w-full ${o.novedadSol ? 'bg-green/10 border border-green/20' : 'bg-orange/10 border border-orange/20'}`}>
            {o.novedadSol ? <CheckCircle2 size={12} className="text-green mt-0.5" /> : <AlertTriangle size={12} className="text-orange mt-0.5" />}
            <span>{o.novedadSol ? 'RESUELTA' : 'NOVEDAD'}: {o.novedad}</span>
          </div>
        )}

        {o.guia && (
          <div className="text-xs mb-2 inline-flex items-center gap-1.5">
            <Tag size={12} /> Guía: <a href={getTrackingUrl(o.transportadora, o.guia) || '#'} target="_blank" rel="noreferrer" className="text-cyan">{o.guia}</a>
            {o.transportadora && ` (${o.transportadora})`}
          </div>
        )}

        {o.direccion && (
          <div className="text-xs text-muted-foreground mb-3 inline-flex items-center gap-1.5">
            <Mail size={12} /> {o.direccion}
          </div>
        )}

        {/* AI call script */}
        {!o.result && (() => {
          const scriptKey = `script-${o.phone}-${o.idx}`;
          const ai = getAi(scriptKey);
          const buildContext = () => {
            const parts = [
              `Cliente: ${o.nombre}`,
              `Teléfono: ${o.phone}`,
              `Producto: ${o.producto || 'N/A'}`,
              `Ciudad: ${o.ciudad || 'N/A'}`,
              `Dirección: ${o.direccion || 'N/A'}`,
              `Valor: $${o.valor.toLocaleString()} (incluye flete)`,
              `Días desde pedido: ${o.dias}`,
              `Estado: ${o.estado}`,
            ];
            if (o.novedad) parts.push(`Novedad: ${o.novedad}${o.novedadSol ? ' (RESUELTA)' : ''}`);
            if (vip?.isVip) parts.push(`Cliente VIP: ${vip.entregados}/${vip.total} pedidos entregados (${vip.efectividad}%)`);
            if (o.retryCount) parts.push(`Reintentos previos: ${o.retryCount}/3 (no contestó antes)`);
            if (o.transportadora) parts.push(`Transportadora: ${o.transportadora}`);
            return parts.join('\n');
          };
          return (
            <div className="mb-3">
              {!ai.reply && !ai.loading && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => askAi(scriptKey, 'call_script', buildContext())}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 rounded-lg bg-accent/10 border border-accent/30 text-accent text-xs font-semibold hover:bg-accent hover:text-accent-foreground transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                  >
                    <Sparkles size={13} aria-hidden="true" /> Generar guión IA
                  </button>
                  {o.externalId && (
                    <button
                      type="button"
                      onClick={() => setEditingOrder(o)}
                      title="Editar datos del cliente"
                      aria-label="Editar datos del cliente"
                      className="px-3 py-2.5 rounded-lg bg-primary/10 border border-primary/30 text-primary text-xs font-semibold hover:bg-primary hover:text-primary-foreground transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none inline-flex items-center gap-1.5"
                    >
                      <Pencil size={13} aria-hidden="true" /> Editar
                    </button>
                  )}
                </div>
              )}
              {ai.loading && (
                <div className="flex items-center gap-2 py-2.5 px-3 rounded-lg bg-accent/5 border border-accent/20 text-xs text-accent">
                  <RefreshCw size={12} className="animate-spin" aria-hidden="true" /> Generando guión...
                </div>
              )}
              {ai.reply && (
                <div className="p-3 rounded-lg bg-accent/5 border border-accent/25 text-xs text-foreground whitespace-pre-line leading-relaxed">
                  <div className="flex items-center gap-1.5 text-accent font-semibold mb-1.5">
                    <Sparkles size={11} aria-hidden="true" /> Guión sugerido
                  </div>
                  {ai.reply}
                </div>
              )}
              {ai.error && (
                <div className="text-[10px] text-red-500 mt-1">IA no disponible: {ai.error}</div>
              )}
            </div>
          );
        })()}

        {!o.result ? (
          <div className="grid grid-cols-3 gap-2 mt-4">
            <button onClick={() => handleMark('conf')} className="inline-flex items-center justify-center gap-1.5 py-3.5 rounded-xl bg-green/15 text-green border border-green/25 font-bold text-sm active:scale-[0.97] transition-transform">
              <CheckCircle2 size={16} /> Confirmó
            </button>
            <button onClick={() => setShowCancelModal(true)} className="inline-flex items-center justify-center gap-1.5 py-3.5 rounded-xl bg-red/15 text-red border border-red/25 font-bold text-sm active:scale-[0.97] transition-transform">
              <XCircle size={16} /> Canceló
            </button>
            <button onClick={() => handleMark('noresp')} className="inline-flex items-center justify-center gap-1.5 py-3.5 rounded-xl bg-muted text-muted-foreground font-bold text-sm active:scale-[0.97] transition-transform">
              <PhoneOff size={16} /> No contestó
            </button>
          </div>
        ) : (
          <div className="text-center py-3 text-sm font-semibold inline-flex items-center gap-1.5 justify-center w-full">
            {o.result === 'conf' ? <><CheckCircle2 size={16} className="text-green" /> Confirmado</> : o.result === 'canc' ? <><XCircle size={16} className="text-red" /> Cancelado</> : <><PhoneOff size={16} /> No respondió</>}
          </div>
        )}
      </div>

      {showCancelModal && (
        <div className="fixed inset-0 bg-black/70 z-[2000] flex items-end justify-center" onClick={() => setShowCancelModal(false)}>
          <div className="bg-surface rounded-t-2xl p-6 pb-[calc(24px+env(safe-area-inset-bottom))] w-full max-w-[480px] max-h-[80vh] overflow-y-auto animate-slide-up" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold mb-4 inline-flex items-center gap-2">
              <XCircle size={18} className="text-red" /> Motivo de cancelación
            </h3>
            <div className="grid gap-2">
              {CANCEL_REASONS.map(reason => (
                <button key={reason} onClick={() => handleMark('canc', reason)}
                  className="w-full text-left py-3 px-4 rounded-lg bg-muted text-muted-foreground font-semibold text-sm hover:bg-muted/80 transition-colors">
                  {reason}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
