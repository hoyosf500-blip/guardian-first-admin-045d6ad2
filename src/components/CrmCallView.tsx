import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft, ChevronRight, Phone as PhoneIcon, MessageSquare,
  Copy, MapPin, Package, DollarSign, Tag, Truck, AlertTriangle,
  CheckCircle, ExternalLink, User, Clock, Send,
} from 'lucide-react';
import { toast } from 'sonner';
import { OrderData, formatPhone, getTrackingUrl, getWhatsAppPhone } from '@/lib/orderUtils';
import { getAlertLevel } from '@/lib/alertSystem';
import FingerprintBadge from '@/components/FingerprintBadge';
import { TruncatedText } from '@/components/TruncatedText';
import { useSessionState } from '@/hooks/useSessionState';

interface Touchpoint {
  id: string;
  phone: string;
  action: string;
  action_date: string;
  action_time: string | null;
  operator_id: string;
  created_at: string;
}

interface Props {
  items: OrderData[];
  actions: string[];
  managed: Record<string, string>;
  phoneTouchpoints: Record<string, Touchpoint[]>;
  getOperatorName: (id: string) => string;
  onAction: (order: OrderData, action: string) => void;
  /** Unique key for sessionStorage (e.g. "seg" or "rescue"). */
  storageKey: string;
  module: string;
}

function getOrderStatusAgeDays(order: OrderData): number {
  // Keep in sync with CrmTable.getOrderStatusAgeDays
  const baseDate = (order.fechaConf || order.fecha || '').trim();
  if (baseDate && baseDate !== 'undefined') {
    // We don't re-import calcBusinessDays here; use calendar days as fallback.
    // The caller (CrmTable) already sorts by this, so ordering is consistent.
    const parts = baseDate.includes('/') ? baseDate.split('/') : null;
    if (parts && parts.length === 3) {
      const d = new Date(`${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}T00:00:00`);
      const diff = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
      return Math.max(0, Math.round(diff * 5 / 7));
    }
  }
  return Math.round((order.diasConf || order.dias || 0) * 5 / 7);
}

function isExcludedFromDelay(estado: string): boolean {
  const e = estado.toUpperCase();
  return e === 'ENTREGADO' || e.includes('DEVOL') || e === 'CANCELADO' || e === 'RECHAZADO';
}

/**
 * Call-center style view for Seguimiento / Rescate: shows one order at a
 * time with full detail and quick action buttons, the same ergonomics as
 * the Confirmar tab's Llamar view. Especially useful when filtering by a
 * status like "Reclame en oficina" — instead of scrolling through a column
 * the operator works the list one order at a time.
 */
