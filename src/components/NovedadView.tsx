import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useOrders } from '@/contexts/OrderContext';
import { useStore } from '@/contexts/StoreContext';
import { OrderData, formatPhone, getTrackingUrl, getWhatsAppPhone } from '@/lib/orderUtils';
import { formatCOP } from '@/lib/utils';
import { TruncatedText } from '@/components/TruncatedText';
import EscribirWhatsappDialog from '@/components/seguimiento/EscribirWhatsappDialog';
import { useSessionState } from '@/hooks/useSessionState';
import { copyToClipboard } from '@/lib/clipboard';
import { useMarkNovedadResolved } from '@/hooks/useMarkNovedadResolved';
import { useRecordGestion } from '@/hooks/useRecordGestion';
import { NovedadResultTipo } from '@/lib/novedadGestion';
import { AuroraBackdrop } from '@/components/ui3d';
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
  Hash,
  MessageSquare,
  Send,
  X,
} from 'lucide-react';
import FingerprintBadge from '@/components/FingerprintBadge';
import { diasSinMovimiento } from '@/lib/segPulso';
import ChatClienteCard from '@/components/chat/ChatClienteCard';
import SectorSinCoberturaChip from '@/components/SectorSinCoberturaChip';
import { guiaNovedadPorPais, plantillaSolucionPorPais, paisTieneGuia, notasTransportadoraPorPais, reglasTransversalesPorPais, respuestaPublicada, fuenteDeFicha } from '@/lib/novedades/porPais';

interface Props {
  items: OrderData[];
  /** Key de sessionStorage para la posición del carrusel. Cada instancia
   *  simultánea (Por gestionar / Esperando transportadora) necesita la SUYA:
   *  con la key compartida, el re-seed de una instancia pisaba la posición
   *  de la otra y la operadora perdía su lugar en la cola de llamadas. */
  stateKey?: string;
  /** ¿La incidencia está ABIERTA en Dropi? true → los botones envían la
   *  solución a Dropi; false → Dropi ya la cerró y solo se registra acá;
   *  null → no se pudo saber (se intenta Dropi igual). */
  incidenciaAbierta?: boolean | null;
}

/** Tinte de urgencia por antigüedad. Mismos cortes de siempre (7 / 4 días),
 *  ahora con los tonos semánticos del DS en vez de los colores legacy. */
const URGENCIA = {
  danger:  { chip: 'bg-danger/14 border-danger/30 text-danger glow-danger',    dot: 'bg-danger' },
  warning: { chip: 'bg-warning/14 border-warning/30 text-warning glow-warning', dot: 'bg-warning' },
  success: { chip: 'bg-success/14 border-success/30 text-success glow-success', dot: 'bg-success' },
  // Sin fecha de movimiento: no sabemos hace cuánto salió la novedad. Tono neutro
  // a propósito — pintarla verde mentiría "recién", pintarla roja mentiría "vieja".
  neutral: { chip: 'bg-muted/40 border-border text-muted-foreground', dot: 'bg-muted-foreground' },
} as const;

