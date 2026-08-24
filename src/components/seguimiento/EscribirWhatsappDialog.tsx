import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { MessageCircle, Send, Clock, X } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useEnviarWhatsapp } from '@/hooks/useEnviarWhatsapp';
import { plantillasPara } from '@/lib/plantillasChat';
import { ventanaWhatsapp, MOTIVO_VENTANA } from '@/lib/ventanaWhatsapp';
import type { ActividadChatOrden } from '@/lib/actividadChat';
import { cn } from '@/lib/utils';

/**
 * Escribirle al cliente por WhatsApp sin salir de Guardian.
 *
 * La ventana de 24 h se muestra ANTES de escribir, no después de fallar: si
 * está vencida el cuadro lo dice con todas las letras y ofrece el teléfono, en
 * vez de dejar que la asesora escriba un mensaje que Meta no va a entregar y
 * que nadie sabría que se perdió.
 *
 * El envío se considera hecho SOLO si el servidor lo confirmó releyendo el
 * chat (ver `importchat-send`). Un "listo" sin confirmar sería peor que un
 * error: la asesora tacharía el pedido de su lista.
 */
export default function EscribirWhatsappDialog({ open, onOpenChange, externalId, nombre, estado, actividad, onEnviado }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  externalId: string;
  nombre?: string | null;
  estado?: string | null;
  actividad?: ActividadChatOrden | null;
  onEnviado?: () => void;
}) {
  const { enviar, enviando } = useEnviarWhatsapp();
  const [texto, setTexto] = useState('');
  const plantillas = useMemo(() => plantillasPara(estado, nombre), [estado, nombre]);
  const v = useMemo(
    () => ventanaWhatsapp(actividad?.entranteAt ?? null, !!actividad),
    [actividad],
  );
  const puedeEscribir = v.estado === 'abierta';

  // Arranca con la primera sugerencia ya puesta: a las 9 de la mañana, con 40
  // pedidos, el cuadro en blanco es lo que hace que nadie escriba.
  useEffect(() => {
    if (open) setTexto(plantillas[0]?.texto ?? '');
  }, [open, plantillas]);

  const mandar = async () => {
    const r = await enviar(externalId, texto);
    if (r.ok) {
      toast.success('Mensaje enviado y confirmado en el chat');
      onEnviado?.();
      onOpenChange(false);
    } else {
      toast.error(r.error || 'No se pudo enviar');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <MessageCircle size={16} className="text-success" aria-hidden="true" />
            Escribirle a {nombre || 'el cliente'}
          </DialogTitle>
        </DialogHeader>

        {/* El estado de la ventana va PRIMERO: decide si tiene sentido escribir. */}
        {puedeEscribir ? (
          <div className="flex items-center gap-2 rounded-xl border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
            <Clock size={13} aria-hidden="true" className="shrink-0" />
            <span>
              Se puede escribir por {v.restanteMs == null ? '' : `${Math.max(1, Math.round(v.restanteMs / 3600_000))} h más`}
              {' '}— después de eso WhatsApp ya no entrega mensajes escritos a mano.
            </span>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            <X size={13} aria-hidden="true" className="shrink-0 mt-0.5" />
            <span>{MOTIVO_VENTANA[v.estado]}</span>
          </div>
        )}

        {puedeEscribir && (
          <>
            <div className="flex flex-wrap gap-1.5">
              {plantillas.map((p) => (
                <button
                  key={p.titulo}
                  type="button"
                  onClick={() => setTexto(p.texto)}
                  className={cn(
                    'rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors',
                    texto === p.texto
                      ? 'border-accent/50 bg-accent/15 text-accent'
                      : 'border-border bg-card/40 text-muted-foreground hover:text-foreground hover:border-border-strong',
                  )}
                >
                  {p.titulo}
                </button>
              ))}
            </div>

            <textarea
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              rows={5}
              maxLength={1000}
              placeholder="Escribile al cliente…"
              className="w-full rounded-xl border border-border bg-card/40 px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
            />

            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground font-mono tabular-nums">
                {texto.trim().length}/1000
              </span>
              <button
                type="button"
                onClick={() => void mandar()}
                disabled={enviando || !texto.trim()}
                className="ml-auto btn-accent-3d inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
              >
                <Send size={14} aria-hidden="true" />
                {enviando ? 'Enviando…' : 'Enviar por WhatsApp'}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground leading-snug">
              Sale del WhatsApp del negocio, en la misma conversación de siempre, y queda
              registrado con tu nombre. Guardian confirma que llegó al chat antes de darlo por enviado.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
