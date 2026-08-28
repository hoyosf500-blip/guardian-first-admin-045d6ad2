import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, AlertTriangle, MessagesSquare } from 'lucide-react';
import type { MensajeConversacion } from '@/lib/conversacion';
import type { EstadoHilo } from '@/hooks/useConversacion';
import { cn } from '@/lib/utils';

/**
 * La conversación de WhatsApp tal como pasó, dentro de Guardian.
 *
 * Presentación pura: recibe mensajes, no consulta nada (misma disciplina que la
 * capa `ui3d`). Quien los trae es `useConversacion`.
 *
 * ── Las dos reglas que dan forma a este componente ─────────────────────────
 * 1. **Mientras carga NO dice "no hay conversación".** Cada estado tiene su
 *    dibujo: un cero afirmado sobre datos que no llegaron se lee como una
 *    buena noticia falsa.
 * 2. **No se adivina quién escribió.** Cada mensaje del negocio muestra el
 *    nombre que ImporChat registró ('Shopify Confirmación' = automático,
 *    'Estefano Moreno' = la asesora). Si no vino, dice "sin nombre" — nunca
 *    "bot".
 */

interface Props {
  mensajes: MensajeConversacion[];
  estado: EstadoHilo;
  error?: string;
  onRecargar?: () => void;
  /** Alto máximo del hilo. El scroll es propio: la pantalla no se estira. */
  className?: string;
  /** `false` cuando la tarjeta que lo contiene ya pone el título y el botón de
   *  recargar — si no, el mismo encabezado aparecería dos veces. */
  mostrarEncabezado?: boolean;
  /** Alto del hilo. En la ficha del pedido es la zona de trabajo y va alta; en
   *  el cuadro de escribir comparte espacio con el teclado y va baja. */
  altoClase?: string;
}

const hora = (ms: number | null) =>
  ms == null ? '' : new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

const dia = (ms: number | null) => {
  if (ms == null) return '';
  const d = new Date(ms);
  const hoy = new Date();
  const mismoDia = d.toDateString() === hoy.toDateString();
  if (mismoDia) return 'Hoy';
  const ayer = new Date(hoy.getTime() - 86_400_000);
  if (d.toDateString() === ayer.toDateString()) return 'Ayer';
  return d.toLocaleDateString('es', { day: '2-digit', month: 'short' });
};

/** Tipos de ImporChat que se pueden PINTAR. Los demás (audio, pdf) se ofrecen
 *  como enlace: mejor un "abrir" que un cuadro vacío. */
const SE_VE = new Set(['image', 'sticker', 'photo']);
const SE_ESCUCHA = new Set(['audio', 'ptt', 'voice']);

function Adjunto({ url, tipo }: { url: string; tipo: string | null }) {
  const [fallo, setFallo] = useState(false);
  const t = String(tipo ?? '').toLowerCase();

  // ⛔ LA NOTA DE VOZ SE ESCUCHA ACÁ (28-ago-2026). Medido sobre 18
  // conversaciones reales de Ecuador: 14 traían audio — el cliente responde
  // hablando mucho más de lo que escribe. Hasta hoy la tarjeta decía
  // "🎧 Nota de voz" y no había forma de oírla sin abrir ImporChat aparte.
  // Verificado en producción: el archivo se sirve sin credenciales y la CSP de
  // la app no lo bloquea.
  if (!fallo && (SE_ESCUCHA.has(t) || /\.(ogg|mp3|m4a|opus|wav)$/i.test(url))) {
    return (
      <audio
        src={url}
        controls
        preload="none"
        onError={() => setFallo(true)}
        className="w-full max-w-[260px] h-8 mb-1"
      />
    );
  }

  const pintable = SE_VE.has(t) || /\.(jpe?g|png|webp|gif)$/i.test(url);

  // No se pudo cargar, o no es una imagen: se ofrece abrirlo. Es información
  // real (hay un archivo) sin fingir que se puede ver acá.
  if (!pintable || fallo) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="block text-[11px] font-semibold text-accent hover:underline mb-0.5"
      >
        Abrir el archivo →
      </a>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className="block mb-1">
      <img
        src={url}
        alt="Adjunto del chat"
        loading="lazy"
        onError={() => setFallo(true)}
        className="max-h-52 w-auto max-w-full rounded-lg border border-border object-contain bg-card/40"
      />
    </a>
  );
}

