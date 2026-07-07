import { useState, useEffect } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { useWaChat } from '@/contexts/WaChatContext';
import { useStore } from '@/contexts/StoreContext';
import { OrderData, formatPhone, getTrackingUrl, getWhatsAppPhone } from '@/lib/orderUtils';
import { formatCOP } from '@/lib/utils';
import { TruncatedText } from '@/components/TruncatedText';
import { useSessionState } from '@/hooks/useSessionState';
import { copyToClipboard } from '@/lib/clipboard';
import { useMarkNovedadResolved } from '@/hooks/useMarkNovedadResolved';
import { NovedadResultTipo } from '@/lib/novedadGestion';
import {
  CheckCircle2,
  AlertTriangle,
  Truck,
  PhoneOff,
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
  User,
} from 'lucide-react';
import FingerprintBadge from '@/components/FingerprintBadge';

interface Props {
  items: OrderData[];
  /** Key de sessionStorage para la posición del carrusel. Cada instancia
   *  simultánea (Por gestionar / Esperando transportadora) necesita la SUYA:
   *  con la key compartida, el re-seed de una instancia pisaba la posición
   *  de la otra y la operadora perdía su lugar en la cola de llamadas. */
  stateKey?: string;
}

export default function NovedadView({ items, stateKey = 'novedades:callOrderId' }: Props) {
  const { loadNovedades } = useOrders();
  const { markNovedad } = useMarkNovedadResolved();
  const { openChat, waEnabled } = useWaChat();
  const { activeStore } = useStore();
  const countryCode = activeStore?.country_code;
  // BUG B fix: persist by *order id*, not array index. When the queue
  // reorders or the operator returns from the carrier tab we keep showing
  // the same customer instead of jumping to a random one at that index.
  const [callOrderId, setCallOrderId] = useSessionState<string | null>(
    stateKey,
    null,
  );
  const [solution, setSolution] = useState('');
  const [showReturnConfirm, setShowReturnConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Descarte local: cuando marco resuelta/devolución la card desaparece al
  // instante (sin tocar OrderContext); `loadNovedades(true)` reconcilia luego.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  const keyOf = (it: OrderData) => it.externalId || it.dbId || it.phone;

  const visibleItems = items.filter((it) => !dismissed.has(keyOf(it)));

  // Derive index from the stored id every render.
  let derivedIdx = callOrderId ? visibleItems.findIndex((it) => keyOf(it) === callOrderId) : -1;
  if (derivedIdx < 0) derivedIdx = 0;

  // Only re-seed when the stored customer is gone (or never set).
  useEffect(() => {
    if (!visibleItems.length) return;
    const exists = callOrderId && visibleItems.some((it) => keyOf(it) === callOrderId);
    if (!exists) {
      const k = visibleItems[0] ? keyOf(visibleItems[0]) : null;
      if (k && k !== callOrderId) setCallOrderId(k);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callOrderId, visibleItems]);

  const callIdx = Math.max(0, Math.min(derivedIdx, visibleItems.length - 1));
  const o = visibleItems[callIdx];

  // Reset local state when the current order changes
  useEffect(() => {
    setSolution('');
    setShowReturnConfirm(false);
    setSubmitting(false);
  }, [o?.dbId]);

  if (!visibleItems.length || !o) {
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

  const copyPhone = () => {
    void copyToClipboard(o.phone, `${o.phone} copiado`);
  };

  const navCall = (dir: number) => {
    const target = visibleItems[Math.max(0, Math.min(visibleItems.length - 1, callIdx + dir))];
    if (target) setCallOrderId(keyOf(target));
  };

  // Marca local de gestión (no empuja a Dropi — ella ya resolvió allá).
  //  - resuelta/devolución: descarta la card y reconcilia.
  //  - sin respuesta: registra el intento y avanza (la novedad sigue en cola).
  const doMark = async (tipo: NovedadResultTipo) => {
    if (!o || submitting) return;
    setSubmitting(true);
    try {
      const ok = await markNovedad(o, tipo, tipo === 'resuelta' ? solution : undefined);
      if (!ok) return;
      if (tipo === 'sin_respuesta') {
        navCall(1);
      } else {
        const k = keyOf(o);
        setDismissed((prev) => new Set(prev).add(k));
        void loadNovedades(true);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleDevolucionConfirm = async () => {
    setShowReturnConfirm(false);
    await doMark('devolucion');
  };

  const trackUrl = o.guia ? getTrackingUrl(o.transportadora, o.guia) : null;

  return (
    <>
      {/* Persistent "currently attending" banner — survives tab switches */}
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs">
        <User size={12} className="text-primary" />
        <span className="text-muted-foreground">Atendiendo:</span>
        <span className="font-semibold text-foreground truncate">{o.nombre}</span>
        <span className="text-muted-foreground">·</span>
        <span className="font-mono text-foreground">{formatPhone(o.phone)}</span>
      </div>
      <div className="flex justify-between items-center mb-2">
        <span className="text-xs text-muted-foreground">{callIdx + 1} / {visibleItems.length}</span>
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
              href={'tel:+' + getWhatsAppPhone(o.phone, countryCode)}
              className="ml-1 inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-blue/10 text-blue border border-blue/20 hover:bg-blue/20 no-underline"
            >
              <Phone size={10} /> Llamar
            </a>
            {waEnabled && (
              <button
                type="button"
                onClick={() => void openChat({ phone: o.phone, name: o.nombre })}
                className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-[#25D366]/10 text-emerald-600 dark:text-emerald-400 border border-[#25D366]/25 hover:bg-[#25D366]/20 transition-colors"
              >
                <MessageSquare size={10} /> WhatsApp
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <MapPin size={12} /> {o.ciudad || '—'}{o.departamento ? `, ${o.departamento}` : ''}
          </div>
          <div className="flex items-start gap-1.5">
            <Package size={12} className="mt-0.5" />
            <span className="flex-1">{o.producto || '—'}{o.cantidad > 1 ? ` × ${o.cantidad}` : ''}</span>
            {o.valor > 0 && (
              <span className="inline-flex items-center gap-1 text-foreground">
                <DollarSign size={12} />{formatCOP(o.valor)}
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

        {/* Gestión: marca local (la colaboradora ya resolvió en Dropi). */}
        {submitting ? (
          <div className="text-center py-4 text-sm font-semibold inline-flex items-center gap-2 justify-center w-full text-green">
            <CheckCircle2 size={18} className="text-green animate-pulse" />
            Marcando…
          </div>
        ) : (
          <>
            {/* Nota opcional (solo aplica a "Resuelta") */}
            <div className="mb-4">
              <label className="block text-[10px] font-bold text-muted-foreground uppercase tracking-wide mb-1.5">
                Nota de la gestión <span className="text-muted-foreground/60 normal-case font-normal">(opcional)</span>
              </label>
              <textarea
                value={solution}
                onChange={(e) => setSolution(e.target.value.slice(0, 500))}
                placeholder="Ej: Cliente confirma estar en casa mañana entre 2-5pm. Barrio correcto: Chapinero."
                rows={2}
                disabled={submitting}
                className="w-full rounded-xl bg-muted/50 border border-border p-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none disabled:opacity-60"
              />
              <div className="flex justify-end mt-1">
                <span className={`text-[10px] ${solution.length > 450 ? 'text-orange-500' : 'text-muted-foreground'}`}>
                  {solution.length}/500
                </span>
              </div>
            </div>

            {/* 3 resultados: Resuelta / Devolución / Sin respuesta */}
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => doMark('resuelta')}
                disabled={submitting}
                className="inline-flex flex-col items-center justify-center gap-1 py-3 rounded-xl bg-green/15 text-green border border-green/25 font-bold text-xs active:scale-[0.97] transition-transform disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
              >
                <CheckCircle2 size={16} /> Resuelta
              </button>
              <button
                onClick={() => setShowReturnConfirm(true)}
                disabled={submitting}
                className="inline-flex flex-col items-center justify-center gap-1 py-3 rounded-xl bg-red/15 text-red border border-red/25 font-bold text-xs active:scale-[0.97] transition-transform disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
              >
                <Truck size={16} /> Devolución
              </button>
              <button
                onClick={() => doMark('sin_respuesta')}
                disabled={submitting}
                className="inline-flex flex-col items-center justify-center gap-1 py-3 rounded-xl bg-yellow/15 text-yellow border border-yellow/25 font-bold text-xs active:scale-[0.97] transition-transform disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
              >
                <PhoneOff size={16} /> Sin respuesta
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2 text-center">
              "Sin respuesta" deja la novedad en la cola para reintentar.
            </p>
          </>
        )}
      </div>

      {/* Confirm modal para "Devolución" */}
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
                <h3 className="text-base font-bold text-foreground">Marcar como devolución</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  La novedad de <strong>{o.nombre}</strong> se marcará como <strong>devolución</strong> y saldrá de la cola. Asegurate de haberla gestionado en Dropi.
                </p>
                {solution.trim() && (
                  <div className="mt-3 p-2.5 rounded-lg bg-yellow/10 border border-yellow/20 text-[11px] text-yellow-700 dark:text-yellow-400">
                    <strong>Aviso:</strong> la nota que escribiste (<em>"<TruncatedText text={solution} maxChars={60} />"</em>) no se guarda en una devolución.
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
                onClick={handleDevolucionConfirm}
                className="py-3 rounded-xl bg-red/15 text-red border border-red/25 font-bold text-sm active:scale-[0.97]"
              >
                <Send size={14} className="inline mr-1" /> Sí, devolución
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
