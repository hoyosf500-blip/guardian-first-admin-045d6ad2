import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquare, Phone, MapPin, Package, Clock, Inbox, CheckCircle2, Loader2, Search, AlertTriangle, Lock } from 'lucide-react';
import { useStore } from '@/contexts/StoreContext';
import { useInboxEsperando, HORAS_SIN_RESPUESTA, type InboxItem } from '@/hooks/useInboxEsperando';
import { useImporchatSyncHealth } from '@/hooks/useImporchatSyncHealth';
import { useCanalChat, nombreCanal } from '@/hooks/useCanalChat';
import { sourceSyncChat } from '@/lib/canalChat';
import { haceCuantoMs } from '@/lib/actividadChat';
import { motivoLegible } from '@/lib/promesasPendientes';
import { ventanaWhatsapp } from '@/lib/ventanaWhatsapp';
import { getWhatsAppPhone, formatPhone } from '@/lib/orderUtils';
import { formatCOP } from '@/lib/utils';
import { useRecordGestion } from '@/hooks/useRecordGestion';
import { precargarPlantillas } from '@/hooks/usePlantillasMeta';
import EscribirWhatsappDialog from '@/components/seguimiento/EscribirWhatsappDialog';
import PanelConversacion from '@/components/seguimiento/PanelConversacion';
import AccionPrincipal from '@/components/seguimiento/AccionPrincipal';
import SelloGestion from '@/components/comun/SelloGestion';
import LockBadge from '@/components/LockBadge';
import { useSelloGestion, type EstadoSello, type Sello } from '@/hooks/useSelloGestion';
import { useAtencionPedido } from '@/hooks/useAtencionPedido';
import { usePedidoALaVista } from '@/hooks/useBitacoraPedido';
import { matchesQuery } from '@/lib/textSearch';
import { toast } from 'sonner';

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
 * A 1024 px hay lugar para una columna de ~300 px y un hilo legible. Debajo de
 * eso la bandeja sigue siendo la lista de siempre con el cuadro modal: apretar
 * media pantalla en un celular no sería un panel, serían dos cosas ilegibles.
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
function tono(entranteAt: number): { chip: string; dot: string; texto: string } {
  const h = (Date.now() - entranteAt) / 3_600_000;
  if (h >= 3) return { chip: 'bg-danger/14 border-danger/30 text-danger', dot: 'bg-danger', texto: 'text-danger' };
  if (h >= 1) return { chip: 'bg-warning/14 border-warning/30 text-warning', dot: 'bg-warning', texto: 'text-warning' };
  return { chip: 'bg-success/14 border-success/30 text-success', dot: 'bg-success', texto: 'text-success' };
}

/** Iniciales para el círculo. Ayuda a volver a encontrar a la misma persona en
 *  una lista larga: el ojo agarra la forma antes que el texto. */
function iniciales(nombre: string): string {
  const p = nombre.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return '?';
  return ((p[0][0] || '') + (p.length > 1 ? p[p.length - 1][0] || '' : '')).toUpperCase();
}

/**
 * ¿Se le puede escribir gratis todavía?
 *
 * ⛔ Es una PISTA, no el veredicto. Sale de `chat_entrante_at`, que lo escribe
 * el sync y puede tener ~20 min. El panel vuelve a decidir con el hilo recién
 * leído, y el servidor revalida antes de mandar. Vale la pena igual: saber
 * ANTES de abrir que a este cliente ya no se le puede escribir gratis cambia a
 * quién atiende primero la asesora.
 */
function soloPlantilla(o: InboxItem): boolean {
  return ventanaWhatsapp(o.entranteAt, true).estado === 'vencida';
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
function Acciones({ o, cc, onLlamar, onResolver, resuelto, plano, className }: {
  o: InboxItem;
  cc?: string | null;
  onLlamar: (phone: string) => void;
  /** Marcar que este cliente ya no espera nada. Ver `BotonResuelto`. */
  onResolver: (o: InboxItem) => void;
  resuelto: boolean;
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
          className="flex-1 min-w-[130px] justify-center py-2.5 text-xs opacity-80"
          fallback={null}
        />
      )}
      <BotonResuelto resuelto={resuelto} onClick={() => onResolver(o)} />
      <a
        href={'tel:+' + getWhatsAppPhone(o.phone, cc)}
        onClick={() => onLlamar(o.phone)}
        className="flex-1 min-w-[110px] text-xs py-2.5 rounded-xl bg-card/40 text-muted-foreground font-semibold hover:text-foreground hover:border-border-strong no-underline inline-flex items-center justify-center gap-1.5 border border-border transition-colors"
      >
        <Phone size={13} aria-hidden="true" /> Llamar
      </a>
      {o.externalId && (
        <Link
          to={`/pedido/${o.externalId}`}
          className="text-xs py-2.5 px-3 rounded-xl text-muted-foreground hover:text-accent inline-flex items-center justify-center transition-colors"
        >
          Ver pedido
        </Link>
      )}
    </>
  );
  if (plano) return botones;
  return <div className={`flex gap-2 flex-wrap ${className || ''}`}>{botones}</div>;
}

