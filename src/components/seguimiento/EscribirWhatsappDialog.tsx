import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { MessageCircle, Send, Clock, X, Package } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useEnviarWhatsapp, type ModuloEnvio } from '@/hooks/useEnviarWhatsapp';
import { useConversacion } from '@/hooks/useConversacion';
import { useCanalChat, nombreCanal } from '@/hooks/useCanalChat';
import ConversacionChat from '@/components/seguimiento/ConversacionChat';
import PlantillasWhatsapp from '@/components/seguimiento/PlantillasWhatsapp';
import { plantillasPara } from '@/lib/plantillasChat';
import { faseParaPlantillas } from '@/lib/accionSeguimiento';
import { componerEstadoPedido } from '@/lib/estadoPedidoRespuesta';
import { getTrackingUrl } from '@/lib/orderUtils';
import { ventanaWhatsapp, MOTIVO_VENTANA, type EstadoVentana } from '@/lib/ventanaWhatsapp';
import type { DatosPedido } from '@/lib/plantillasMeta';
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
export default function EscribirWhatsappDialog({ open, onOpenChange, externalId, nombre, estado, phone, actividad, datos, modulo, onEnviado }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  externalId: string;
  nombre?: string | null;
  estado?: string | null;
  /** Opcional: si viene, el contador de Seguimiento baja apenas se envía, sin
   *  esperar a que alguien recargue. Ver `eventosGestion.ts`. */
  phone?: string | null;
  actividad?: ActividadChatOrden | null;
  /** Guía, transportadora, ciudad… con lo que se rellenan los huecos de una
   *  plantilla aprobada. Sin esto la plantilla igual se puede mandar: la
   *  asesora escribe los datos a mano. */
  datos?: DatosPedido;
  /** Desde qué pantalla se escribe. Decide el prefijo del touchpoint: `SEG:%`
   *  cuenta como gestión de Seguimiento, y escribir desde Confirmar es un
   *  intento de contacto, no la gestión de esa pantalla. */
  modulo?: ModuloEnvio;
  onEnviado?: () => void;
}) {
  const { enviar, enviando } = useEnviarWhatsapp();
  const [texto, setTexto] = useState('');
  const datosPedido = useMemo<DatosPedido>(
    () => ({ ...datos, nombre: datos?.nombre ?? nombre ?? null }),
    [datos, nombre],
  );
  // `datosPedido` va como tercer argumento: sin él, las fases con guía
  // arrancaban con un texto genérico SIN la guía. Ver `plantillasChat.ts`.
  const plantillas = useMemo(
    () => plantillasPara(estado, nombre, datosPedido),
    [estado, nombre, datosPedido],
  );
  // ⛔ `faseParaPlantillas`, NO `classifySegEstado`: la cola de Confirmar cae
  // en `otros` y ahí las plantillas salían en orden alfabético, con las de
  // confirmación cuartas. Ver el guardián `plantillasConfirmar.test.ts`.
  const fase = useMemo(() => faseParaPlantillas(estado), [estado]);

  // Bot NO CIEGO (asistido): con la data que Guardian YA tiene arma la respuesta
  // a "¿cuál es mi guía / cuándo llega?". La asesora la mete al cuadro de un clic
  // y la revisa antes de enviar. `derivarAHumano` (cancelado / estado desconocido)
  // = no hay respuesta buena para enlatar → el botón no se ofrece. El país lo
  // resuelve getTrackingUrl solo (estado de módulo que setea StoreContext).
  const respEstado = useMemo(
    () => componerEstadoPedido({
      nombre,
      estado,
      guia: datos?.guia,
      transportadora: datos?.transportadora,
      trackingUrl: getTrackingUrl(datos?.transportadora || '', datos?.guia || ''),
    }),
    [nombre, estado, datos?.transportadora, datos?.guia],
  );

  const hilo = useConversacion(externalId, open);
  // Para nombrar el canal REAL de la tienda: mandar a una asesora colombiana a
  // ImporChat es mandarla a la app de Ecuador, donde ese chat no existe.
  const canalChat = useCanalChat();

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
  // Sin dato sincronizado (Novedades no lo carga) y con el hilo todavía en
  // camino, no se sabe si se puede escribir. Decir "no se puede" ahí sería
  // afirmar algo que un segundo después se desmiente solo.
  const averiguando = !actividad && (hilo.estado === 'inicial' || hilo.estado === 'cargando');
  // ⛔ `sin_chat` ES TERMINAL: ImporChat contestó que este pedido no tiene
  // conversación. No hay nada que esperar — el `sin_dato` mudo prometía un dato
  // que nunca iba a llegar, y dejaba el cuadro sin textarea Y sin plantillas:
  // la asesora abría «WhatsApp» y no tenía absolutamente nada que tocar.
  //
  // Un pedido sin conversación es justamente `nunca_escribio`, que es EL caso
  // donde la plantilla es la única vía. Ofrecerla no puede colar un envío
  // indebido: el servidor revalida la ventana antes de mandar.
  const sinConversacion = v.estado === 'sin_dato' && hilo.estado === 'sin_chat';
  const estadoVentanaEfectivo: EstadoVentana = sinConversacion ? 'nunca_escribio' : v.estado;

  // Arranca con la primera sugerencia ya puesta: a las 9 de la mañana, con 40
  // pedidos, el cuadro en blanco es lo que hace que nadie escriba.
  //
  // ⛔ UNA SOLA VEZ POR APERTURA (30-ago-2026). `plantillas` se memoiza en
  // [estado, nombre], así que un cambio de estado por realtime devolvía un
  // array nuevo, el efecto volvía a correr con el diálogo ABIERTO y le
  // reemplazaba a la asesora el mensaje largo que estaba redactando por la
  // sugerencia enlatada. `if (open)` no protege de nada: el diálogo sigue
  // abierto, que es justo el problema.
  const sembradoRef = useRef(false);
  useEffect(() => {
    if (!open) { sembradoRef.current = false; return; }
    if (sembradoRef.current) return;
    sembradoRef.current = true;
    setTexto(plantillas[0]?.texto ?? '');
  }, [open, plantillas]);

  // ⛔ RED DE SEGURIDAD para el olvido que ya costó un regaño a una persona:
  // `touchpoints` NO está en la publicación de realtime, así que la única vía
  // para que la cobertura del día registre un WhatsApp es el evento local
  // `emitirGestion` — y ese solo se emite `if (gestion?.phone)`. Sin `phone`,
  // la asesora manda el mensaje, ve "enviado y confirmado", y el pedido sigue
  // contando como "por gestionar hoy". Se arregló en el tablero y no se
  // propagó a las otras seis pantallas durante meses, EN SILENCIO.
  useEffect(() => {
    if (open && !phone) {
      console.warn(
        '[EscribirWhatsappDialog] falta `phone` — el mensaje se va a enviar pero ' +
        'NO va a bajar el contador de gestión del día. Pasá phone={o.phone}.',
      );
    }
  }, [open, phone]);

  const mandar = async () => {
    const r = await enviar(externalId, texto, modulo, { phone });
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
      {/* ⛔ El clic NO puede salir de acá (28-ago-2026, reportado por el dueño:
          *"le doy en la X para salirme y lo que hace es entrar al pedido"*).
          Radix dibuja esto en un PORTAL, así que en el DOM cuelga del <body> —
          pero React burbujea por su propio árbol, y ahí el padre sigue siendo la
          tarjeta, que tiene onClick para abrir el pedido. Cerrar el chat te
          metía en la ficha.
          Va en el diálogo y no en cada tarjeta porque lo abren SEIS pantallas
          (SegBoard, CrmTable, CallView, CrmCallView, NovedadView y la card de
          chat) y varias de ellas también son filas clicables. */}
      <DialogContent className="max-w-xl" onClick={(e) => e.stopPropagation()}>
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
        {averiguando ? (
          <div className="flex items-center gap-2 rounded-xl border border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground">
            <Clock size={13} aria-hidden="true" className="shrink-0 animate-pulse" />
            <span>Viendo si todavía se le puede escribir…</span>
          </div>
        ) : puedeEscribir ? (
          <div className="flex items-center gap-2 rounded-xl border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
            <Clock size={13} aria-hidden="true" className="shrink-0" />
            <span>
              Se puede escribir por {v.restanteMs == null ? '' : (() => {
                // Minutos cuando falta menos de 1 h: "1 h más" con 3 min restantes
                // hacía creer que había margen y el próximo envío se bloqueaba.
                const min = Math.round(v.restanteMs / 60_000);
                return min < 60 ? `${Math.max(1, min)} min más` : `${Math.round(min / 60)} h más`;
              })()}
              {' '}— después de eso WhatsApp ya no entrega mensajes escritos a mano.
            </span>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            <X size={13} aria-hidden="true" className="shrink-0 mt-0.5" />
            <span>{sinConversacion
              ? `Este pedido todavía no tiene conversación en ${nombreCanal(canalChat)}, así que un mensaje escrito a mano no le llega. Se le puede mandar una plantilla aprobada, o llamarlo.`
              : MOTIVO_VENTANA[v.estado]}</span>
          </div>
        )}

        {/* Cerrada la ventana, el camino NO se termina: Meta sí entrega una
            plantilla aprobada. Antes acá solo decía "llamalo" y la asesora se
            iba al teléfono teniendo el WhatsApp disponible.
            `sin_dato` queda afuera a propósito: si todavía no se sabe si la
            ventana está abierta, ofrecer la plantilla —que cuesta más— sería
            empujar a la salida cara antes de saber si hace falta. */}
        {!averiguando && (estadoVentanaEfectivo === 'vencida' || estadoVentanaEfectivo === 'nunca_escribio') && (
          <PlantillasWhatsapp
            externalId={externalId}
            fase={fase}
            estadoPedido={estado}
            phone={phone}
            datos={datosPedido}
            modulo={modulo}
            onEnviado={() => { onEnviado?.(); hilo.recargar(); }}
          />
        )}

        {puedeEscribir && (
          <>
            {/* El bot NO CIEGO, asistido: un clic mete la respuesta real de
                estado del pedido (guía/transportadora/rastreo). Se destaca del
                resto porque es lo que el cliente casi siempre viene a preguntar. */}
            {!respEstado.derivarAHumano && respEstado.texto && (
              <button
                type="button"
                onClick={() => setTexto(respEstado.texto)}
                className={cn(
                  'flex items-center gap-1.5 self-start rounded-lg border px-3 py-1.5 text-[11px] font-bold transition-colors',
                  texto === respEstado.texto
                    ? 'border-accent/60 bg-accent/20 text-accent'
                    : 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/20',
                )}
              >
                <Package size={13} aria-hidden="true" />
                Responder estado del pedido
              </button>
            )}

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
