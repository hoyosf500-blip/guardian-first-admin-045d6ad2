import { useState } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { OrderData, formatPhone, getTrackingUrl, truncate } from '@/lib/orderUtils';
import { CANCEL_REASONS } from '@/lib/constants';
import { toast } from 'sonner';
import { CheckCircle2, XCircle, PhoneOff, Phone, MapPin, Package, DollarSign, Tag, AlertTriangle, ChevronLeft, ChevronRight, Mail } from 'lucide-react';

interface Props {
  items: OrderData[];
}

export default function CallView({ items }: Props) {
  const { markResult, undoLast } = useOrders();
  const [callIdx, setCallIdx] = useState(() => {
    const idx = items.findIndex(o => !o.result);
    return idx >= 0 ? idx : 0;
  });
  const [showCancelModal, setShowCancelModal] = useState(false);

  const o = items[Math.min(callIdx, items.length - 1)];

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
          <button onClick={() => navCall(1)} className="px-3 py-1.5 rounded-md bg-muted text-muted-foreground text-xs font-semibold inline-flex items-center">
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div className="bg-gradient-to-b from-card to-surface border border-input rounded-2xl p-5 mb-4">
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