/**
 * "RESUELTO" — lo que la asesora aprieta cuando este cliente ya no espera nada.
 *
 * ── Por qué hace falta (pedido del dueño, 3-sep-2026) ───────────────────────
 * *"En el inbox poner también un botón de resuelto, para que el asesor marque
 * lo que va terminando."*
 *
 * La bandeja lista a quien escribió último. Si la asesora CONTESTA, el cliente
 * sale solo (el chat cambia de mano). Pero si lo resuelve de otra forma —lo
 * llamó, era un "gracias", el pedido ya se despachó— el cliente se queda ahí
 * para siempre y la cola nunca llega a cero. Una cola que no baja se aprende a
 * ignorar, y esa es la muerte de esta pantalla.
 *
 * ⛔ RESOLVER NO ESCONDE NADA. El dueño fue explícito: *"que los pedidos no se
 * escondan, eso está prohibido; siempre que se muestre el total que hay que
 * trabajar"*. El cliente resuelto SIGUE en la lista, marcado y al final, y el
 * encabezado cuenta las dos cosas. Lo único que cambia es el orden y el color.
 *
 * Y no inventa un estado nuevo: escribe una gestión normal (`touchpoints`), la
 * misma que ya alimenta el sello de "ya lo tocó". Por eso sobrevive a recargar
 * la página, lo ven las compañeras, y si el cliente vuelve a escribir el pedido
 * reaparece esperando — porque su mensaje pasa a ser más nuevo que la gestión.
 */
function BotonResuelto({ resuelto, onClick }: { resuelto: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={resuelto}
      title={resuelto
        ? 'Ya lo marcaste resuelto. Sigue en la lista, al final, hasta que el cliente vuelva a escribir.'
        : 'Este cliente ya no espera nada: lo llamaste, se resolvió, o no hacía falta contestar.'}
      className={`flex-1 min-w-[110px] text-xs py-2.5 rounded-xl font-semibold inline-flex items-center justify-center gap-1.5 border transition-colors ${
        resuelto
          ? 'bg-success/14 border-success/40 text-success cursor-default'
          : 'bg-card/40 border-border text-muted-foreground hover:text-success hover:border-success/40'
      }`}
    >
      <CheckCircle2 size={13} aria-hidden="true" /> {resuelto ? 'Resuelto' : 'Marcar resuelto'}
    </button>
  );
}

/** El botón de siempre: abre el cuadro completo con todas las plantillas. */
function BotonResponder({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title="Abre la conversación para leer qué dijo el cliente y contestarle"
      className="flex-1 min-w-[130px] text-xs py-2.5 rounded-xl bg-danger/14 border border-danger/40 text-danger font-bold hover:border-danger/70 inline-flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40"
    >
      <MessageSquare size={13} aria-hidden="true" /> Leer y contestar
    </button>
  );
}

/**
 * Una fila de la cola, estilo lista de chats: círculo, nombre, una línea de
 * contexto y el reloj a la derecha.
 *
 * ⛔ `min-w-0` en TODA la cadena hasta el texto. Sin eso un nombre largo o una
 * dirección sin espacios no se recorta: empuja la columna, y en un grid la
 * columna empuja la página entera. Eso fue exactamente lo que pasó la primera
 * vez que se armó este panel — la pantalla se desbordó a lo ancho y había que
 * scrollear de lado para ver la barra lateral.
 */