export default function ConversacionChat({ mensajes, estado, error, onRecargar, className, mostrarEncabezado = true, altoClase = 'min-h-[120px] max-h-[260px]' }: Props) {
  const finRef = useRef<HTMLDivElement>(null);

  // Lo último es lo que importa: el hilo se abre abajo, como cualquier chat.
  useEffect(() => {
    if (estado === 'ok') finRef.current?.scrollIntoView({ block: 'end' });
  }, [estado, mensajes]);

  // Separador de día: solo cuando CAMBIA, no en cada mensaje.
  const conSeparador = useMemo(() => {
    let ultimo = '';
    return mensajes.map((m) => {
      const d = dia(m.fechaMs);
      const nuevo = d && d !== ultimo ? d : null;
      if (d) ultimo = d;
      return { m, separador: nuevo };
    });
  }, [mensajes]);

  // Una tienda sin ImporChat (los otros dueños, que usan otras IA) no ve nada:
  // mejor que no exista a que exista vacío y parezca roto.
  if (estado === 'sin_config') return null;

  return (
    <div className={cn('rounded-xl border border-border bg-card/30 flex flex-col', className)}>
      {mostrarEncabezado && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/70">
          <MessagesSquare size={13} className="text-muted-foreground shrink-0" aria-hidden="true" />
          <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
            Conversación de WhatsApp
          </span>
          {onRecargar && (
            <button
              type="button"
              onClick={onRecargar}
              disabled={estado === 'cargando'}
              className="ml-auto text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
              aria-label="Actualizar la conversación"
              title="Actualizar"
            >
              <RefreshCw size={13} className={estado === 'cargando' ? 'animate-spin' : ''} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      <div role="log" aria-live="polite" className={cn('flex-1 overflow-y-auto px-3 py-2.5 space-y-2', altoClase)}>
        {estado === 'inicial' || estado === 'cargando' ? (
          // ⛔ Acá NO puede decir "sin conversación": todavía no se sabe.
          <div className="space-y-2" aria-label="Leyendo la conversación">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className={cn('h-8 rounded-xl bg-muted/40 animate-pulse', i % 2 ? 'ml-auto w-1/2' : 'w-2/3')}
              />
            ))}
            <p className="text-[11px] text-muted-foreground text-center pt-1">Leyendo la conversación en ImporChat…</p>
          </div>
        ) : estado === 'error' || estado === 'sin_chat' ? (
          <div className="flex items-start gap-2 text-[11px] text-warning py-2">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
            <div className="space-y-1.5">
              <p>{error || 'No se pudo leer la conversación.'}</p>
              {estado === 'error' && onRecargar && (
                <button type="button" onClick={onRecargar} className="underline hover:no-underline font-semibold">
                  Probar de nuevo
                </button>
              )}
            </div>
          </div>
        ) : mensajes.length === 0 ? (
          <p className="text-[11px] text-muted-foreground text-center py-4">
            Esta conversación está abierta pero todavía no tiene mensajes.
          </p>
        ) : (
          conSeparador.map(({ m, separador }) => (
            <div key={m.id}>
              {separador && (
                <div className="flex items-center gap-2 my-2" aria-hidden="true">
                  <div className="h-px flex-1 bg-border/60" />
                  <span className="text-[10px] text-muted-foreground font-mono">{separador}</span>
                  <div className="h-px flex-1 bg-border/60" />
                </div>
              )}

              {m.de === 'sistema' ? (
                <p className="text-[10px] text-muted-foreground/70 text-center italic px-4">{m.texto}</p>
              ) : (
                <div className={cn('flex', m.de === 'cliente' ? 'justify-start' : 'justify-end')}>
                  <div
                    className={cn(
                      'max-w-[82%] rounded-2xl px-3 py-1.5 border',
                      m.de === 'cliente'
                        ? 'bg-card/70 border-border rounded-bl-md'
                        : 'bg-accent/12 border-accent/25 rounded-br-md',
                    )}
                  >
                    {/* Quién escribió: la pregunta original del dueño, contestada
                        mensaje por mensaje y sin inventar. */}
                    {m.de === 'negocio' && (
                      <p className="text-[10px] font-semibold text-accent/90 mb-0.5">
                        {m.autor ?? <span className="text-muted-foreground font-normal italic">sin nombre registrado</span>}
                      </p>
                    )}
                    {/* El adjunto, cuando lo hay. ImporChat siempre mandó la
                        ruta y Guardian la tiraba: la foto del comprobante o del
                        producto equivocado es, muchas veces, la conversación
                        entera. Ver `archivoUrl` en `conversacion.ts`.

                        ⛔ Degrada solo: si la imagen no carga (ruta que exige
                        sesión, archivo borrado) se esconde y queda el marcador
                        de texto de siempre. Nunca un cuadro roto. */}
                    {m.archivoUrl && <Adjunto url={m.archivoUrl} tipo={m.tipo} />}
                    <p className={cn('text-xs leading-snug whitespace-pre-wrap break-words', m.esMarcador && 'italic text-muted-foreground')}>
                      {m.texto}
                    </p>
                    <p className="text-[10px] text-muted-foreground/70 text-right font-mono tabular-nums mt-0.5">
                      {hora(m.fechaMs) || '—'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
        <div ref={finRef} />
      </div>
    </div>
  );
}
