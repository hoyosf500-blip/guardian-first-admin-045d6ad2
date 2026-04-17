import { useState, useEffect } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { useAuth } from '@/contexts/AuthContext';
import { useOrderLock } from '@/hooks/useOrderLock';
import { OrderData, formatPhone, getTrackingUrl, truncate, dbToOrderData } from '@/lib/orderUtils';
import { CANCEL_REASONS } from '@/lib/constants';
import { useSessionState } from '@/hooks/useSessionState';
// AI script generator removed — operadoras no lo usaban
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { CheckCircle2, XCircle, PhoneOff, Phone, MapPin, Package, DollarSign, Tag, AlertTriangle, ChevronLeft, ChevronRight, Mail, RotateCcw, Star, Lock, UserCog } from 'lucide-react';
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
  const { markResult, undoLast, allOrders, setAllOrders, buildWorkQueue } = useOrders();
  const { user } = useAuth();
  const { claimOrder, releaseOrder } = useOrderLock();
  // BUG B fix: persist the customer's stable identifier (externalId or dbId),
  // not the array index. Indexes break when items reorder due to refresh/sync.
  const [callOrderId, setCallOrderId] = useSessionState<string | null>(
    'confirmar:callOrderId',
    null,
  );

  const orderKey = (o: OrderData | undefined) =>
    o ? (o.externalId || o.dbId || null) : null;

  // Compute the real index from the persisted ID. If the customer is gone from
  // the queue (-1), fall back to the first pending order.
  let callIdx = callOrderId
    ? items.findIndex(o => (o.externalId || o.dbId) === callOrderId)
    : -1;
  if (callIdx < 0) {
    const firstPending = items.findIndex(o => !o.result);
    callIdx = firstPending >= 0 ? firstPending : 0;
  }

  // Re-anchor the persisted ID only when missing or stale. Never trigger on
  // items.length alone — that was causing the operator to lose their customer.
  useEffect(() => {
    if (!items.length) return;
    const exists = callOrderId
      ? items.some(o => (o.externalId || o.dbId) === callOrderId)
      : false;
    if (!exists) {
      const firstPending = items.find(o => !o.result) || items[0];
      const k = orderKey(firstPending);
      if (k && k !== callOrderId) setCallOrderId(k);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callOrderId, items]);

  const [showCancelModal, setShowCancelModal] = useState(false);
  const [editingOrder, setEditingOrder] = useState<OrderData | null>(null);
  const [vip, setVip] = useState<VipInfo | null>(null);

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
  // BUG 3 fix: NO liberar el lock en cleanup. Cambiar de pestaña desmonta
  // CallView y soltaba el lock — otra operadora lo tomaba y al volver Mayra
  // perdía el cliente. El lock se libera al marcar el pedido (markResult)
  // o automáticamente por el cron release-stale-locks tras 15 min.
  useEffect(() => {
    if (!o?.dbId || !user || o.result) return;
    const orderId = o.dbId;
    let cancelled = false;
    claimOrder(orderId).then(claimed => {
      if (cancelled) return;
      if (!claimed) {
        const next = items.find((it, i) => i > callIdx && !it.result);
        const k = orderKey(next);
        if (k) {
          setCallOrderId(k);
          toast.info('Pedido en uso por otra operadora — saltando al siguiente');
        } else {
          toast.info('Pedidos disponibles agotados — todos están en atención');
        }
      }
    });
    return () => { cancelled = true; };
  }, [o?.dbId, user, claimOrder, callIdx, items, setCallOrderId, o?.result]);

  // Best-effort release on tab close so locks no quedan huérfanos hasta el cron.
  useEffect(() => {
    const handler = () => {
      if (o?.dbId) void releaseOrder(o.dbId);
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [o?.dbId, releaseOrder]);

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
    if (o.dbId) void releaseOrder(o.dbId);
    setShowCancelModal(false);
    toast.success(
      result === 'conf' ? `Confirmado — ${o.nombre.split(' ')[0]}` :
      result === 'canc' ? `Cancelado — ${o.nombre.split(' ')[0]}` :
      `No respondió — ${o.nombre.split(' ')[0]}`,
    );
    setTimeout(() => {
      const next = items.find((item, i) => i > callIdx && !item.result);
      const k = orderKey(next);
      if (k) setCallOrderId(k);
    }, 400);
  };

  const navCall = (dir: number) => {
    const target = Math.max(0, Math.min(items.length - 1, callIdx + dir));
    const k = orderKey(items[target]);
    if (k) setCallOrderId(k);
  };

  const copyPhone = () => {
    navigator.clipboard.writeText(o.phone).then(() => toast.success(`${o.phone} copiado`));
  };

  return (
    <>
      {!o.result && (
        <div className="mb-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-xs font-semibold text-primary">
          <Phone size={12} />
          Atendiendo: {o.nombre} · {formatPhone(o.phone)}
        </div>
      )}
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

        {/* Edit order button (AI script generator removed — unused) */}
        {!o.result && o.externalId && (
          <div className="mb-3">
            <button
              type="button"
              onClick={() => setEditingOrder(o)}
              title="Editar datos del cliente"
              aria-label="Editar datos del cliente"
              className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-500 text-xs font-semibold hover:bg-emerald-500/20 hover:border-emerald-500/40 transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none"
            >
              <UserCog size={14} aria-hidden="true" /> Editar datos del cliente
            </button>
          </div>
        )}

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

      {editingOrder && (
        <EditOrderDialog
          open={!!editingOrder}
          onOpenChange={(op) => { if (!op) setEditingOrder(null); }}
          order={editingOrder}
          onSuccess={async () => {
            // BUG 4 fix: re-fetch del pedido editado para refrescar pantalla.
            if (!editingOrder?.dbId) return;
            const { data } = await supabase.from('orders').select('*').eq('id', editingOrder.dbId).maybeSingle();
            if (data) {
              const updated = dbToOrderData(data, 0);
              const merged = allOrders.map(ord => ord.dbId === updated.dbId
                ? { ...ord, ...updated, result: ord.result, reason: ord.reason, retryCount: ord.retryCount }
                : ord);
              setAllOrders(merged);
              buildWorkQueue(merged);
            }
          }}
        />
      )}
    </>
  );
}