function FilaCola({ o, seleccionada, onSelect, sello, estadoSello, miId, resuelto }: {
  o: InboxItem;
  seleccionada: boolean;
  onSelect: () => void;
  sello: Sello | null;
  estadoSello: EstadoSello;
  miId: string | null;
  /** Ya se atendió. Se APAGA y baja al final — nunca se saca de la lista. */
  resuelto?: boolean;
}) {
  // ⛔ Resuelto se APAGA, no desaparece: el dueño fue explícito en que esconder
  // pedidos está prohibido. El reloj rojo/ámbar tampoco tiene sentido en algo
  // ya atendido — si siguiera en rojo, la lista mentiría sobre la urgencia.
  const t = resuelto
    ? { chip: 'bg-success/12 border-success/25 text-success', dot: 'bg-success', texto: 'text-success' }
    : tono(o.esperaDesde);
  // En la canasta «El bot prometió», lo primero que la asesora necesita leer no
  // es el producto: es QUÉ le prometieron. El producto ya está en la ficha de
  // la derecha; la promesa colgada no está en ningún otro lado.
  const contexto = o.promesa
    ? motivoLegible(o.promesa.motivo)
    : [o.producto, o.ciudad].filter(Boolean).join(' · ');
  // El check va ADEMAS del tono apagado: en blanco y negro, o para quien no
  // distingue colores, la opacidad sola no dice nada.
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={seleccionada ? 'true' : undefined}
      className={`w-full text-left px-3 py-2 flex items-start gap-2.5 min-w-0 border-l-2 transition-colors ${
        seleccionada
          ? 'bg-accent/10 border-l-accent'
          : 'border-l-transparent hover:bg-card/60'
      } ${resuelto ? 'opacity-55' : ''}`}
    >
      <span className="relative shrink-0 mt-0.5">
        <span
          className={`w-8 h-8 rounded-full border flex items-center justify-center text-[11px] font-bold ${
            seleccionada ? 'bg-accent/20 border-accent/40 text-accent' : 'bg-card border-border text-muted-foreground'
          }`}
          aria-hidden="true"
        >
          {iniciales(o.nombre)}
        </span>
        {/* El punto de "sin contestar", como cualquier bandeja. */}
        <span className={`absolute -right-0.5 -top-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-background ${t.dot}`} aria-hidden="true" />
      </span>

      {/* ══ UNA FILA, TRES SEÑALES (rediseño, 4-sep-2026) ═══════════════════
          Antes cada fila apilaba cinco cosas —nombre, producto, pastilla de
          estado, pastilla amarilla «solo plantilla», pastilla índigo del sello—
          y medía ~115 px: cinco clientes a la vista de 75. Y las dos pastillas
          de color salían en TODAS las filas (casi todos llevan +24 h, casi
          todos tienen sello), así que no marcaban nada: eran fondo.
            1. EL CLIENTE — nombre + hace cuánto espera (el reloj lleva el tono).
            2. EL PEDIDO — estado · días, y producto · ciudad al lado, en gris.
            3. NOSOTROS — quién lo tocó y quién lo tiene abierto, en texto.
          «Solo plantilla» pasa a un candado de 10 px junto al reloj: es la
          regla, no la excepción, y una regla no se pinta de amarillo. */}
      <span className="min-w-0 flex-1 block">
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="text-sm font-semibold text-foreground truncate min-w-0 leading-tight">{o.nombre}</span>
          <span className={`ml-auto shrink-0 inline-flex items-center gap-1 text-[11px] font-mono tabular-nums font-semibold ${t.texto}`}>
            {!resuelto && soloPlantilla(o) && (
              <span
                className="inline-flex text-muted-foreground"
                title="Pasaron más de 24 h desde su último mensaje: WhatsApp ya no entrega texto escrito a mano, hay que mandarle una plantilla aprobada."
                aria-label="Solo se le puede mandar una plantilla aprobada"
              >
                <Lock size={10} aria-hidden="true" />
              </span>
            )}
            {resuelto && <CheckCircle2 size={11} aria-label="Resuelto" />}
            {haceCuantoMs(o.esperaDesde)}
          </span>
        </span>
        {/* El estado de Dropi tal cual (los de Ecuador son largos: «PARA RETIRO
            EN AGENCIA SERVIENTREGA»), en su propia línea y sin partirse: el
            texto se recorta, los días no. */}
        <span className="mt-1 flex min-w-0">
          <span
            className="pill pill-neutral text-[11px] min-w-0 max-w-full whitespace-nowrap"
            title={o.diasEnEstado == null
              ? 'Dropi no reporta cuándo se movió por última vez'
              : `Lleva ${o.diasEnEstado} ${o.diasEnEstado === 1 ? 'día' : 'días'} en «${o.estado || 'este estado'}»`}
          >
            <span className="truncate">{o.estado || '—'}</span>
            {o.diasEnEstado != null && <span className="shrink-0 font-mono opacity-80">· {o.diasEnEstado === 0 ? 'hoy' : `${o.diasEnEstado} d`}</span>}
          </span>
        </span>
        {/* ⛔ EL SELLO (3-sep-2026). Esta bandeja no mostraba NADA de gestión:
            una asesora podía haberle contestado a este cliente hace diez minutos
            desde otra pantalla y acá seguía viéndose como si nadie lo hubiera
            tocado. Eso es exactamente el regaño injusto que el dueño quiere
            evitar. El sello dice quién lo tocó ANTES; el candado dice quién lo
            tiene ABIERTO ahora. Son dos preguntas distintas y las dos hacen
            falta para no escribirle dos veces al mismo cliente.
            Va a la DERECHA del producto, en la misma línea: la fila queda en
            tres renglones fijos y la lista muestra el doble de clientes. */}
        {(contexto || sello || o.lockedBy) && (
          <span className="mt-1 flex items-center gap-2 min-w-0">
            {contexto && (
              <span className="text-xs text-muted-foreground truncate min-w-0" title={contexto}>{contexto}</span>
            )}
            {(sello || o.lockedBy) && (
              <span className="ml-auto flex shrink-0 items-center gap-2 max-w-[55%]">
                {sello && <SelloGestion sello={sello} estado={estadoSello} miId={miId} compacto plano />}
                <LockBadge lockedBy={o.lockedBy} lockedAt={o.lockedAt} />
              </span>
            )}
          </span>
        )}
      </span>
    </button>
  );
}

/** Una fila de la ficha del cliente: etiqueta arriba, valor abajo. */
function Dato({ etiqueta, children, ancho }: { etiqueta: string; children: ReactNode; /** Ocupa las dos columnas de la ficha (texto largo). */ ancho?: boolean }) {
  return (
    <div className={ancho ? 'min-w-0 col-span-2' : 'min-w-0'}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">{etiqueta}</div>
      <div className="text-xs text-foreground break-words">{children}</div>
    </div>
  );
}

