import { useState, useEffect } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { OrderData, formatPhone, getTrackingUrl, getWhatsAppPhone } from '@/lib/orderUtils';
import { TruncatedText } from '@/components/TruncatedText';
import { useSessionState } from '@/hooks/useSessionState';
import { toast } from 'sonner';
import {
  CheckCircle2,
  AlertTriangle,
  Truck,
  RotateCcw,
  Phone,
  MapPin,
  Package,
  DollarSign,
  Tag,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Send,
  X,
} from 'lucide-react';
import FingerprintBadge from '@/components/FingerprintBadge';

interface Props {
  items: OrderData[];
}

export default function NovedadView({ items }: Props) {
  const { resolveNovedad } = useOrders();
  // Persist callIdx across tab discards (mobile browsers discard bg tabs
  // aggressively when the operator goes to the transportadora page).
  const [callIdx, setCallIdx] = useSessionState<number>('novedades:callIdx', 0);
  const [solution, setSolution] = useState('');
  const [showReturnConfirm, setShowReturnConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Clamp the restored index in case the queue shrunk while away.
  useEffect(() => {
    if (items.length && callIdx >= items.length) {
      setCallIdx(Math.max(0, items.length - 1));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  const o = items[Math.min(callIdx, items.length - 1)];

  // Reset local state when the current order changes
  useEffect(() => {
    setSolution('');
    setShowReturnConfirm(false);
    setSubmitting(false);
  }, [o?.dbId]);

  if (!items.length || !o) {
    return (
      <div className="text-center py-10 text-muted-foreground">
        <CheckCircle2 size={40} className="mx-auto mb-3 text-green" />
        <p className="text-sm font-semibold text-foreground">No hay novedades pendientes</p>
        <p className="text-xs mt-1">Todas las novedades están resueltas 🎉</p>
      </div>
    );
  }

  const pColor = o.dias >= 7 ? 'text-red' : o.dias >= 4 ? 'text-yellow' : 'text-green';
  const pDot = o.dias >= 7 ? 'bg-red' : o.dias >= 4 ? 'bg-yellow' : 'bg-green';
  const isResolving = o.result === 'resolving';

  const copyPhone = () => {
    navigator.clipboard.writeText(o.phone).then(() => toast.success(`${o.phone} copiado`));
  };

  const navCall = (dir: number) => {
    setCallIdx(Math.max(0, Math.min(items.length - 1, callIdx + dir)));
  };

  const handleReoffer = async () => {
    if (!solution.trim()) {
      toast.error('Escribí la solución antes de continuar');
      return;
    }
    setSubmitting(true);
    try {
      await resolveNovedad(o, 'reoffer', solution);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReturnConfirm = async () => {
    setShowReturnConfirm(false);
    setSubmitting(true);
    try {
      await resolveNovedad(o, 'return');
    } finally {
      setSubmitting(false);
    }
  };

  const trackUrl = o.guia ? getTrackingUrl(o.transportadora, o.guia) : null;
  const waMsg = encodeURIComponent(
    `Hola ${o.nombre.split(' ')[0]}, te escribo sobre tu pedido${o.guia ? ` (guía ${o.guia})` : ''}. Necesitamos coordinar la entrega.`,
  );

  return (
    <>
      <div className="flex justify-between items-center mb-2">
        <span className="text-xs text-muted-foreground">{callIdx + 1} / {items.length}</span>
        <div className="flex gap-1.5">
          <button
            onClick={() => navCall(-1)}
            disabled={callIdx <= 0 || submitting}
            className="px-3 py-1.5 rounded-md bg-muted text-muted-foreground text-xs font-semibold disabled:opacity-30 inline-flex items-center"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            onClick={() => navCall(1)}
            disabled={submitting}
            className="px-3 py-1.5 rounded-md bg-muted text-muted-foreground text-xs font-semibold disabled:opacity-30 inline-flex items-center"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div className="bg-gradient-to-b from-card to-surface border border-input rounded-2xl p-5 mb-4">
        {/* Header: badges */}
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <div className={`w-2 h-2 rounded-full ${pDot}`} />
          <span className={`text-xs font-bold ${pColor}`}>D{o.dias}</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted font-semibold">{o.estado}</span>
          {o.transportadora && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan/10 text-cyan border border-cyan/20 font-semibold">
              <Truck size={10} className="inline mr-1" />
              {o.transportadora}
            </span>
          )}
        </div>

        {/* Dropi fingerprint */}
        <div className="mb-3"><FingerprintBadge phone={o.phone} /></div>

        {/* Customer name */}
        <div className="text-xl font-bold mb-1">{o.nombre}</div>

        {/* Contact + location line */}
        <div className="text-sm text-muted-foreground mb-3 leading-relaxed space-y-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Phone size={12} />
            <button onClick={copyPhone} className="text-cyan hover:underline">{formatPhone(o.phone)}</button>
            <a
              href={`tel:${o.phone}`}
              className="ml-1 inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-blue/10 text-blue border border-blue/20 hover:bg-blue/20 no-underline"
            >
              <Phone size={10} /> Llamar
            </a>
            <a
              href={`https://wa.me/${getWhatsAppPhone(o.phone)}?text=${waMsg}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-green/10 text-green border border-green/20 hover:bg-green/20 no-underline"
            >
              <MessageSquare size={10} /> WhatsApp
            </a>
          </div>
          <div className="flex items-center gap-1.5">
            <MapPin size={12} /> {o.ciudad || '—'}{o.departamento ? `, ${o.departamento}` : ''}
          </div>
          <div className="flex items-start gap-1.5">
            <Package size={12} className="mt-0.5" />
            <span className="flex-1">{o.producto || '—'}{o.cantidad > 1 ? ` × ${o.cantidad}` : ''}</span>
            {o.valor > 0 && (
              <span className="inline-flex items-center gap-1 text-foreground">
                <DollarSign size={12} />${o.valor.toLocaleString()}
              </span>
            )}
          </div>
          {o.direccion && (
            <div className="flex items-start gap-1.5 text-xs">
              <MapPin size={12} className="mt-0.5 text-muted-foreground/60" />
              <span className="flex-1 text-muted-foreground">{o.direccion}</span>
            </div>
          )}
          {o.guia && (
            <div className="text-xs inline-flex items-center gap-1.5">
              <Tag size={12} /> Guía:{' '}
              <a
                href={trackUrl || '#'}
                target="_blank"
                rel="noreferrer"
                className="text-cyan hover:underline"
              >
                {o.guia}
              </a>
            </div>
          )}
        </div>

        {/* Novedad banner */}
        {o.novedad && (
          <div className="p-3 rounded-xl mb-4 text-xs bg-orange-500/10 border border-orange-500/20 flex items-start gap-2">
            <AlertTriangle size={14} className="text-orange-500 mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <div className="text-[10px] font-bold text-orange-600 dark:text-orange-400 uppercase tracking-wide mb-0.5">
                Novedad de {o.transportadora || 'transportadora'}
              </div>
              <div className="text-foreground leading-relaxed">{o.novedad}</div>
            </div>
          </div>
        )}

        {/* Resolving feedback */}
        {isResolving ? (
          <div className="text-center py-4 text-sm font-semibold inline-flex items-center gap-2 justify-center w-full text-green">
            <CheckCircle2 size={18} className="text-green" />
            Resuelta — avanzando a la siguiente...
          </div>
        ) : (
          <>
            {/* Solution textarea */}
            <div className="mb-4">
              <label className="block text-[10px] font-bold text-muted-foreground uppercase tracking-wide mb-1.5">
                Solución que diste al cliente
              </label>
              <textarea
                value={solution}
                onChange={(e) => setSolution(e.target.value.slice(0, 500))}
                placeholder="Ej: Cliente confirma estar en casa mañana entre 2-5pm. Barrio correcto: Chapinero."
                rows={3}
                disabled={submitting}
                className="w-full rounded-xl bg-muted/50 border border-border p-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none disabled:opacity-60"
              />
              <div className="flex justify-end mt-1">
                <span className={`text-[10px] ${solution.length > 450 ? 'text-orange-500' : 'text-muted-foreground'}`}>
                  {solution.length}/500
                </span>
              </div>
            </div>

            {/* Action buttons */}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={handleReoffer}
                disabled={!solution.trim() || submitting}
                className="inline-flex items-center justify-center gap-1.5 py-3.5 rounded-xl bg-green/15 text-green border border-green/25 font-bold text-sm active:scale-[0.97] transition-transform disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
              >
                <RotateCcw size={16} /> Volver a ofrecer
              </button>
              <button
                onClick={() => setShowReturnConfirm(true)}
                disabled={submitting}
                className="inline-flex items-center justify-center gap-1.5 py-3.5 rounded-xl bg-red/15 text-red border border-red/25 font-bold text-sm active:scale-[0.97] transition-transform disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
              >
                <Truck size={16} /> Devolver
              </button>
            </div>
          </>
        )}
      </div>

      {/* Confirm modal for "Devolver al remitente" */}
      {showReturnConfirm && (
        <div
          className="fixed inset-0 bg-black/70 z-[2000] flex items-end justify-center"
          onClick={() => setShowReturnConfirm(false)}
        >
          <div
            className="bg-surface rounded-t-2xl p-6 pb-[calc(24px+env(safe-area-inset-bottom))] w-full max-w-[480px] animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-red/15 flex items-center justify-center flex-shrink-0">
                <Truck size={18} className="text-red" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-bold text-foreground">Devolver al remitente</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  La orden de <strong>{o.nombre}</strong> se reportará a Dropi como "DEVOLVER AL REMITENTE" y será regresada. Esta acción no se puede deshacer.
                </p>
                {solution.trim() && (
                  <div className="mt-3 p-2.5 rounded-lg bg-yellow/10 border border-yellow/20 text-[11px] text-yellow-700 dark:text-yellow-400">
                    <strong>Aviso:</strong> escribiste una solución (<em>"<TruncatedText text={solution} maxChars={60} />"</em>) que se va a descartar si devuelves.
                  </div>
                )}
              </div>
              <button
                onClick={() => setShowReturnConfirm(false)}
                className="text-muted-foreground hover:text-foreground p-1"
              >
                <X size={18} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <button
                onClick={() => setShowReturnConfirm(false)}
                className="py-3 rounded-xl bg-muted text-muted-foreground font-semibold text-sm hover:bg-muted/80"
              >
                Cancelar
              </button>
              <button
                onClick={handleReturnConfirm}
                className="py-3 rounded-xl bg-red/15 text-red border border-red/25 font-bold text-sm active:scale-[0.97]"
              >
                <Send size={14} className="inline mr-1" /> Sí, devolver
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