export default function NovedadView({ items, stateKey = 'novedades:callOrderId', incidenciaAbierta = null }: Props) {
  const { loadNovedades } = useOrders();
  const { markNovedad } = useMarkNovedadResolved();
  const recordContacto = useRecordGestion();
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
  // Último rechazo de Dropi para ESTE pedido: se muestra tal cual y habilita
  // «registrar solo acá» como salida explícita (nunca automática).
  const [dropiRechazo, setDropiRechazo] = useState<string | null>(null);
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
  // Borrador de solución según la guía OFICIAL de Dropi para esa transportadora
  // y esa novedad (hojas «Estados y Novedades»): con el teléfono del pedido
  // puesto y huecos para lo que acordó la asesora. Solo Ecuador. Nunca se
  // envía solo: la asesora lo completa — «solo VOLVER A OFRECER» es solución
  // no efectiva para Dropi.
  // Multi-país (30-ago-2026): la ficha y el borrador salen del registro por
  // país (`novedades/porPais.ts`). Ecuador tiene las hojas oficiales; los demás
  // países reciben la plantilla genérica de Dropi y NUNCA la ficha ecuatoriana
  // «por parecida». El envío a Dropi ya era multi-país (host por country_code).
  const pais = activeStore?.country_code;
  const guiaActual = o ? guiaNovedadPorPais(pais, o.novedad, o.transportadora) : null;
  const plantilla = o ? plantillaSolucionPorPais(pais, guiaActual, { phone: o.phone, nombre: o.nombre, direccion: o.direccion }, o.transportadora) : null;
  const notasCarrier = o ? notasTransportadoraPorPais(pais, o.transportadora) : null;
  const reglasDropi = reglasTransversalesPorPais(pais);
  const maxSolucion = plantilla?.maximo ?? 500;

  // Reset local state when the current order changes
  useEffect(() => {
    setSolution('');
    setShowReturnConfirm(false);
    setSubmitting(false);
  }, [o?.dbId]);

  // ⛔ ARRIBA del early-return. Estaba más abajo y violaba las reglas de hooks:
  // con la cola de Novedades vacía el componente toma el camino corto y corre
  // menos hooks → React #300/#310 y la pantalla se cae. Mismo bug que tumbó
  // Confirmar (reportado por Colombia el 25-ago). El cuadro de escribir no
  // depende de que haya novedad en pantalla.
  const [escribiendo, setEscribiendo] = useState(false);

  if (!visibleItems.length || !o) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
        <span className="w-12 h-12 rounded-2xl bg-success/14 border border-success/30 text-success glow-success flex items-center justify-center" aria-hidden="true">
          <CheckCircle2 size={24} />
        </span>
        <div>
          <p className="text-sm font-semibold text-foreground">No hay novedades pendientes</p>
          <p className="text-xs text-muted-foreground mt-1">Todas las novedades están resueltas 🎉</p>
        </div>
      </div>
    );
  }

  // Edad de la NOVEDAD (días desde el último movimiento en Dropi), NO edad del
  // pedido. Antes mostraba `o.dias` = días desde que se CREÓ el pedido: una
  // novedad de ayer sobre un pedido viejo salía "D12 crítica" y el dueño regañó
  // al equipo por una demora inexistente. `null` = sin fecha de movimiento: no
  // se sabe hace cuánto, así que ni se pinta rojo ni verde (no saber ≠ tranquilo).
  const diasNovedad = diasSinMovimiento(o);
  const urgKey = diasNovedad == null ? 'neutral' : diasNovedad >= 7 ? 'danger' : diasNovedad >= 4 ? 'warning' : 'success';
  const urg = URGENCIA[urgKey];

  const copyPhone = () => {
    void copyToClipboard(o.phone, `${o.phone} copiado`);
  };

  // El panel de novedades de Dropi lista por ID de pedido: copiarlo con un
  // click es el puente del workflow manual CRM ↔ panel (mismo patrón que
  // copyPhone).
  const copyExternalId = () => {
    if (o.externalId) void copyToClipboard(o.externalId, `ID ${o.externalId} copiado`);
  };

  // ⛔ Acá había un `wa.me` (25-ago-2026). Abría una conversación NUEVA desde el
  // WhatsApp de quien apretara el botón: **partía el hilo del cliente en dos**,
  // el mensaje no quedaba en ImporChat ni en Guardian, y el contacto se
  // registraba por DECLARACIÓN ("abrió WhatsApp"), sin saber si se escribió
  // algo. Ahora abre el chat de Guardian: mismo hilo de siempre, queda el
  // nombre de quien escribió, y la gestión se registra sola y VERIFICADA
  // (`importchat-send` relee el chat antes de darla por hecha).
  // (`escribiendo` se declara ARRIBA del early-return — ver la nota del crash.)

  const navCall = (dir: number) => {
    const target = visibleItems[Math.max(0, Math.min(visibleItems.length - 1, callIdx + dir))];
    if (target) { setCallOrderId(keyOf(target)); setDropiRechazo(null); }
  };

  // Gestión de la novedad (29-ago-2026: los botones VUELVEN a hablar con Dropi).
  //  - incidencia abierta (o desconocida): Resuelta/Devolución van a Dropi con
  //    la nota como solución; solo si Dropi acepta la card se descarta.
  //  - incidencia cerrada por la transportadora: Dropi la rechaza siempre →
  //    registro local, como antes.
  //  - sin respuesta: registra el intento y avanza (la novedad sigue en cola).
  const doMark = async (tipo: NovedadResultTipo, forzarLocal = false) => {
    if (!o || submitting) return;
    setSubmitting(true);
    try {
      const r = await markNovedad(
        o,
        tipo,
        tipo === 'resuelta' ? solution : undefined,
        { dropi: !forzarLocal && incidenciaAbierta !== false },
      );
      if (r.dropi === 'rechazado' || r.dropi === 'sin_red') setDropiRechazo(r.mensaje || 'sin detalle');
      if (!r.ok) return;
      setDropiRechazo(null);
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

  // countryCode explícito: sin él, tras F5 directo en /novedades el módulo de
  // tracking arranca en 'CO' (el useEffect de StoreContext.setTrackingCountry
  // corre post-paint) y el primer render no resuelve GINTRACOM/LAAR/Serv-EC.
  const trackUrl = o.guia ? getTrackingUrl(o.transportadora, o.guia, countryCode) : null;

  const navBtn = 'min-h-11 min-w-11 justify-center px-3 rounded-xl bg-card/40 border border-border text-muted-foreground text-xs font-semibold disabled:opacity-30 inline-flex items-center hover:text-foreground hover:border-border-strong transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

  return (
    <>
      {/* Persistent "currently attending" chip + navegación, en UNA sola fila
          (mockup Novedades3DBody.dc.html:46) — survives tab switches */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="pill pill-warning inline-flex min-w-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs">
          <AlertTriangle size={12} className="shrink-0" aria-hidden="true" />
          <span className="dark:opacity-80">Atendiendo:</span>
          <span className="font-semibold truncate">{o.nombre}</span>
          <span className="dark:opacity-60">·</span>
          <span className="font-mono tabular-nums">{formatPhone(o.phone)}</span>
        </span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground font-mono tabular-nums">{callIdx + 1} / {visibleItems.length}</span>
          <div className="flex gap-1.5">
            <button
              onClick={() => navCall(-1)}
              disabled={callIdx <= 0 || submitting}
              aria-label="Anterior"
              className={navBtn}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
            <button
              onClick={() => navCall(1)}
              disabled={submitting}
              aria-label="Siguiente"
              className={navBtn}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <div className="hairline-top relative overflow-hidden bg-card/40 border border-border-strong rounded-3xl p-5 mb-4 shadow-card3d-lg flex flex-col gap-[22px] lg:flex-row lg:flex-wrap">
        <AuroraBackdrop />
        {/* Columna A: datos del cliente (mockup: flex 1 1 340px). Apilada en
            móvil, lado a lado desde lg — las asesoras entran desde el celular. */}
        <div className="relative flex flex-col gap-3.5 lg:flex-1 lg:basis-[340px] lg:min-w-[280px]">
        {/* Header: badges */}
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-bold ${urg.chip}`}
            title={diasNovedad == null
              ? 'Sin fecha de movimiento en Dropi — no se sabe hace cuánto salió la novedad'
              : `Hace ${diasNovedad} día${diasNovedad === 1 ? '' : 's'} sin movimiento en Dropi (edad de la novedad, no del pedido)`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${urg.dot}`} aria-hidden="true" />
            <span className="font-mono tabular-nums">{diasNovedad == null ? 'D—' : `D${diasNovedad}`}</span>
          </span>
          <span className="pill pill-neutral text-[10px] px-2 py-0.5 rounded-full font-semibold">{o.estado}</span>
          {o.transportadora && (
            <span className="pill pill-info text-[10px] px-2 py-0.5 rounded-full font-semibold">
              <Truck size={10} className="inline mr-1" aria-hidden="true" />
              {o.transportadora}
            </span>
          )}
        </div>

        {/* Dropi fingerprint */}
        <div><FingerprintBadge phone={o.phone} /></div>

        {/* Customer name */}
        <div className="text-xl font-bold text-foreground">{o.nombre}</div>

        {/* Contact + location line */}
        <div className="text-sm text-muted-foreground leading-relaxed space-y-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Phone size={12} aria-hidden="true" />
            <button onClick={copyPhone} className="text-cyan font-mono tabular-nums hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none rounded">{formatPhone(o.phone)}</button>
            <a
              href={'tel:+' + getWhatsAppPhone(o.phone, countryCode)}
              onClick={() => void recordContacto(o.phone, 'LLAMADA', 'llamó')}
              className="pill pill-info ml-1 inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full no-underline transition-colors hover:brightness-110"
            >
              <Phone size={10} aria-hidden="true" /> Llamar
            </a>
            {o.externalId && (
              <button
                type="button"
                onClick={() => setEscribiendo(true)}
                title="Ver la conversación y escribirle sin salir de Guardian"
                className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-[#25D366]/10 text-success border border-[#25D366]/25 hover:bg-[#25D366]/20 transition-colors"
              >
                <MessageSquare size={10} aria-hidden="true" /> WhatsApp
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <MapPin size={12} aria-hidden="true" /> {o.ciudad || '—'}{o.departamento ? `, ${o.departamento}` : ''}
          </div>
          <div className="flex items-start gap-1.5">
            <Package size={12} className="mt-0.5" aria-hidden="true" />
            <span className="flex-1">{o.producto || '—'}{o.cantidad > 1 ? ` × ${o.cantidad}` : ''}</span>
            {o.valor > 0 && (
              <span className="inline-flex items-center gap-1 font-mono tabular-nums font-bold text-foreground">
                <DollarSign size={12} aria-hidden="true" />{formatCOP(o.valor)}
              </span>
            )}
          </div>
          {o.direccion && (
            <div className="flex items-start gap-1.5 text-xs">
              <MapPin size={12} className="mt-0.5 text-muted-foreground/60" aria-hidden="true" />
              <span className="flex-1 text-muted-foreground">{o.direccion}</span>
            </div>
          )}
          {/* ID Dropi visible + copiable + link al detalle: el workflow vigente
              obliga a resolver cada novedad en el panel de Dropi (que lista por
              ID de pedido) y volver acá a registrar — sin el ID a la vista la
              operadora cruzaba los dos sistemas buscando por nombre, con
              homónimos y tildes distintas. */}
          {o.externalId && (
            <div className="text-xs flex items-center gap-1.5 flex-wrap">
              <Hash size={12} aria-hidden="true" /> ID Dropi:{' '}
              <button
                onClick={copyExternalId}
                title="Copiar ID"
                className="text-cyan font-mono tabular-nums hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none rounded"
              >
                {o.externalId}
              </button>
              {/* Link del router: un <a href> a una ruta interna remonta la SPA
                  y re-descarga Seguimiento/Novedades en cada consulta. */}
              <Link
                to={`/pedido/${o.externalId}`}
                className="text-muted-foreground hover:text-accent hover:underline"
              >
                Ver detalle
              </Link>
            </div>
          )}
          {o.guia && (
            <div className="text-xs inline-flex items-center gap-1.5">
              <Tag size={12} aria-hidden="true" /> Guía:{' '}
              <a
                href={trackUrl || '#'}
                target="_blank"
                rel="noreferrer"
                className="text-cyan font-mono tabular-nums hover:underline"
              >
                {o.guia}
              </a>
            </div>
          )}
        </div>

        {/* Novedad banner — molde de aviso del DS: barra lateral de color pleno
            + chip de ícono, para que el motivo del carrier no se lea como una
            caja gris más. */}
        {o.novedad && (
          <div className="relative flex items-start gap-3 rounded-2xl border border-attention/30 bg-attention/10 px-4 pl-5 py-3 shadow-card3d">
            <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-attention" aria-hidden="true" />
            <span className="w-9 h-9 rounded-xl bg-attention/20 flex items-center justify-center flex-shrink-0 text-attention" aria-hidden="true">
              <AlertTriangle size={17} />
            </span>
            <div className="flex-1 min-w-0">
              {/* Sin `hud-label`: acá adentro va el nombre de la transportadora
                  (dato de Dropi) y esa utilidad mayusculiza. Se conservan las
                  clases originales, que ya daban este mismo rendering. */}
              <div className="text-[10px] font-bold text-attention uppercase tracking-wide mb-0.5">
                Novedad de {o.transportadora || 'transportadora'}
              </div>
              <div className="text-xs text-foreground leading-relaxed">{o.novedad}</div>
            </div>
          </div>
        )}

        {/* La ficha OFICIAL de Dropi para esa novedad (hoja «Estados y Novedades»
            de cada transportadora, Drive de Dropi ago-2026): qué significa, cómo
            pide Dropi que se responda en su panel y qué NO hacer. Antes esto
            vivía en la memoria de cada asesora. Solo Ecuador (las hojas son de
            EC) y solo si hay una ficha clara — sin ficha no se dibuja nada,
            nunca «la más parecida». */}
        {(() => {
          const guia = guiaActual;
          if (!guia) {
            // Sin ficha no se dibuja «la más parecida». Si el país no tiene
            // hojas cargadas se dice, para que nadie crea que Guardian sabe
            // algo que no sabe.
            return o.novedad && !paisTieneGuia(pais) ? (
              <p className="text-[11px] text-muted-foreground px-1">
                Todavía no hay guía oficial de novedades cargada para este país: leé la novedad, hablá con el cliente y respondele a Dropi con el formato de abajo.
              </p>
            ) : null;
          }
          return (
            <div className="rounded-2xl border border-border bg-card/40 px-4 py-3 text-xs space-y-1.5">
              <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                Guía oficial de Dropi · {guia.transportadora} · «{guia.novedad}»
              </div>
              <div><span className="font-semibold text-foreground">Qué significa:</span> {guia.significado}</div>
              {respuestaPublicada(guia) ? (
                <div><span className="font-semibold text-success">Cómo responder en el panel de Dropi:</span> {guia.comoResponder}</div>
              ) : (
                // Dropi publica el significado pero NO la respuesta (Veloces,
                // Interrapidísimo en oficina…): se dice, no se inventa una.
                <div><span className="font-semibold text-warning">Cómo responder:</span> la transportadora no publica una instrucción para esta novedad. Hablá con el cliente y respondé con dirección completa + barrio + referencia, o fecha concreta; nunca «volver a ofrecer» a secas.</div>
              )}
              {guia.queNoHacer && (
                <div><span className="font-semibold text-danger">Qué NO hacer:</span> {guia.queNoHacer}</div>
              )}
              {guia.observaciones && <div className="text-muted-foreground">{guia.observaciones}</div>}
              {fuenteDeFicha(guia) && (
                <div className="text-[10px] text-muted-foreground/80 break-all">Fuente: {fuenteDeFicha(guia)}</div>
              )}
            </div>
          );
        })()}
        {/* Lo que se sabe de la transportadora en este país (oficina, intentos),
            con fuente detrás: sale aunque la novedad no tenga ficha. Solo CO/GT;
            Ecuador lo tiene dentro de sus propias fichas. */}
        {notasCarrier && (notasCarrier.retiroEnOficina || notasCarrier.intentosMax) && (
          <div className="rounded-2xl border border-border bg-card/40 px-4 py-2.5 text-[11px] text-muted-foreground space-y-1">
            <div className="text-[10px] font-bold uppercase tracking-wide">{notasCarrier.nombre}</div>
            {notasCarrier.intentosMax && <div><span className="font-semibold text-foreground">Intentos:</span> {notasCarrier.intentosMax}</div>}
            {notasCarrier.retiroEnOficina && <div><span className="font-semibold text-foreground">Oficina:</span> {notasCarrier.retiroEnOficina}</div>}
          </div>
        )}
        {/* Las reglas transversales de Dropi para el país (Colombia: mecánica
            del panel, los 12 tips, plazos). Plegadas: son largas y son las
            mismas para todas las novedades. */}
        {reglasDropi.length > 0 && (
          <details className="rounded-2xl border border-border bg-card/40 px-4 py-2.5 text-[11px]">
            <summary className="cursor-pointer select-none text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              Cómo pide Dropi que se respondan las novedades ({reglasDropi.length})
            </summary>
            <div className="mt-2 space-y-2">
              {reglasDropi.map((r) => (
                <div key={r.novedad}>
                  <div className="font-semibold text-foreground">{r.novedad}</div>
                  <div className="text-muted-foreground">{r.significado}</div>
                  {r.responder && <div><span className="font-semibold text-success">Qué hacer:</span> {r.responder}</div>}
                  {r.noHacer && <div><span className="font-semibold text-danger">Qué NO hacer:</span> {r.noHacer}</div>}
                  <div className="text-[10px] text-muted-foreground/80 break-all">Fuente: {r.fuente}</div>
                </div>
              ))}
            </div>
          </details>
        )}
        {o.direccion && (
          <SectorSinCoberturaChip direccion={o.direccion} ciudad={o.ciudad} countryCode={activeStore?.country_code} />
        )}

        {/* El WhatsApp REAL del cliente, a la vista — la asesora ve qué dijo el
            cliente sobre la novedad (dónde está, si quiere reprogramar) SIN salir
            a ImporChat, y le responde desde acá mismo. Es la MISMA tarjeta de la
            ficha y de Confirmar (no una copia). Se dibuja sola solo si este pedido
            tiene conversación leída; si no, no existe (nada de una caja vacía). */}
        {o.dbId && o.externalId && (
          <ChatClienteCard
            key={String(o.externalId)}
            externalId={String(o.externalId)}
            orderId={o.dbId}
            nombre={o.nombre}
            estado={o.estado}
            datos={{
              guia: o.guia,
              transportadora: o.transportadora,
              ciudad: o.ciudad,
              producto: o.producto,
              valor: o.valor ? formatCOP(o.valor) : null,
            }}
            modulo="WHATSAPP"
            mostrarSenales
            mostrarEscribir
            altoClase="min-h-[140px] max-h-[280px]"
          />
        )}
        </div>

        {/* Columna B: panel de resolución (mockup: flex 1 1 300px) */}
        <div className="relative flex flex-col gap-3 lg:flex-1 lg:basis-[300px] lg:min-w-[260px] lg:self-start">
        {/* Gestión: marca local (la colaboradora ya resolvió en Dropi). */}
        {submitting ? (
          <div className="text-center py-4 text-sm font-semibold inline-flex items-center gap-2 justify-center w-full text-success">
            <CheckCircle2 size={18} className="animate-pulse" aria-hidden="true" />
            Marcando…
          </div>
        ) : (
          <>
            {/* Solución / nota. SIN flex-1 (30-ago, pedido del dueño): con
                flex-1 el cuadro rellenaba toda la altura de la columna — que
                estira hasta la de la izquierda (huella + pedido + ficha + chat)
                — y salía un textarea de 700 px vacío con los botones perdidos
                al fondo. Ahora mide 5 líneas, con tope, y la asesora lo puede
                estirar a mano (resize-y) si escribe largo. Los botones quedan
                pegados debajo, donde se buscan. */}
            <div className="flex flex-col">
              <label className="block hud-label font-bold text-muted-foreground mb-1.5">
                {incidenciaAbierta !== false
                  ? <>Solución para Dropi <span className="text-muted-foreground/60 normal-case font-normal">(obligatoria en «Resuelta»: es lo que lee la transportadora)</span></>
                  : <>Nota de la gestión <span className="text-muted-foreground/60 normal-case font-normal">(opcional)</span></>}
              </label>
              {plantilla && incidenciaAbierta !== false && (
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSolution(plantilla.texto.slice(0, maxSolucion))}
                    disabled={submitting}
                    className="min-h-9 px-3 rounded-lg border border-success/30 bg-success/10 text-xs font-semibold text-success hover:bg-success/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    {plantilla.origen === 'oficial' ? 'Usar la plantilla oficial de Dropi' : 'Usar plantilla base'}
                  </button>
                  <span className="text-[10px] text-muted-foreground">
                    {plantilla.origen === 'oficial'
                      ? `Formato que pide Dropi para «${guiaActual?.novedad}» en ${guiaActual?.transportadora}. Completá los ____ con lo que acordaste.`
                      : 'Sin ficha oficial para esta novedad: completá los ____ con lo que acordaste con el cliente.'}
                    {maxSolucion < 500 && ` Máximo ${maxSolucion} caracteres (lo exige la transportadora).`}
                  </span>
                </div>
              )}
              <textarea
                value={solution}
                onChange={(e) => setSolution(e.target.value.slice(0, maxSolucion))}
                placeholder={incidenciaAbierta !== false
                  ? 'Ej: Cliente confirma dirección: Mz 5 villa 8, Cdla Los Esteros, frente a la escuela. Recibe mañana 2-5pm, tel. correcto.'
                  : 'Ej: Cliente confirma estar en casa mañana entre 2-5pm.'}
                rows={5}
                disabled={submitting}
                className="w-full min-h-[120px] max-h-[320px] rounded-xl bg-muted/50 border border-border p-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 resize-y disabled:opacity-60 transition-colors"
              />
              <div className="flex justify-end mt-1">
                <span className={`text-[10px] font-mono tabular-nums ${solution.length > maxSolucion * 0.9 ? 'text-attention' : 'text-muted-foreground'}`}>
                  {solution.length}/{maxSolucion}
                </span>
              </div>
            </div>

            {/* 3 resultados: Resuelta / Devolución / Sin respuesta */}
            <div className="grid grid-cols-1 gap-2">
              <button
                onClick={() => doMark('resuelta')}
                disabled={submitting}
                className="inline-flex flex-row items-center justify-center gap-1.5 py-3 min-h-12 w-full rounded-xl bg-gradient-to-br from-success to-success/85 text-success-foreground border border-transparent shadow-[0_8px_22px_-8px_hsl(var(--success)/0.4)] dark:shadow-[0_8px_22px_-8px_hsl(var(--success)/0.9)] font-bold text-xs active:scale-[0.97] transition-transform disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <CheckCircle2 size={16} aria-hidden="true" /> Resuelta
              </button>
              <button
                onClick={() => setShowReturnConfirm(true)}
                disabled={submitting}
                className="inline-flex flex-row items-center justify-center gap-1.5 py-3 min-h-12 w-full rounded-xl bg-danger/14 text-danger border border-danger/30 glow-danger font-bold text-xs active:scale-[0.97] transition-transform disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <Truck size={16} aria-hidden="true" /> Devolución
              </button>
              <button
                onClick={() => doMark('sin_respuesta')}
                disabled={submitting}
                className="inline-flex flex-row items-center justify-center gap-1.5 py-3 min-h-12 w-full rounded-xl bg-muted/50 text-muted-foreground border border-border font-bold text-xs active:scale-[0.97] transition-transform disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <PhoneOff size={16} aria-hidden="true" /> Sin respuesta
              </button>
            </div>
            {/* El modal de Devolución ya recordaba gestionar en Dropi; el botón
                "Resuelta" — el más usado — no avisaba nada y la marca local NO
                empuja a Dropi: sin este recordatorio la incidencia podía vencer
                allá y el paquete devolverse solo. */}
            {dropiRechazo && (
              <div className="rounded-xl border border-danger/30 bg-danger/10 p-2.5 text-[11px] text-danger space-y-1.5" role="alert">
                <div><strong>Dropi no aceptó la solución:</strong> {dropiRechazo}</div>
                <div className="text-muted-foreground">
                  Si ya la resolviste en el panel de Dropi (o la incidencia ya está cerrada allá), podés dejarla registrada solo acá:
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => doMark('resuelta', true)}
                    disabled={submitting}
                    className="min-h-9 px-3 rounded-lg border border-border bg-card/40 text-xs font-semibold text-foreground hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    Registrar resuelta solo acá
                  </button>
                  <button
                    onClick={() => setDropiRechazo(null)}
                    className="min-h-9 px-3 rounded-lg text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    Cerrar
                  </button>
                </div>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground text-center">
              {incidenciaAbierta !== false
                ? <>«Resuelta» y «Devolución» se envían a Dropi con tu solución — la novedad sale de la cola solo si Dropi la acepta.</>
                : <>Dropi ya cerró esta incidencia (no acepta solución): estos botones solo registran acá.</>}
              <br />"Sin respuesta" deja la novedad en la cola para reintentar.
            </p>
          </>
        )}
        </div>
      </div>

      {/* Confirm modal para "Devolución" */}
      {showReturnConfirm && (
        <div
          className="fixed inset-0 bg-black/70 z-[2000] flex items-end justify-center"
          onClick={() => setShowReturnConfirm(false)}
        >
          <div
            className="hairline-top bg-surface border border-border rounded-t-3xl p-6 pb-[calc(24px+env(safe-area-inset-bottom))] w-full max-w-[480px] animate-slide-up shadow-card3d-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-danger/14 border border-danger/30 text-danger glow-danger flex items-center justify-center flex-shrink-0" aria-hidden="true">
                <Truck size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-bold text-foreground">Marcar como devolución</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  La novedad de <strong>{o.nombre}</strong> se marcará como <strong>devolución</strong> y saldrá de la cola. Asegurate de haberla gestionado en Dropi.
                </p>
                {solution.trim() && (
                  <div className="relative mt-3 p-2.5 pl-3.5 rounded-xl bg-warning/10 border border-warning/30 text-[11px] text-warning">
                    <span className="absolute left-0 top-2 bottom-2 w-1 rounded-full bg-warning" aria-hidden="true" />
                    <strong>Aviso:</strong> la nota que escribiste (<em>"<TruncatedText text={solution} maxChars={60} />"</em>) no se guarda en una devolución.
                  </div>
                )}
              </div>
              <button
                onClick={() => setShowReturnConfirm(false)}
                aria-label="Cerrar"
                className="text-muted-foreground hover:text-foreground p-1 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <button
                onClick={() => setShowReturnConfirm(false)}
                className="py-3 rounded-xl bg-muted text-muted-foreground font-semibold text-sm hover:bg-muted/80 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                Cancelar
              </button>
              <button
                onClick={handleDevolucionConfirm}
                className="py-3 rounded-xl bg-danger/14 text-danger border border-danger/30 glow-danger font-bold text-sm active:scale-[0.97] transition-transform focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <Send size={14} className="inline mr-1" aria-hidden="true" /> Sí, devolución
              </button>
            </div>
          </div>
        </div>
      )}

      {/* El hilo real del cliente, sin salir de Novedades. `actividad` no se
          pasa a propósito: acá no se carga la señal sincronizada, así que la
          ventana de 24 h la decide el hilo recién leído — la fuente más fresca
          y la misma que valida el servidor. */}
      {escribiendo && o.externalId && (
        <EscribirWhatsappDialog
          open={escribiendo}
          onOpenChange={setEscribiendo}
          externalId={o.externalId}
          nombre={o.nombre}
          estado={o.estado}
          datos={{
            guia: o.guia,
            transportadora: o.transportadora,
            ciudad: o.ciudad,
            producto: o.producto,
            valor: o.valor ? formatCOP(o.valor) : null,
          }}
        />
      )}
    </>
  );
}