/** La tarjeta completa de la lista angosta (celular y tablet): como venía. */
function TarjetaLista({ o, sello, estadoSello, miId, children }: {
  o: InboxItem;
  sello: Sello | null;
  estadoSello: EstadoSello;
  miId: string | null;
  children: ReactNode;
}) {
  const t = tono(o.esperaDesde);
  return (
    <div className="relative bg-card/40 border border-border rounded-2xl p-4 flex flex-col gap-3 hover:border-border-strong transition-colors min-w-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-semibold text-foreground truncate">{o.nombre}</span>
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-xs font-semibold ${t.chip}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${t.dot}`} aria-hidden="true" />
            Escribió · {haceCuantoMs(o.esperaDesde)}
          </span>
          {/* Días EN ESE ESTADO, no desde que nació el pedido: es el reloj que
              dice qué tan cerca está de devolverse. `null` no se dibuja. */}
          <span
            className="pill pill-neutral"
            title={o.diasEnEstado == null
              ? 'Dropi no reporta cuándo se movió por última vez'
              : `Lleva ${o.diasEnEstado} ${o.diasEnEstado === 1 ? 'día' : 'días'} en «${o.estado || 'este estado'}»`}
          >
            {o.estado || '—'}
            {o.diasEnEstado != null && <span className="font-mono opacity-80">· {o.diasEnEstado === 0 ? 'hoy' : `${o.diasEnEstado} d`}</span>}
          </span>
          {soloPlantilla(o) && (
            <span
              className="pill pill-warning"
              title="Pasaron más de 24 h desde su último mensaje: hay que mandarle una plantilla aprobada."
            >
              solo plantilla
            </span>
          )}
          <SelloGestion sello={sello} estado={estadoSello} miId={miId} />
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
      {children}
    </div>
  );
}

export default function InboxPage() {
  const { activeStoreId, activeStore } = useStore();
  const { items: esperan, sinRespuesta, prometidos, status, deudaError, promesasError } = useInboxEsperando(activeStoreId);

  /**
   * Las dos canastas de la bandeja.
   *
   * ── «Sin respuesta» (3-sep-2026) ──────────────────────────────────────────
   * Pedido del dueño: *"tengo un supervisor que manda plantillas con el botón
   * en automático, hace un solo intento y no está pendiente si respondieron"*.
   * Eso no aparecía en ninguna pantalla del CRM: la bandeja mira quién nos
   * escribió a NOSOTROS, y a esta gente le escribimos nosotros.
   *
   * Van como dos vistas de la misma pantalla y no como dos pantallas: es el
   * mismo trabajo (abrir el chat y escribir) sobre el mismo hilo, y separarlas
   * en rutas obligaría a la asesora a acordarse de visitar la segunda.
   */
  /**
   * ── «El bot prometió» (4-sep-2026) ────────────────────────────────────────
   * La tercera canasta, y la que no miraba nadie. Las otras dos se preguntan
   * quién habló último; acá el último mensaje es NUESTRO —el bot dijo «en un
   * momento le comparto su guía» o «déjeme verificar y le confirmo por aquí»—
   * y la persona prometida nunca llegó. Por eso estos clientes no aparecían en
   * ninguna lista del CRM. Una sola noche de Ecuador: 21, uno de ellos pidiendo
   * DUPLICAR su pedido. El detalle, en `src/lib/promesasPendientes.ts`.
   */
  const [vista, setVista] = useState<'esperan' | 'deuda' | 'prometidos'>('esperan');
  const cola = vista === 'esperan' ? esperan : vista === 'deuda' ? sinRespuesta : prometidos;
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

  // Quién tocó cada uno de estos clientes, de todas las pantallas. Los teléfonos
  // se piden en un solo viaje para toda la cola, no una consulta por tarjeta.
  const telefonosCola = useMemo(
    () => cola.map((i) => i.phone).filter(Boolean),
    [cola],
  );
  const { selloDe, estado: estadoSello, miId } = useSelloGestion(activeStoreId, telefonosCola);

  const llamar = (phone: string) => { void recordContacto(phone, 'LLAMADA', 'llamó'); };

  /**
   * ¿Este cliente ya está resuelto? Su última gestión es MÁS NUEVA que su
   * último mensaje.
   *
   * No hay estado nuevo ni columna nueva: sale del sello de gestión que esta
   * pantalla ya lee. Por eso sobrevive a recargar, lo ven las compañeras, y si
   * el cliente vuelve a escribir vuelve a estar esperando — su mensaje pasa a
   * ser más nuevo que la gestión, y la comparación se da vuelta sola.
   *
   * ⛔ Con el sello sin leer (`estadoSello !== 'ok'`) NADIE está resuelto. Dar
   * por resuelto lo que no se pudo medir es la misma buena noticia falsa que
   * esta pantalla ya cometió una vez, celebrando «todos atendidos 🎉» con 39
   * clientes esperando.
   */
  const estaResuelto = useCallback((o: InboxItem): boolean => {
    if (estadoSello !== 'ok') return false;
    const sello = o.phone ? selloDe(o.phone) : null;
    if (!sello) return false;
    const t = Date.parse(sello.createdAt);
    // En la deuda se mide desde NUESTRO último mensaje, y ese envío deja su
    // propio touchpoint casi a la misma hora: se pide una gestión posterior de
    // verdad (2 min de margen), no el sello del mismo envío. Sin esto, la
    // pestaña "Sin respuesta" daba por resuelto a todo el que recibió una
    // plantilla (producción, 3-sep-2026: «174 en la cola · 106 ya resueltos»).
    const margen = vista === 'esperan' ? 0 : 2 * 60_000;
    return Number.isFinite(t) && t > o.esperaDesde + margen;
  }, [estadoSello, selloDe, vista]);

  const marcarResuelto = useCallback(async (o: InboxItem) => {
    if (!o.phone) {
      toast.error('Este pedido no tiene teléfono, así que no puedo dejar la marca.');
      return;
    }
    // `ok` leído (4-sep-2026): `useRecordGestion` nunca lanza, devuelve `{ ok }`.
    // Acá se ignoraba y se cantaba éxito siempre: con la red caída el cliente
    // quedaba sin marca y la asesora veía el toast verde.
    const { ok } = await recordContacto(o.phone, 'SEG', 'Resuelto: no espera respuesta', o.externalId || undefined);
    if (!ok) {
      toast.error('No se pudo dejar la marca. Reintentá.', { description: 'El cliente sigue en la lista tal como estaba.' });
      return;
    }
    toast.success('Marcado como resuelto', {
      description: 'Queda al final de la lista, no se esconde. Si el cliente vuelve a escribir, vuelve a aparecer arriba.',
    });
  }, [recordContacto]);

  /**
   * El buscador. Pedido del dueño: *"que en el inbox puedan buscar también
   * números y chat"*.
   *
   * Busca por nombre, teléfono, número de pedido, producto y ciudad — el
   * teléfono además sin separadores, porque nadie lo escribe con guiones. Es
   * un filtro de VISTA: el encabezado sigue contando la cola completa, así que
   * buscar nunca hace parecer que hay menos trabajo del que hay.
   */
  const [busca, setBusca] = useState('');

  /**
   * La lista que se dibuja: filtrada por el buscador y con los resueltos al
   * FINAL, nunca fuera.
   *
   * ⛔ `sort` sobre una copia. Ordenar el array que viene del hook lo mutaría
   * en su sitio y el próximo render partiría de un orden distinto al que el
   * hook cree tener.
   */
  const items = useMemo(() => {
    const filtrados = busca.trim()
      ? cola.filter((o) => matchesQuery(
          [o.nombre, o.phone, o.phone?.replace(/\D/g, ''), o.externalId, o.producto, o.ciudad],
          busca,
        ))
      : cola;
    const resueltos = new Set(filtrados.filter(estaResuelto).map((o) => o.dbId));
    if (resueltos.size === 0) return filtrados;
    return [...filtrados].sort(
      (a, b) => Number(resueltos.has(a.dbId)) - Number(resueltos.has(b.dbId)),
    );
  }, [cola, busca, estaResuelto]);

  /** Cuántos de la cola COMPLETA están resueltos. Sobre `cola`, no sobre lo
   *  filtrado: el encabezado cuenta el trabajo real, no lo que dejó ver el
   *  buscador. */
  const cuantosResueltos = useMemo(() => cola.filter(estaResuelto).length, [cola, estaResuelto]);

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

  // En pantalla ancha la conversación se abre AL LADO de la cola, sin el cuadro
  // modal — así que el candado que pone el diálogo no corre. Se marca acá: el
  // cliente que estoy atendiendo queda tomado mientras lo tenga seleccionado, y
  // se suelta solo al pasar al siguiente.
  useAtencionPedido(sel?.dbId ?? null, Boolean(ancha && sel));
  // Bitácora de lo que está a la vista (ver CallView): la bandeja tampoco
  // dejaba rastro de "abrió el chat y pasó al siguiente".
  usePedidoALaVista(sel ? { externalId: sel.externalId, phone: sel.phone } : null);

  // ¿El feed del canal podría estar caído? Si el sync falla o lleva mucho sin
  // correr, esta lista puede estar INCOMPLETA — y un "Nadie esperando" en verde
  // sobre un feed muerto es una mentira tranquilizadora (hallazgo P1).
  // ⛔ `never` TAMBIÉN es dudoso. "El sync nunca corrió" no es una razón para
  // confiar en la lista: es la razón más fuerte para desconfiar.
  // `canal != null`: mientras el canal no se resolvió, `sourceSyncChat(null)`
  // apunta a importchat-sync y en Colombia eso es `never` → un destello del
  // banner rojo "el sync de ImporChat falla" en cada entrada (revisión 3-sep).
  const feedDudoso = canal != null && (salud.data?.status === 'failing'
    || salud.data?.status === 'critical'
    || salud.data?.status === 'never');

  // Cuántos llevan más de un día. Es el número que dice si la cola se está
  // trabajando o solo se está mirando — y no se puede leer de un vistazo
  // contando tarjetas.
  // ⛔ Sobre `cola`, NO sobre `items`. `items` es lo que quedo despues del
  // buscador: contar ahi haria que escribir un nombre en la busqueda bajara
  // el numero de "llevan mas de un dia" — la cola pareceria mejor de lo que
  // esta por haber tecleado algo. Esconder trabajo esta prohibido.
  const masDeUnDia = useMemo(
    () => cola.filter((i) => Date.now() - i.esperaDesde >= 86_400_000).length,
    [cola],
  );


  return (
    // ⛔ `overflow-x-hidden` y `w-full`: la red de seguridad del desborde. Si
    // alguna vez vuelve a colarse un hijo que no se deja achicar, esta pantalla
    // recorta en vez de empujar el ancho de TODA la app y obligar a scrollear de
    // lado para encontrar la barra lateral.
    <div className={`w-full min-w-0 overflow-x-hidden ${ancha ? 'max-w-[1500px] mx-auto' : 'max-w-3xl mx-auto'}`}>
      {/* BARRA DE TURNO (rediseño Fase 3, 4-sep-2026): título, conteos,
          pestañas y buscador en UNA fila que se envuelve; la explicación baja a
          una línea de 12 px. Antes eran cinco renglones (cejilla, título de
          24 px, párrafo, pestañas, buscador) y la primera persona esperando
          aparecía a 300 px del borde. Mismo molde que Seguimiento y Confirmar. */}
      <header className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-lg font-bold tracking-tight text-foreground flex items-center gap-2.5 flex-wrap leading-none">
          <span className="w-8 h-8 rounded-lg bg-accent/14 border border-accent/30 text-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
            <Inbox size={16} strokeWidth={2.25} />
          </span>
          Escribieron
          {esperan.length > 0 && (
            <span className="text-[13px] font-mono tabular-nums px-2 py-0.5 rounded-full bg-danger/14 border border-danger/30 text-danger">
              {esperan.length}
            </span>
          )}
          {vista === 'esperan' && masDeUnDia > 0 && (
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-danger/10 border border-danger/30 text-danger">
              {masDeUnDia} {masDeUnDia === 1 ? 'lleva' : 'llevan'} más de un día
            </span>
          )}
        </h1>

        {/* Las dos canastas. La segunda solo aparece cuando hay alguien: una
            pestaña vacía permanente enseña a no mirar ninguna de las dos. */}
        {(sinRespuesta.length > 0 || prometidos.length > 0 || vista !== 'esperan' || deudaError || promesasError) && (
          <div className="inline-flex rounded-xl border border-border bg-surface p-0.5">
            <button
              type="button"
              onClick={() => { setVista('esperan'); setSelId(null); }}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors ${
                vista === 'esperan' ? 'bg-accent/18 text-accent' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Nos escribieron
              <span className="ml-1.5 font-mono tabular-nums">{esperan.length}</span>
            </button>
            <button
              type="button"
              onClick={() => { setVista('deuda'); setSelId(null); }}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors ${
                vista === 'deuda' ? 'bg-warning/18 text-warning' : 'text-muted-foreground hover:text-foreground'
              }`}
              title="Les escribimos y no contestaron. Falta el segundo intento."
            >
              Sin respuesta
              <span className="ml-1.5 font-mono tabular-nums">{sinRespuesta.length}</span>
            </button>
            {(prometidos.length > 0 || vista === 'prometidos' || promesasError) && (
              <button
                type="button"
                onClick={() => { setVista('prometidos'); setSelId(null); }}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors ${
                  vista === 'prometidos' ? 'bg-danger/18 text-danger' : 'text-muted-foreground hover:text-foreground'
                }`}
                title="El bot les dijo que una persona les escribe, y esa persona todavía no llegó."
              >
                El bot prometió
                <span className="ml-1.5 font-mono tabular-nums">{prometidos.length}</span>
              </button>
            )}
          </div>
        )}
        {/* ⛔ Acá había otro `ImporchatSyncBadge`. Desde el 28-ago-2026 el badge
            vive en `ProtectedLayout`, al lado del de Dropi, para que se vea
            también en Confirmar y Seguimiento. El banner rojo de abajo, que es
            propio de este listado, no se toca. */}

        {/* Buscador. Pedido del dueño: *"que en el inbox puedan buscar también
            números y chat"*. Busca por nombre, teléfono (con y sin guiones),
            número de pedido, producto y ciudad.

            ⛔ Es un filtro de VISTA. La línea de abajo sigue contando la cola
            COMPLETA, para que buscar nunca haga parecer que hay menos trabajo
            del que hay — que es exactamente lo prohibido. */}
        {(cola.length > 0 || busca) && (
          <div className="flex flex-1 min-w-[16rem] flex-wrap items-center gap-x-3 gap-y-2">
            <div className="relative min-w-0 flex-1 max-w-md">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input
                type="search"
                aria-label="Buscar en la bandeja por nombre, teléfono o número de pedido"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar por nombre, teléfono o número de pedido…"
                className="w-full h-9 rounded-xl border border-border bg-surface pl-9 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </div>
            <span className="text-[11px] text-muted-foreground">
              {busca.trim() && (
                <>
                  <span className="font-mono tabular-nums font-semibold text-foreground">{items.length}</span>
                  {' '}de{' '}
                </>
              )}
              <span className="font-mono tabular-nums font-semibold text-foreground">{cola.length}</span>
              {' '}en la cola
              {cuantosResueltos > 0 && (
                <> · <span className="font-mono tabular-nums text-success">{cuantosResueltos}</span>{' '}
                  ya resuelto{cuantosResueltos === 1 ? '' : 's'}
                </>
              )}
            </span>
          </div>
        )}
        {/* La explicación de la canasta, en UNA línea de 12 px debajo de la
            barra (antes era un párrafo de 14 px). El texto es el mismo. */}
        <p className="basis-full text-xs text-muted-foreground truncate" title={vista === 'esperan'
          ? 'Clientes que escribieron y nadie contestó todavía. El de arriba es el que lleva más esperando — a ninguno se lo deja enfriar.'
          : `Les escribimos y no contestaron hace más de ${HORAS_SIN_RESPUESTA} horas. Acá va el 2º intento: mandar una plantilla y no volver a mirar no es haber gestionado.`}
        >
          {vista === 'esperan'
            ? 'Clientes que escribieron y nadie contestó todavía. El de arriba es el que lleva más esperando — a ninguno se lo deja enfriar.'
            : `Les escribimos y no contestaron hace más de ${HORAS_SIN_RESPUESTA} horas. Acá va el 2º intento: mandar una plantilla y no volver a mirar no es haber gestionado.`}
        </p>
      </header>

      {feedDudoso && (
        <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {/* Colgarse y fallar no son lo mismo (mismo criterio que el badge): si las
                últimas corridas cerraron bien pero alguna de antes quedó colgada, decir
                «está fallando» manda a buscar un error que no existe (4-sep-2026). */}
            {(salud.data?.colgadas ?? 0) > 0
              ? `El sync de ${canalNombre} se colgó en ${salud.data!.colgadas} de las últimas ${salud.data!.corridasVistas} corridas — en esas ventanas el WhatsApp del cliente no entró y esta lista puede estar`
              : `El sync de ${canalNombre} está fallando o lleva mucho sin correr — esta lista puede estar`}
            <strong> incompleta</strong>. Si dice "nadie esperando", puede que sí haya clientes esperando.
            Avisá para revisar la conexión.
          </span>
        </div>
      )}

      {status === 'cargando' && (
        <div role="status" aria-live="polite" className="flex items-center justify-center py-16 text-muted-foreground text-sm">
          <Loader2 size={16} className="animate-spin mr-2" aria-hidden="true" /> Leyendo quién escribió…
        </div>
      )}

      {status === 'error' && (
        <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          No se pudo leer la bandeja ahora mismo. Reintentá en un momento.
        </div>
      )}

      {status === 'not_ready' && (
        <div role="status" className="rounded-2xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          La bandeja se prende cuando {canalNombre} esté configurado en esta tienda.
        </div>
      )}

      {status === 'sin_medir' && (
        <div role="status" className="rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          <p className="font-semibold">Todavía no puedo medir quién está esperando en esta tienda.</p>
          <p className="text-xs mt-1 opacity-90">
            Ningún pedido tiene registrada la actividad del chat, así que esta lista estaría vacía
            aunque hubiera clientes esperando. <strong>No quiere decir que no haya nadie.</strong>{' '}
            Mirá {canalNombre} directamente hasta que la sincronización esté corriendo.
          </p>
        </div>
      )}

      {/* ⛔ Buscar y no encontrar NO es "no hay nadie esperando". Sin esta rama,
          escribir un teléfono que no está en la cola dibujaba el cartel verde de
          "todos atendidos 🎉" sobre una cola llena — el error que esta pantalla
          ya cometió una vez de verdad, con 39 clientes esperando. */}
      {status === 'ok' && items.length === 0 && busca.trim() && (
        <div className="flex flex-col items-center justify-center py-16 gap-2 text-center">
          <p className="text-sm font-semibold text-foreground">Nadie con «{busca.trim()}»</p>
          <p className="text-xs text-muted-foreground">
            Hay <span className="font-mono tabular-nums">{cola.length}</span> en la cola; ninguno coincide.
          </p>
          <button
            type="button"
            onClick={() => setBusca('')}
            className="mt-1 text-[11px] font-semibold text-accent hover:underline"
          >
            Ver la cola completa
          </button>
        </div>
      )}

      {/* ⛔ La canasta de deuda falló al leerse: NO se celebra un cero sobre
          una consulta caída (4-sep-2026). Es el incidente de Colombia otra vez
          — 39 clientes esperando y «todos atendidos 🎉» — en la misma pantalla. */}
      {((vista === 'deuda' && deudaError) || (vista === 'prometidos' && promesasError)) && (
        <div className="rounded-2xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
          No se pudo leer esta lista ahora mismo. No quiere decir que nadie haya quedado sin respuesta: reintentá en un momento.
        </div>
      )}
      {status === 'ok' && items.length === 0 && !busca.trim()
        && !(vista === 'deuda' && deudaError) && !(vista === 'prometidos' && promesasError) && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <span className="w-12 h-12 rounded-2xl bg-success/14 border border-success/30 text-success flex items-center justify-center" aria-hidden="true">
            <CheckCircle2 size={24} />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">
              {vista === 'esperan' ? 'Nadie esperando respuesta'
                : vista === 'deuda' ? 'Nadie quedó sin respuesta'
                : 'Ninguna promesa del bot quedó colgada'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {vista === 'esperan'
                ? 'Todos los que escribieron ya fueron atendidos.'
                : vista === 'deuda'
                ? `A todos los que les escribimos hace más de ${HORAS_SIN_RESPUESTA} horas ya les contestaron.`
                : 'Cuando el bot diga que una persona le escribe y esa persona no llegue, aparece acá.'}
            </p>
          </div>
        </div>
      )}

      {/* ── ANCHA: cola · conversación · ficha, dentro de UN marco ────────────
          Tres paneles pegados con divisorias, no tres tarjetas flotando: es lo
          que hace que se lea como una bandeja de chat y no como un listado con
          un anexo. Cada panel scrollea por dentro.

          ⛔ TODAS las columnas van `minmax(0,…)`. El valor por defecto de una
          columna de grid es `min-width:auto`, o sea "no me achico por debajo de
          mi contenido" — y con eso una dirección larga o una burbuja de chat
          ancha empujan la columna, la columna empuja el grid y el grid empuja la
          página entera. Pasó en producción el 3-sep-2026: la pantalla se
          desbordó a lo ancho y había que scrollear de lado para ver el menú. */}
      {status === 'ok' && items.length > 0 && ancha && (
        <div className="grid min-w-0 grid-cols-[minmax(0,300px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,320px)_minmax(0,1fr)_minmax(0,272px)] rounded-xl border border-border bg-surface overflow-hidden">

          {/* 1 · LA COLA */}
          <div className="min-w-0 flex flex-col border-r border-border">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border/70 shrink-0">
              <Inbox size={12} className="text-muted-foreground" aria-hidden="true" />
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Esperando</span>
              <span className="ml-auto text-[11px] font-mono tabular-nums font-bold text-danger">{items.length}</span>
            </div>
            {/* Alto = lo que queda de pantalla debajo de la cabecera (no un 70 %
                fijo): en una pantalla de 900 px eso son dos clientes más a la
                vista. Mínimo 320 px para que en pantallas bajas siga habiendo lista. */}
            <div className="overflow-y-auto max-h-[max(320px,calc(100dvh-15rem))] divide-y divide-border/50" role="list">
              {items.map((o) => (
                <FilaCola
                  key={o.dbId}
                  o={o}
                  seleccionada={o.dbId === selId}
                  onSelect={() => setSelId(o.dbId)}
                  sello={selloDe(o.phone)}
                  estadoSello={estadoSello}
                  miId={miId}
                  resuelto={estaResuelto(o)}
                />
              ))}
            </div>
          </div>

          {/* 2 · LA CONVERSACIÓN */}
          <div className="min-w-0 flex flex-col">
            {sel ? (
              <>
                <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border/70 min-w-0 shrink-0">
                  <span className="w-9 h-9 shrink-0 rounded-full bg-accent/15 border border-accent/30 text-accent flex items-center justify-center text-[11px] font-bold" aria-hidden="true">
                    {iniciales(sel.nombre)}
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-sm font-bold text-foreground truncate">{sel.nombre}</h2>
                    <div className="text-[11px] text-muted-foreground font-mono tabular-nums">{formatPhone(sel.phone)}</div>
                  </div>
                  <span className="ml-auto shrink-0 flex items-center gap-2">
                    <SelloGestion sello={selloDe(sel.phone)} estado={estadoSello} miId={miId} />
                    <span className="pill pill-neutral text-[11px] max-w-[14rem]">
                      <span className="truncate">{sel.estado || '—'}</span>
                    </span>
                  </span>
                </div>

                {/* El contexto mínimo también acá, porque la ficha de la derecha
                    no existe por debajo de 1280 px y "¿dónde va mi paquete?" es
                    LA pregunta que hay que poder contestar sin cambiar de
                    pantalla. */}
                <div className="xl:hidden flex flex-wrap gap-x-3 gap-y-1 px-4 py-2 border-b border-border/70 text-[11px] text-muted-foreground min-w-0 shrink-0">
                  {sel.producto && <span className="truncate max-w-full">{sel.producto}</span>}
                  {sel.ciudad && <span>· {sel.ciudad}</span>}
                  {sel.valor ? <span className="font-mono tabular-nums font-semibold text-foreground">· {formatCOP(sel.valor)}</span> : null}
                  {sel.transportadora && <span>· {sel.transportadora}</span>}
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
                    altoChat="min-h-[220px] max-h-[42vh]"
                    className="p-3 gap-2.5 min-w-0"
                  />
                ) : (
                  <p className="p-4 text-xs text-muted-foreground">
                    Este pedido no tiene número de orden, así que no se puede abrir su conversación desde acá.
                  </p>
                )}

                <Acciones o={sel} cc={cc} onLlamar={llamar} onResolver={marcarResuelto} resuelto={estaResuelto(sel)} className="px-4 pb-4 pt-0" />
              </>
            ) : (
              <div className="p-10 text-center text-sm text-muted-foreground">
                Elegí a alguien de la lista para leer lo que escribió.
              </div>
            )}
          </div>

          {/* 3 · LA FICHA DEL PEDIDO (desde 1280 px) */}
          <aside className="hidden xl:flex min-w-0 flex-col border-l border-border">
            <div className="px-3 py-2 border-b border-border/70 shrink-0">
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Su pedido</span>
            </div>
            {/* Ficha en DOS columnas (rediseño, 4-sep-2026): los datos cortos
                —valor, ciudad, guía, teléfono— se leen de a pares; producto y
                dirección van a lo ancho porque son texto largo. Antes cada dato
                ocupaba un renglón propio y la ficha medía 460 px. */}
            {sel ? (
              <div className="overflow-y-auto max-h-[70vh] p-3 grid grid-cols-2 gap-x-3 gap-y-2.5 min-w-0">
                <Dato etiqueta="Producto" ancho>{sel.producto || '—'}</Dato>
                <Dato etiqueta="Valor">
                  <span className="font-mono tabular-nums font-semibold">{sel.valor ? formatCOP(sel.valor) : '—'}</span>
                </Dato>
                <Dato etiqueta="Ciudad">{sel.ciudad || '—'}</Dato>
                <Dato etiqueta="Dirección" ancho>{sel.direccion || '—'}</Dato>
                <Dato etiqueta="Transportadora">{sel.transportadora || '—'}</Dato>
                <Dato etiqueta="Guía">
                  <span className="font-mono tabular-nums">{sel.guia || '—'}</span>
                </Dato>
                <Dato etiqueta="Estado" ancho>
                  {sel.estado || '—'}
                  {sel.diasEnEstado != null && (
                    <span className="text-muted-foreground"> · {sel.diasEnEstado} {sel.diasEnEstado === 1 ? 'día' : 'días'} así</span>
                  )}
                </Dato>
                <Dato etiqueta="Teléfono">
                  <span className="font-mono tabular-nums">{formatPhone(sel.phone)}</span>
                </Dato>
                {sel.externalId && (
                  <Link
                    to={`/pedido/${sel.externalId}`}
                    className="col-span-2 mt-1 text-[11px] font-semibold text-accent hover:underline"
                  >
                    Abrir el pedido #{sel.externalId} →
                  </Link>
                )}
              </div>
            ) : (
              <div className="p-3 text-xs text-muted-foreground">—</div>
            )}
          </aside>
        </div>
      )}

      {/* ── ANGOSTA: la lista de siempre, con el cuadro modal ───────────────── */}
      {status === 'ok' && items.length > 0 && !ancha && (
        <div className="flex flex-col gap-2.5 min-w-0">
          {items.map((o) => (
            <TarjetaLista key={o.dbId} o={o} sello={selloDe(o.phone)} estadoSello={estadoSello} miId={miId}>
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
                <Acciones o={o} cc={cc} onLlamar={llamar} onResolver={marcarResuelto} resuelto={estaResuelto(o)} plano />
              </div>
            </TarjetaLista>
          ))}
        </div>
      )}

      {abierto && abierto.externalId && (
        <EscribirWhatsappDialog
          open={!!abierto}
          onOpenChange={(v) => { if (!v) setAbierto(null); }}
          externalId={String(abierto.externalId)}
          dbId={abierto.dbId}
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
