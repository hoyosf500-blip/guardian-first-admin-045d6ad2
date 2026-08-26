import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquare, Phone, MapPin, Package, Clock, Inbox, CheckCircle2, Loader2 } from 'lucide-react';
import { useStore } from '@/contexts/StoreContext';
import { useInboxEsperando, type InboxItem } from '@/hooks/useInboxEsperando';
import { haceCuantoMs } from '@/lib/actividadChat';
import { getWhatsAppPhone, formatPhone } from '@/lib/orderUtils';
import { formatCOP } from '@/lib/utils';
import { useRecordGestion } from '@/hooks/useRecordGestion';
import EscribirWhatsappDialog from '@/components/seguimiento/EscribirWhatsappDialog';

// Re-render cada 60s para que "hace 2 h" suba solo, sin re-fetch.
function useMinuteTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
}

// Más de 3 h esperando = urgente (rojo); 1-3 h = tibio (ámbar); recién = normal.
function tono(entranteAt: number): { chip: string; dot: string } {
  const h = (Date.now() - entranteAt) / 3_600_000;
  if (h >= 3) return { chip: 'bg-danger/14 border-danger/30 text-danger', dot: 'bg-danger' };
  if (h >= 1) return { chip: 'bg-warning/14 border-warning/30 text-warning', dot: 'bg-warning' };
  return { chip: 'bg-success/14 border-success/30 text-success', dot: 'bg-success' };
}

export default function InboxPage() {
  const { activeStoreId, activeStore } = useStore();
  const { items, status } = useInboxEsperando(activeStoreId);
  const recordContacto = useRecordGestion();
  const [abierto, setAbierto] = useState<InboxItem | null>(null);
  useMinuteTick();

  const cc = activeStore?.country_code;

  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-5">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">CRM · WhatsApp</div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-3">
          <span className="w-11 h-11 rounded-2xl bg-accent/14 border border-accent/30 text-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
            <Inbox size={20} strokeWidth={2.25} />
          </span>
          Escribieron
          {items.length > 0 && (
            <span className="text-sm font-mono tabular-nums px-2.5 py-1 rounded-full bg-danger/14 border border-danger/30 text-danger">
              {items.length}
            </span>
          )}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Clientes que escribieron y nadie contestó todavía. El de arriba es el que lleva más esperando —
          a ninguno se lo deja enfriar.
        </p>
      </header>

      {status === 'cargando' && (
        <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
          <Loader2 size={16} className="animate-spin mr-2" /> Leyendo quién escribió…
        </div>
      )}

      {status === 'error' && (
        <div className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          No se pudo leer la bandeja ahora mismo. Reintentá en un momento.
        </div>
      )}

      {status === 'not_ready' && (
        <div className="rounded-2xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          La bandeja se prende cuando ImporChat esté configurado en esta tienda.
        </div>
      )}

      {status === 'ok' && items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <span className="w-12 h-12 rounded-2xl bg-success/14 border border-success/30 text-success flex items-center justify-center" aria-hidden="true">
            <CheckCircle2 size={24} />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">Nadie esperando respuesta</p>
            <p className="text-xs text-muted-foreground mt-1">Todos los que escribieron ya fueron atendidos 🎉</p>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2.5">
        {items.map((o) => {
          const t = tono(o.entranteAt);
          return (
            <div key={o.dbId} className="relative bg-card/40 border border-border rounded-2xl p-4 flex flex-col gap-3 hover:border-border-strong transition-colors">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-base font-bold text-foreground truncate">{o.nombre}</span>
                    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg border text-[11px] font-bold ${t.chip}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${t.dot}`} aria-hidden="true" />
                      <Clock size={10} aria-hidden="true" /> {haceCuantoMs(o.entranteAt)}
                    </span>
                    <span className="pill pill-neutral text-[10px] px-2 py-0.5 rounded-full font-semibold">{o.estado || '—'}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                    <div className="font-mono tabular-nums">{formatPhone(o.phone)}</div>
                    {(o.producto || o.ciudad) && (
                      <div className="flex items-center gap-3 flex-wrap">
                        {o.producto && <span className="inline-flex items-center gap-1"><Package size={11} aria-hidden="true" /> {o.producto}</span>}
                        {o.ciudad && <span className="inline-flex items-center gap-1"><MapPin size={11} aria-hidden="true" /> {o.ciudad}</span>}
                        {o.valor ? <span className="font-mono tabular-nums font-semibold text-foreground">{formatCOP(o.valor)}</span> : null}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => setAbierto(o)}
                  disabled={!o.externalId}
                  className="flex-1 min-w-[130px] text-[11px] py-2.5 rounded-xl bg-success/16 border border-success/40 text-success font-semibold hover:border-success/70 inline-flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40"
                >
                  <MessageSquare size={13} /> Responder por WhatsApp
                </button>
                <a
                  href={'tel:+' + getWhatsAppPhone(o.phone, cc)}
                  onClick={() => void recordContacto(o.phone, 'LLAMADA', 'llamó')}
                  className="flex-1 min-w-[110px] text-[11px] py-2.5 rounded-xl bg-card/40 text-muted-foreground font-semibold hover:text-foreground hover:border-border-strong no-underline inline-flex items-center justify-center gap-1.5 border border-border transition-colors"
                >
                  <Phone size={13} /> Llamar
                </a>
                {o.externalId && (
                  <Link
                    to={`/pedido/${o.externalId}`}
                    className="text-[11px] py-2.5 px-3 rounded-xl text-muted-foreground hover:text-accent inline-flex items-center justify-center transition-colors"
                  >
                    Ver pedido
                  </Link>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {abierto && abierto.externalId && (
        <EscribirWhatsappDialog
          open={!!abierto}
          onOpenChange={(v) => { if (!v) setAbierto(null); }}
          externalId={String(abierto.externalId)}
          nombre={abierto.nombre}
          estado={abierto.estado}
          datos={{
            guia: abierto.guia,
            transportadora: abierto.transportadora,
            ciudad: abierto.ciudad,
            producto: abierto.producto,
            valor: abierto.valor ? formatCOP(abierto.valor) : null,
          }}
          modulo="SEG"
        />
      )}
    </div>
  );
}
