import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquare, Phone, MapPin, Package, Clock, Inbox, CheckCircle2, Loader2, Truck, Home, ChevronRight } from 'lucide-react';
import { useStore } from '@/contexts/StoreContext';
import { useInboxEsperando, type InboxItem } from '@/hooks/useInboxEsperando';
import { useImporchatSyncHealth } from '@/hooks/useImporchatSyncHealth';
import { useCanalChat, nombreCanal } from '@/hooks/useCanalChat';
import { sourceSyncChat } from '@/lib/canalChat';
import { haceCuantoMs } from '@/lib/actividadChat';
import { ventanaWhatsapp } from '@/lib/ventanaWhatsapp';
import { getWhatsAppPhone, formatPhone } from '@/lib/orderUtils';
import { formatCOP } from '@/lib/utils';
import { useRecordGestion } from '@/hooks/useRecordGestion';
import { precargarPlantillas } from '@/hooks/usePlantillasMeta';
import EscribirWhatsappDialog from '@/components/seguimiento/EscribirWhatsappDialog';
import PanelConversacion from '@/components/seguimiento/PanelConversacion';
import AccionPrincipal from '@/components/seguimiento/AccionPrincipal';

// Re-render cada 60s para que "hace 2 h" suba solo, sin re-fetch.
function useMinuteTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
}

/**
 * ¿Cabe la cola Y la conversación al lado?
 *
 * A 1024 px hay lugar para una columna de ~340 px y un hilo legible. Debajo de
 * eso la bandeja sigue siendo la lista de siempre con el cuadro modal: apretar
 * media pantalla en un celular no sería un panel, sería dos cosas ilegibles.
 *
 * Arranca en `false` a propósito: antes del primer efecto no se sabe el ancho,
 * y el layout angosto —el que ya existía— es el que funciona en las dos.
 */