export default function CrmCallView({
  items, actions, managed, phoneTouchpoints, getOperatorName, onAction, storageKey, module,
}: Props) {
  // BUG B fix: persist the *order id* of the customer being attended, not
  // the array index. When `items` reorders (refresh, sync, filter change)
  // the index points to a different customer; the id stays stable.
  const [callOrderId, setCallOrderId] = useSessionState<string | null>(
    `crmcall:${storageKey}:callOrderId`,
    null,
  );

  const keyOf = (it: OrderData) => it.externalId || it.dbId || it.phone;

  // Derive the index from the stored id every render.
  let derivedIdx = callOrderId ? items.findIndex((it) => keyOf(it) === callOrderId) : -1;
  if (derivedIdx < 0) {
    const firstUnmanaged = items.findIndex((it) => !managed[it.phone]);
    derivedIdx = firstUnmanaged >= 0 ? firstUnmanaged : 0;
  }

  // Only re-seed when the stored customer is gone (or never set).
  useEffect(() => {
    if (!items.length) return;
    const exists = callOrderId && items.some((it) => keyOf(it) === callOrderId);
    if (!exists) {
      const firstUnmanaged = items.findIndex((it) => !managed[it.phone]);
      const target = items[firstUnmanaged >= 0 ? firstUnmanaged : 0];
      const k = target ? keyOf(target) : null;
      if (k && k !== callOrderId) setCallOrderId(k);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callOrderId, items]);

  if (!items.length) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/40 px-6 py-16 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10">
          <CheckCircle size={20} className="text-emerald-500" />
        </div>
        <h3 className="text-base font-semibold text-foreground">Nada para gestionar</h3>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          No hay pedidos en este filtro. Cambia el filtro o vuelve a la vista Lista.
        </p>
      </div>
    );
  }

  const idx = Math.max(0, Math.min(derivedIdx, items.length - 1));
  const o = items[idx];
  const diasEnEstatus = getOrderStatusAgeDays(o);
  const alert = getAlertLevel(diasEnEstatus, o.dias, o.estado, o.transportadora, o.novedad);
  const trackUrl = getTrackingUrl(o.transportadora, o.guia);
  const currentManaged = managed[o.phone];
  const tps = phoneTouchpoints[o.phone] || [];
  const isDelayed = diasEnEstatus >= 2 && !isExcludedFromDelay(o.estado);

  const waMsg = encodeURIComponent(
    `Hola ${o.nombre.split(' ')[0]}, te escribo sobre tu pedido${o.guia ? ` (guía ${o.guia})` : ''}. Necesitamos coordinar la entrega.`,
  );

  const goTo = (i: number) => {
    const target = items[Math.max(0, Math.min(items.length - 1, i))];
    if (target) setCallOrderId(keyOf(target));
  };

  const navCall = (dir: number) => goTo(idx + dir);

  const jumpToFirstUnmanaged = () => {
    const next = items.findIndex((it, i) => i > idx && !managed[it.phone]);
    if (next >= 0) goTo(next);
    else toast.success('Todos los pedidos de la lista están gestionados');
  };

  const handleAction = async (action: string) => {
    onAction(o, action);
    // Jump to next unmanaged after a short delay so the UI can show feedback
    setTimeout(jumpToFirstUnmanaged, 450);
  };

  const copyPhone = () => {
    navigator.clipboard.writeText(o.phone).then(() => toast.success(`${o.phone} copiado`));
  };
  const copyGuia = () => {
    if (!o.guia) return;
    navigator.clipboard.writeText(o.guia).then(() => toast.success('Guía copiada'));
  };

  const pColor = diasEnEstatus >= 5 ? 'text-red-500' : diasEnEstatus >= 3 ? 'text-amber-500' : diasEnEstatus >= 2 ? 'text-orange-400' : 'text-green-500';
  const pDot = diasEnEstatus >= 5 ? 'bg-red-500' : diasEnEstatus >= 3 ? 'bg-amber-500' : diasEnEstatus >= 2 ? 'bg-orange-400' : 'bg-green-500';

  return (
    <div>
      {/* Persistent "currently attending" banner — survives tab switches */}
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs">
        <User size={12} className="text-primary" />
        <span className="text-muted-foreground">Atendiendo:</span>
        <span className="font-semibold text-foreground truncate">{o.nombre}</span>
        <span className="text-muted-foreground">·</span>
        <span className="font-mono text-foreground">{formatPhone(o.phone)}</span>
      </div>
      {/* Nav header */}
      <div className="flex justify-between items-center mb-2">
        <span className="text-xs text-muted-foreground font-mono">{idx + 1} / {items.length}</span>
        <div className="flex gap-1.5">
          <button
            onClick={() => navCall(-1)}
            disabled={idx <= 0}
            className="px-3 py-1.5 rounded-md bg-card border border-border text-muted-foreground text-xs font-semibold disabled:opacity-30 inline-flex items-center hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <button
            onClick={() => navCall(1)}
            disabled={idx >= items.length - 1}
            className="px-3 py-1.5 rounded-md bg-card border border-border text-muted-foreground text-xs font-semibold disabled:opacity-30 inline-flex items-center hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={o.phone + '-' + idx}
          initial={{ opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -12 }}
          transition={{ duration: 0.2 }}
          className="bg-surface border border-border rounded-xl p-5 mb-4 hover:border-border-strong transition-colors duration-200"
        >
          {/* Header: badges */}
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <div className={`w-2 h-2 rounded-full ${pDot}`} />
            <span className={`text-xs font-bold ${pColor}`}>
              {diasEnEstatus}d sin movimiento
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted font-semibold uppercase tracking-wide">
              {o.estado}
            </span>
            {o.transportadora && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-500 border border-cyan-500/20 font-semibold inline-flex items-center gap-1">
                <Truck size={10} />
                {o.transportadora}
              </span>
            )}
            {alert && alert.level !== 'ok' && alert.level !== 'watch' && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                alert.level === 'lost' ? 'bg-muted text-muted-foreground' :
                alert.level === 'critical' ? 'bg-red-500/10 text-red-500 border border-red-500/20' :
                'bg-orange-500/10 text-orange-500 border border-orange-500/20'
              }`}>
                {alert.label}
              </span>
            )}
          </div>

          {/* Dropi fingerprint */}
          <div className="mb-3"><FingerprintBadge phone={o.phone} /></div>

          {/* Customer name + external ID */}
          <div className="text-xl font-bold mb-1 text-foreground">{o.nombre}</div>
          {o.externalId && (
            <a
              href={`/pedido/${o.externalId}`}
              className="inline-block text-[10px] font-mono text-primary hover:underline mb-3"
            >
              #{o.externalId}
            </a>
          )}

          {/* Contact row */}
          <div className="text-sm text-muted-foreground mb-3 leading-relaxed space-y-1.5">
            <div className="flex items-center gap-1.5 flex-wrap">
              <PhoneIcon size={12} />
              <button onClick={copyPhone} className="text-cyan-500 hover:underline font-mono">
                {formatPhone(o.phone)}
              </button>
              <button
                onClick={copyPhone}
                className="p-1 rounded text-muted-foreground/70 hover:text-foreground"
                title="Copiar teléfono"
              >
                <Copy size={10} />
              </button>
              <a
                href={`tel:+57${o.phone}`}
                className="ml-1 inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/25 hover:bg-accent/25 no-underline transition-colors duration-200"
              >
                <PhoneIcon size={10} aria-hidden="true" /> Llamar
              </a>
              <a
                href={`https://wa.me/${getWhatsAppPhone(o.phone)}?text=${waMsg}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 hover:bg-emerald-500/20 no-underline"
              >
                <MessageSquare size={10} /> WhatsApp
              </a>
            </div>

            {(o.ciudad || o.departamento) && (
              <div className="flex items-center gap-1.5">
                <MapPin size={12} />
                <span>{o.ciudad || '—'}{o.departamento ? `, ${o.departamento}` : ''}</span>
              </div>
            )}

            <div className="flex items-start gap-1.5">
              <Package size={12} className="mt-0.5" />
              <span className="flex-1">
                {o.producto || '—'}{o.cantidad > 1 ? ` × ${o.cantidad}` : ''}
              </span>
              {o.valor > 0 && (
                <span className="inline-flex items-center gap-1 text-foreground font-semibold">
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
              <div className="flex items-center gap-2 mt-1">
                <div className="flex items-center gap-1.5 bg-secondary/50 rounded-lg px-2 py-1 font-mono text-[10px] text-muted-foreground">
                  <Tag size={10} className="text-muted-foreground/60" />
                  <span className="truncate">{o.guia}</span>
                  <button onClick={copyGuia} className="hover:text-foreground">
                    <Copy size={9} />
                  </button>
                </div>
                {trackUrl && (
                  <a
                    href={trackUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg bg-orange-500 px-3 py-1 text-[10px] font-bold text-white hover:bg-orange-600 no-underline"
                  >
                    <ExternalLink size={10} /> Rastrear
                  </a>
                )}
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

          {/* Delay warning */}
          {isDelayed && (
            <div className={`mb-4 flex items-center gap-2 rounded-lg px-3 py-2 ${
              diasEnEstatus >= 5 ? 'bg-red-500/10 border border-red-500/20' :
              diasEnEstatus >= 3 ? 'bg-amber-500/10 border border-amber-500/20' :
              'bg-orange-400/10 border border-orange-400/20'
            }`}>
              <Clock size={12} className={diasEnEstatus >= 5 ? 'text-red-500' : diasEnEstatus >= 3 ? 'text-amber-500' : 'text-orange-400'} />
              <span className={`text-[11px] font-semibold ${diasEnEstatus >= 5 ? 'text-red-500' : diasEnEstatus >= 3 ? 'text-amber-500' : 'text-orange-400'}`}>
                {diasEnEstatus}d sin movimiento — {diasEnEstatus >= 5 ? 'Posible pérdida' : diasEnEstatus >= 3 ? 'Llamar + reclamar' : 'Monitorear'}
              </span>
            </div>
          )}

          {/* History */}
          {tps.length > 0 && (
            <div className="mb-4">
              <h4 className="text-[10px] font-semibold text-muted-foreground mb-2 inline-flex items-center gap-1 uppercase tracking-wider">
                <MessageSquare size={10} /> Historial ({tps.length})
              </h4>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {tps.slice(0, 6).map(tp => (
                  <div key={tp.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-card border border-border/20 text-[10px]">
                    <div className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <User size={9} className="text-primary/70" />
                    </div>
                    <span className="font-semibold text-foreground">{getOperatorName(tp.operator_id)}</span>
                    <span className="text-muted-foreground truncate">{tp.action.replace(/^(SEG|RESCUE): ?/, '')}</span>
                    <span className="ml-auto text-muted-foreground/70 flex-shrink-0">
                      {tp.action_time || ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Managed state or action buttons */}
          {currentManaged ? (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-4 py-3">
              <div className="flex items-center gap-2">
                <CheckCircle size={16} className="text-emerald-500" />
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-emerald-600 dark:text-emerald-400 font-bold">Gestionado</div>
                  <div className="text-xs text-foreground font-semibold">{currentManaged}</div>
                </div>
              </div>
              <button
                onClick={() => navCall(1)}
                disabled={idx >= items.length - 1}
                className="px-3 py-1.5 rounded-lg bg-emerald-500 text-white text-[11px] font-semibold disabled:opacity-40 inline-flex items-center gap-1"
              >
                Siguiente <ChevronRight size={12} />
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {actions.map(a => (
                <button
                  key={a}
                  onClick={() => handleAction(a)}
                  className="inline-flex items-center justify-center gap-1.5 py-3 rounded-lg bg-accent/15 text-accent border border-accent/25 font-semibold text-xs hover:bg-accent/25 active:scale-[0.98] transition-all duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                >
                  <Send size={13} aria-hidden="true" /> <TruncatedText text={a} maxChars={28} />
                </button>
              ))}
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
