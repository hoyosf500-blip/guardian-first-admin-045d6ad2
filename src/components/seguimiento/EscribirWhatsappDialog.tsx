import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { MessageCircle, Send, Clock, X } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useEnviarWhatsapp } from '@/hooks/useEnviarWhatsapp';
import { useConversacion } from '@/hooks/useConversacion';
import ConversacionChat from '@/components/seguimiento/ConversacionChat';
import { plantillasPara } from '@/lib/plantillasChat';
import { ventanaWhatsapp, MOTIVO_VENTANA, type EstadoVentana } from '@/lib/ventanaWhatsapp';
import type { ActividadChatOrden } from '@/lib/actividadChat';
import { cn } from '@/lib/utils';

/**
 * Escribirle al cliente por WhatsApp sin salir de Guardian — leyendo primero
 * lo que dijo.
 *
 * La conversación va ARRIBA del cuadro de texto y se muestra SIEMPRE, también
 * cuando la ventana de 24 h ya venció: aunque no se pueda escribir, saber qué
 * pasó es justo lo que decide si hay que llamar por teléfono.
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

  const hilo = useConversacion(externalId, open);

  // La ventana la decide el hilo RECIÉN leído. La columna sincronizada puede
  // tener media hora, y en una ventana de 24 h eso es la diferencia entre que
  // el mensaje llegue o se pierda sin que nadie se entere. Mientras el hilo
  // carga (o si no se pudo leer) manda lo sincronizado, que es lo mejor que
  // hay — nunca se asume "abierta" por no saber.
  const vSincronizada = useMemo(
    () => ventanaWhatsapp(actividad?.entranteAt ?? null, !!actividad),
    [actividad],
  );
  const v = hilo.estado === 'ok' && hilo.ventana
    ? { estado: hilo.ventana.estado as EstadoVentana, restanteMs: hilo.ventana.restanteMs }
    : vSincronizada;
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
      // El servidor ya releyó el chat para verificar: se pinta lo que devolvió
      // en vez de pedirlo otra vez.
      if (r.mensajes) hilo.setMensajes(r.mensajes);
      setTexto('');
      onEnviado?.();
    } else {
      toast.error(r.error || 'No se pudo enviar');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <MessageCircle size={16} className="text-success" aria-hidden="true" />
            {nombre || 'El cliente'} por WhatsApp
          </DialogTitle>
        </DialogHeader>

        {/* Lo que pasó, primero. Aunque no se pueda escribir, esto es lo que
            decide si hay que llamar. */}
        <ConversacionChat
          mensajes={hilo.mensajes}
          estado={hilo.estado}
          error={hilo.error}
          onRecargar={hilo.recargar}
        />

        {/* El estado de la ventana: decide si tiene sentido escribir. */}
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
              rows={4}
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