function usePantallaAncha(): boolean {
  const [ancha, setAncha] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const on = () => setAncha(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return ancha;
}

// Más de 3 h esperando = urgente (rojo); 1-3 h = tibio (ámbar); recién = normal.
function tono(entranteAt: number): { chip: string; dot: string } {
  const h = (Date.now() - entranteAt) / 3_600_000;
  if (h >= 3) return { chip: 'bg-danger/14 border-danger/30 text-danger', dot: 'bg-danger' };
  if (h >= 1) return { chip: 'bg-warning/14 border-warning/30 text-warning', dot: 'bg-warning' };
  return { chip: 'bg-success/14 border-success/30 text-success', dot: 'bg-success' };
}

/** Iniciales para el círculo. Ayuda a volver a encontrar a la misma persona en
 *  una lista larga: el ojo agarra la forma antes que el texto. */
function iniciales(nombre: string): string {
  const p = nombre.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return '?';
  return ((p[0][0] || '') + (p.length > 1 ? p[p.length - 1][0] || '' : '')).toUpperCase();
}

/** Los datos con los que se rellenan los huecos de una plantilla aprobada. */
function datosDe(o: InboxItem) {
  return {
    guia: o.guia,
    transportadora: o.transportadora,
    ciudad: o.ciudad,
    direccion: o.direccion,
    producto: o.producto,
    valor: o.valor ? formatCOP(o.valor) : null,
  };
}

/** Lo que necesita el botón de acción para saber si la ventana de 24 h está
 *  abierta. Sin esto queda en `sin_dato` y el botón se apaga — justo en la
 *  pantalla donde la ventana está abierta con seguridad. */
function actividadDe(o: InboxItem) {
  return {
    salienteAt: o.salienteAt,
    salienteTipo: null,
    entranteAt: o.entranteAt,
    leidoAt: o.leidoAt,
  };
}

/**
 * Los tres caminos que no son escribir a mano: el envío de un clic según la
 * fase del pedido, el teléfono y la ficha.
 *
 * ⛔ Va a nivel de módulo, NO dentro de `InboxPage`. Definido adentro, React lo
 * trata como un componente NUEVO en cada pintada y remonta `AccionPrincipal`
 * entero — o sea que la vista previa del mensaje se cerraría sola cada vez que
 * algo re-renderiza, y esta pantalla re-renderiza cada minuto por el reloj.
 *
 * `plano`: en la lista angosta estos botones comparten fila con "Leer y
 * contestar", así que salen sueltos, sin envoltorio propio.
 */
function Acciones({ o, cc, onLlamar, plano, className }: {
  o: InboxItem;
  cc?: string | null;
  onLlamar: (phone: string) => void;
  plano?: boolean;
  className?: string;
}) {
  const botones = (
    <>
      {o.externalId && (
        <AccionPrincipal
          externalId={String(o.externalId)}
          phone={o.phone}
          estado={o.estado}
          nombre={o.nombre}
          actividad={actividadDe(o)}
          datos={datosDe(o)}
          modulo="SEG"
          className="flex-1 min-w-[130px] justify-center py-2.5 text-[11px] opacity-80"
          fallback={null}
        />
      )}
      <a
        href={'tel:+' + getWhatsAppPhone(o.phone, cc)}
        onClick={() => onLlamar(o.phone)}
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
    </>
  );
  if (plano) return botones;
  return <div className={`flex gap-2 flex-wrap ${className || ''}`}>{botones}</div>;
}

/** El botón de siempre: abre el cuadro completo con todas las plantillas. */
function BotonResponder({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title="Abre la conversación para leer qué dijo el cliente y contestarle"
      className="flex-1 min-w-[130px] text-[11px] py-2.5 rounded-xl bg-danger/14 border border-danger/40 text-danger font-bold hover:border-danger/70 inline-flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40"
    >
      <MessageSquare size={13} /> Leer y contestar
    </button>
  );
}

/**
 * Una persona de la cola.
 *
 * `compacto` es el modo de la columna izquierda cuando la conversación va al
 * lado: sin botonera, porque los botones viven en el panel — se actúa DESPUÉS
 * de leer, que es la regla de esta pantalla. En angosto se dibuja completa,
 * exactamente como venía.
 */
function FilaCliente({ o, compacto, seleccionado, onSelect, children }: {
  o: InboxItem;
  compacto: boolean;
  seleccionado?: boolean;
  onSelect?: () => void;
  children?: ReactNode;
}) {
  const t = tono(o.entranteAt);
  // ⛔ Es una PISTA, no el veredicto. Sale de `chat_entrante_at`, que lo escribe
  // el sync y puede tener ~20 min. El panel vuelve a decidir con el hilo recién
  // leído, y el servidor revalida antes de mandar. Vale la pena igual: saber
  // ANTES de abrir que a este cliente ya no se le puede escribir gratis cambia
  // a quién atiende primero la asesora.
  const vencida = ventanaWhatsapp(o.entranteAt, true).estado === 'vencida';

  const Cuerpo = (
    <>
      <div className="flex items-start gap-3 min-w-0">
        <span
          className={`w-9 h-9 shrink-0 rounded-xl border flex items-center justify-center text-[11px] font-bold ${seleccionado ? 'bg-accent/20 border-accent/40 text-accent' : 'bg-card/60 border-border text-muted-foreground'}`}
          aria-hidden="true"
        >
          {iniciales(o.nombre)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-foreground truncate">{o.nombre}</span>
            <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg border text-[11px] font-bold ${t.chip}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${t.dot}`} aria-hidden="true" />
              <Clock size={10} aria-hidden="true" /> {haceCuantoMs(o.entranteAt)}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-1">
            <span className="pill pill-neutral text-[10px] px-2 py-0.5 rounded-full font-semibold">{o.estado || '—'}</span>
            {/* Días EN ESE ESTADO, no desde que nació el pedido: es el reloj que
                dice qué tan cerca está de devolverse. `null` se dibuja "—". */}
            <span
              className="text-[10px] font-mono tabular-nums font-bold text-muted-foreground"
              title={o.diasEnEstado == null
                ? 'Dropi no reporta cuándo se movió por última vez'
                : `Lleva ${o.diasEnEstado} ${o.diasEnEstado === 1 ? 'día' : 'días'} en «${o.estado || 'este estado'}»`}
            >
              D{o.diasEnEstado ?? '—'}
            </span>
            {vencida && (
              <span
                className="text-[10px] px-2 py-0.5 rounded-full font-bold border border-warning/40 bg-warning/10 text-warning"
                title="Pasaron más de 24 h desde su último mensaje: WhatsApp ya no entrega texto escrito a mano, hay que mandarle una plantilla aprobada."
              >
                solo plantilla
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-1.5 space-y-0.5">
            <div className="font-mono tabular-nums">{formatPhone(o.phone)}</div>
            {(o.producto || o.ciudad) && (
              <div className="flex items-center gap-3 flex-wrap">
                {o.producto && <span className="inline-flex items-center gap-1 truncate"><Package size={11} aria-hidden="true" /> {o.producto}</span>}
                {o.ciudad && <span className="inline-flex items-center gap-1"><MapPin size={11} aria-hidden="true" /> {o.ciudad}</span>}
                {o.valor ? <span className="font-mono tabular-nums font-semibold text-foreground">{formatCOP(o.valor)}</span> : null}
              </div>
            )}
          </div>
        </div>
        {compacto && (
          <ChevronRight size={16} className={`shrink-0 mt-1 ${seleccionado ? 'text-accent' : 'text-muted-foreground/50'}`} aria-hidden="true" />
        )}
      </div>
      {children}
    </>
  );

  if (compacto) {
    return (
      <button
        type="button"
        onClick={onSelect}
        aria-current={seleccionado ? 'true' : undefined}
        className={`w-full text-left rounded-2xl p-3 border transition-colors ${
          seleccionado
            ? 'bg-accent/10 border-accent/40'
            : 'bg-card/40 border-border hover:border-border-strong'
        }`}
      >
        {Cuerpo}
      </button>
    );
  }

  return (
    <div className="relative bg-card/40 border border-border rounded-2xl p-4 flex flex-col gap-3 hover:border-border-strong transition-colors">
      {Cuerpo}
    </div>
  );
}

export default function InboxPage() {
  const { activeStoreId, activeStore } = useStore();
  const { items, status } = useInboxEsperando(activeStoreId);
  // El canal se pregunta por tienda: Ecuador atiende por ImporChat y Colombia
  // por Chatea Pro. Escribirlo a mano mandaba a la asesora colombiana a revisar
  // la app de otro país.
  const canal = useCanalChat();
  const canalNombre = nombreCanal(canal);
  // ⛔ CON EL `source` DEL CANAL. Sin él esta consulta iba siempre contra
  // `importchat-sync` y en Colombia no devolvía ni una fila, así que el aviso
  // de abajo no se encendía NUNCA. Ver `sourceSyncChat`.
  const salud = useImporchatSyncHealth(activeStoreId, sourceSyncChat(canal));
  const recordContacto = useRecordGestion();
  const ancha = usePantallaAncha();

  // Las plantillas aprobadas se piden AL ENTRAR, no cuando la asesora ya apretó
  // el botón y está esperando. La llamada al canal tarda lo mismo; lo que
  // cambia es que ocurre mientras todavía está leyendo la pantalla.
  useEffect(() => { precargarPlantillas(activeStoreId); }, [activeStoreId]);
  const [abierto, setAbierto] = useState<InboxItem | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  useMinuteTick();

  const cc = activeStore?.country_code;

  // La cola avanza sola: si el seleccionado ya no está (le contestaron y salió
  // de la lista), pasa al siguiente en vez de dejar el panel vacío. Ese detalle
  // es la diferencia entre atender la cola y atender un pedido y volver a mirar.
  const sel = useMemo(
    () => items.find((i) => i.dbId === selId) ?? null,
    [items, selId],
  );
  useEffect(() => {
    if (!ancha) return;
    if (sel) return;
    setSelId(items[0]?.dbId ?? null);
  }, [ancha, sel, items]);

  // ¿El feed del canal podría estar caído? Si el sync falla o lleva mucho sin
  // correr, esta lista puede estar INCOMPLETA — y un "Nadie esperando" en verde
  // sobre un feed muerto es una mentira tranquilizadora (hallazgo P1).
  // ⛔ `never` TAMBIÉN es dudoso. "El sync nunca corrió" no es una razón para
  // confiar en la lista: es la razón más fuerte para desconfiar.
  const feedDudoso = salud.data?.status === 'failing'
    || salud.data?.status === 'critical'
    || salud.data?.status === 'never';

  // Cuántos llevan más de un día. Es el número que dice si la cola se está
  // trabajando o solo se está mirando — y no se puede leer de un vistazo
  // contando tarjetas.
  const masDeUnDia = useMemo(
    () => items.filter((i) => Date.now() - i.entranteAt >= 86_400_000).length,
    [items],
  );

  const llamar = (phone: string) => { void recordContacto(phone, 'LLAMADA', 'llamó'); };

  return (
    <div className={ancha ? 'max-w-[1500px] mx-auto' : 'max-w-3xl mx-auto'}>
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
          {masDeUnDia > 0 && (
            <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-danger/10 border border-danger/30 text-danger">
              {masDeUnDia} {masDeUnDia === 1 ? 'lleva' : 'llevan'} más de un día
            </span>
          )}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Clientes que escribieron y nadie contestó todavía. El de arriba es el que lleva más esperando —
          a ninguno se lo deja enfriar.
        </p>
        {/* ⛔ Acá había otro `ImporchatSyncBadge`. Desde el 28-ago-2026 el badge
            vive en `ProtectedLayout`, al lado del de Dropi, para que se vea
            también en Confirmar y Seguimiento. El banner rojo de abajo, que es
            propio de este listado, no se toca. */}
      </header>

      {feedDudoso && (
        <div className="mb-4 rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          ⚠️ El sync de {canalNombre} está fallando o lleva mucho sin correr — esta lista puede estar
          <strong> incompleta</strong>. Si dice "nadie esperando", puede que sí haya clientes esperando.
          Avisá para revisar la conexión.
        </div>
      )}

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
          La bandeja se prende cuando {canalNombre} esté configurado en esta tienda.
        </div>
      )}

      {status === 'sin_medir' && (
        <div className="rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          <p className="font-semibold">Todavía no puedo medir quién está esperando en esta tienda.</p>
          <p className="text-xs mt-1 opacity-90">
            Ningún pedido tiene registrada la actividad del chat, así que esta lista estaría vacía
            aunque hubiera clientes esperando. <strong>No quiere decir que no haya nadie.</strong>{' '}
            Mirá {canalNombre} directamente hasta que la sincronización esté corriendo.
          </p>
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

      {/* ── ANCHA: la cola a la izquierda, la conversación al lado ────────────
          Antes había que abrir un cuadro por cliente, leerlo, cerrarlo y volver
          a la lista. Con nueve personas esperando eso son nueve aperturas, y la
          pantalla mostraba a alguien esperando hace TRES DÍAS. Acá se elige y se
          lee en el mismo lugar, y al contestar la cola pasa sola al siguiente. */}
      {status === 'ok' && items.length > 0 && ancha && (
        <div className="grid grid-cols-[minmax(300px,360px)_1fr] gap-4 items-start">
          <div className="flex flex-col gap-2 max-h-[calc(100vh-15rem)] overflow-y-auto pr-1" role="list">
            {items.map((o) => (
              <FilaCliente
                key={o.dbId}
                o={o}
                compacto
                seleccionado={o.dbId === selId}
                onSelect={() => setSelId(o.dbId)}
              />
            ))}
          </div>

          <div className="sticky top-0">
            {sel ? (
              <div className="rounded-2xl border border-border bg-card/40 p-4 flex flex-col gap-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <h2 className="text-lg font-bold text-foreground truncate">{sel.nombre}</h2>
                    <div className="text-xs text-muted-foreground font-mono tabular-nums mt-0.5">{formatPhone(sel.phone)}</div>
                  </div>
                  <span className="pill pill-neutral text-[10px] px-2 py-0.5 rounded-full font-semibold">{sel.estado || '—'}</span>
                </div>

                {/* El contexto del pedido, a la vista mientras se contesta. Sin
                    esto la asesora tiene que abrir la ficha en otra pestaña para
                    responder "¿dónde va mi paquete?" — que es LA pregunta. */}
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                  {sel.producto && <span className="inline-flex items-center gap-1.5"><Package size={12} aria-hidden="true" /> {sel.producto}</span>}
                  {sel.ciudad && <span className="inline-flex items-center gap-1.5"><MapPin size={12} aria-hidden="true" /> {sel.ciudad}</span>}
                  {sel.valor ? <span className="font-mono tabular-nums font-semibold text-foreground">{formatCOP(sel.valor)}</span> : null}
                  {(sel.transportadora || sel.guia) && (
                    <span className="inline-flex items-center gap-1.5">
                      <Truck size={12} aria-hidden="true" />
                      {sel.transportadora || '—'}{sel.guia ? <span className="font-mono tabular-nums"> · {sel.guia}</span> : null}
                    </span>
                  )}
                  {sel.direccion && <span className="inline-flex items-center gap-1.5 min-w-0"><Home size={12} aria-hidden="true" className="shrink-0" /> <span className="truncate">{sel.direccion}</span></span>}
                </div>

                {/* `key` por pedido: al cambiar de cliente el panel se re-monta
                    entero. Sin eso el borrador escrito para uno se quedaría en
                    el cuadro del siguiente — y ese mensaje sale a un cliente
                    real y no se puede deshacer. */}
                {sel.externalId ? (
                  <PanelConversacion
                    key={sel.externalId}
                    activo
                    externalId={String(sel.externalId)}
                    nombre={sel.nombre}
                    estado={sel.estado}
                    phone={sel.phone}
                    actividad={actividadDe(sel)}
                    datos={datosDe(sel)}
                    modulo="SEG"
                    altoChat="min-h-[240px] max-h-[44vh]"
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Este pedido no tiene número de orden, así que no se puede abrir su conversación desde acá.
                  </p>
                )}

                <Acciones o={sel} cc={cc} onLlamar={llamar} className="border-t border-border pt-3" />
              </div>
            ) : (
              <div className="rounded-2xl border border-border bg-card/40 p-8 text-center text-sm text-muted-foreground">
                Elegí a alguien de la lista para leer lo que escribió.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── ANGOSTA: la lista de siempre, con el cuadro modal ───────────────── */}
      {status === 'ok' && items.length > 0 && !ancha && (
        <div className="flex flex-col gap-2.5">
          {items.map((o) => (
            <FilaCliente key={o.dbId} o={o} compacto={false}>
              <div className="flex gap-2 flex-wrap">
                {/* ⛔ ACÁ LEER VA PRIMERO, SIEMPRE (28-ago-2026).
                    Esta pantalla es, por definición, la de los clientes que
                    ESCRIBIERON y nadie contestó. Poner de primero el envío de
                    un mensaje elegido por el ESTADO del pedido significaba
                    contestarle a una persona sin leer lo que preguntó — y el
                    "me estafaron, devuélvanlo" que en realidad es miedo se
                    pierde exactamente así (ver `imporchat_miedo_no_es_rechazo`).
                    El envío rápido no se saca: queda al lado. */}
                <BotonResponder onClick={() => setAbierto(o)} disabled={!o.externalId} />
                <Acciones o={o} cc={cc} onLlamar={llamar} plano />
              </div>
            </FilaCliente>
          ))}
        </div>
      )}

      {abierto && abierto.externalId && (
        <EscribirWhatsappDialog
          open={!!abierto}
          onOpenChange={(v) => { if (!v) setAbierto(null); }}
          externalId={String(abierto.externalId)}
          nombre={abierto.nombre}
          estado={abierto.estado}
          phone={abierto.phone}
          actividad={actividadDe(abierto)}
          datos={datosDe(abierto)}
          modulo="SEG"
        />
      )}
    </div>
  );
}
