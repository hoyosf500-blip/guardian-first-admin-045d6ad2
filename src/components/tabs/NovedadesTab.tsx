import { useEffect, useState } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { useAuth } from '@/contexts/AuthContext';
import { isWithinLastDays } from '@/lib/orderUtils';
import { splitNovedades } from '@/lib/novedadesSplit';
import { useOpenIncidences } from '@/hooks/useOpenIncidences';
import { AlertTriangle, RefreshCw, Search, CheckCircle2, Truck, ListChecks, BarChart3, Lightbulb, Target, Clock, ChevronDown, ChevronRight, Info } from 'lucide-react';
import { motion } from 'framer-motion';
import NovedadView from '@/components/NovedadView';
import NovedadesSeguimiento from '@/components/NovedadesSeguimiento';
import NovedadesPuntosMejora from '@/components/novedades/NovedadesPuntosMejora';
import NovedadesCausaRaiz from '@/components/novedades/NovedadesCausaRaiz';
import { useStore } from '@/contexts/StoreContext';
import { useSessionState } from '@/hooks/useSessionState';
import { TiltCard, StatTile, AuroraBackdrop } from '@/components/ui3d';
import { fadeUp, barGradient, ring } from '@/components/novedades/chromeTokens';
import { SEMANTIC_COLORS } from '@/components/logistics/charts/chartTokens';

type NovedadesView = 'pendientes' | 'seguimiento' | 'mejora' | 'causa';

export default function NovedadesTab() {
  const { user } = useAuth();
  const { isManagerOfActive, activeStoreId } = useStore();
  const { novedadesQueue, novedadesLoading, loadNovedades } = useOrders();
  const [search, setSearch] = useState('');
  const [showEsperando, setShowEsperando] = useState(false);
  // Incidencias ABIERTAS según Dropi (misma consulta que su panel de
  // novedades). null = no disponible → no separamos (lista única, como antes).
  const { openIds, reloadOpen } = useOpenIncidences(activeStoreId);
  const [view, setView] = useSessionState<NovedadesView>('novedades:view', 'pendientes');
  // 'causa' (causa raíz) es solo de encargado; si un no-encargado tiene esa vista
  // persistida en sessionState, caemos a 'pendientes'.
  const effectiveView = view === 'causa' && !isManagerOfActive ? 'pendientes' : view;

  useEffect(() => {
    if (user) loadNovedades();
  }, [user, loadNovedades]);

  // Ventana rodante de 60 días: ocultamos novedades cuyo pedido es más viejo que
  // eso. Suelen ser FANTASMAS — el pedido ya se devolvió/cerró en Dropi hace
  // meses pero quedó congelado en estado NOVEDAD acá (sync EC throttleado, ver
  // ec_dropi_throttle_cascade). La asesora ni siquiera puede resolverlas (Dropi
  // las rechaza porque ya no existen ahí). Mismo criterio que Seguimiento.
  const NOVEDAD_WINDOW_DAYS = 60;
  const actionable = novedadesQueue.filter(o =>
    isWithinLastDays(o.fecha, NOVEDAD_WINDOW_DAYS) && (o.dias ?? 0) <= NOVEDAD_WINDOW_DAYS,
  );
  const hiddenOld = novedadesQueue.length - actionable.length;

  // Si cambió la composición de la cola (realtime/cron trajo o sacó una
  // novedad), refrescamos el set de incidencias abiertas para que la nueva no
  // caiga a "Esperando" por datos viejos. reloadOpen tiene un mínimo de 60s
  // interno — esto no martilla a Dropi por cada evento realtime.
  const queueSig = actionable.map(o => o.externalId || o.dbId || '').sort().join('|');
  useEffect(() => {
    if (queueSig) void reloadOpen();
  }, [queueSig, reloadOpen]);

  // "Por gestionar" = incidencia ABIERTA en Dropi (lo que su panel lista);
  // "esperando" = estado NOVEDAD con incidencia cerrada/vencida por la
  // transportadora — sin gestión posible (Dropi rechaza resolverlas).
  const { porGestionar, esperando, conocido } = splitNovedades(actionable, openIds);

  const matchesSearch = (o: (typeof actionable)[number]) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      o.nombre.toLowerCase().includes(s) ||
      o.phone.includes(s) ||
      o.ciudad.toLowerCase().includes(s) ||
      (o.transportadora || '').toLowerCase().includes(s) ||
      (o.novedad || '').toLowerCase().includes(s)
    );
  };
  const filtered = porGestionar.filter(matchesSearch);
  const esperandoFiltered = esperando.filter(matchesSearch);

  const stats = {
    total: porGestionar.length,
    urgentes: porGestionar.filter(o => o.dias >= 7).length,
    warning: porGestionar.filter(o => o.dias >= 4 && o.dias < 7).length,
    carriers: new Set(porGestionar.map(o => o.transportadora).filter(Boolean)).size,
  };

  // El split solo se dibuja cuando Dropi nos dijo qué incidencias siguen
  // abiertas (`conocido`). Sin ese dato el reparto es DESCONOCIDO, no "todo por
  // gestionar" — pintar una barra llena sería inventar una medición.
  const splitTotal = porGestionar.length + esperando.length;
  const showSplit = conocido && splitTotal > 0;

  // Pestañas de vista. 'Causa raíz' solo existe para encargados.
  const VIEWS: { key: NovedadesView; label: string; icon: typeof ListChecks }[] = [
    { key: 'pendientes', label: 'Pendientes', icon: ListChecks },
    { key: 'seguimiento', label: 'Seguimiento', icon: BarChart3 },
    { key: 'mejora', label: 'Mejora', icon: Lightbulb },
    ...(isManagerOfActive ? [{ key: 'causa' as const, label: 'Causa raíz', icon: Target }] : []),
  ];

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header-hero del DS: aurora de fondo, chip de ícono teñido y controles
          a la derecha. */}
      <motion.header
        {...fadeUp(0)}
        className="relative overflow-hidden rounded-3xl border border-border bg-card/40 p-5 shadow-card3d-lg hairline-top flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between mb-5"
      >
        <AuroraBackdrop />
        <div className="relative min-w-0 space-y-1.5">
          <div className="hud-label mb-1 truncate">GESTIÓN · OPERADORA</div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-3">
            <span className="w-11 h-11 rounded-2xl bg-warning/14 border border-warning/30 text-warning glow-warning flex items-center justify-center flex-shrink-0" aria-hidden="true">
              <AlertTriangle size={20} strokeWidth={2.25} />
            </span>
            Novedades
          </h2>
          <p className="text-sm text-muted-foreground">
            Incidencias reportadas por transportadoras — resolución en vivo contra Dropi
          </p>
        </div>
        <div className="relative flex flex-wrap items-center gap-2 shrink-0">
          {/* Segmented control accesible: `role="group"` + `aria-pressed` por
              botón. Antes eran cuatro <button> planos sin rol ni estado — un
              lector de pantalla oía cuatro botones idénticos y quien no
              distingue colores no veía cuál estaba activo. Además del color, el
              activo suma un punto visible (señal no cromática). */}
          <div
            role="group"
            aria-label="Vista de novedades"
            className="inline-flex flex-wrap gap-[2px] p-[3px] rounded-xl bg-card/40 border border-border"
          >
            {VIEWS.map(v => {
              const Icon = v.icon;
              const active = effectiveView === v.key;
              return (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => setView(v.key)}
                  aria-pressed={active}
                  className={`px-4 py-2 rounded-[9px] text-sm flex items-center gap-1.5 transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                    active
                      ? 'font-semibold bg-accent/16 border border-accent/40 text-accent shadow-glow3d'
                      : 'font-medium border border-transparent text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}
                >
                  {active && <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />}
                  <Icon size={13} aria-hidden="true" /> {v.label}
                </button>
              );
            })}
          </div>
          {effectiveView === 'pendientes' && (
            <button
              type="button"
              onClick={() => { loadNovedades(true); void reloadOpen(true); }}
              disabled={novedadesLoading}
              className="px-3 py-2 rounded-xl bg-card/40 border border-border text-muted-foreground text-sm font-medium flex items-center gap-1.5 hover:text-foreground hover:border-border-strong transition-colors duration-200 disabled:opacity-50 cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <RefreshCw size={13} className={novedadesLoading ? 'animate-spin' : ''} aria-hidden="true" />
              Recargar
            </button>
          )}
        </div>
      </motion.header>

      {effectiveView === 'seguimiento' && <NovedadesSeguimiento />}

      {effectiveView === 'mejora' && <NovedadesPuntosMejora />}

      {effectiveView === 'causa' && <NovedadesCausaRaiz />}

      {effectiveView === 'pendientes' && (
       <>
      {/* KPIs — sistema unificado de tonos */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <motion.div {...fadeUp(0.05)}>
          <StatTile icon={ListChecks} label={conocido ? 'Por gestionar' : 'Pendientes'} value={stats.total} tone="accent" />
        </motion.div>
        <motion.div {...fadeUp(0.1)}>
          <StatTile icon={AlertTriangle} label="D7+ críticas" value={stats.urgentes} tone="danger" />
        </motion.div>
        <motion.div {...fadeUp(0.14)}>
          <StatTile icon={Clock} label="D4-6 urgentes" value={stats.warning} tone="warning" />
        </motion.div>
        <motion.div {...fadeUp(0.18)}>
          <StatTile icon={Truck} label="Transportadoras" value={stats.carriers} tone="info" />
        </motion.div>
      </div>

      {/* Reparto de la cola: barra proporcional de "Por gestionar" vs
          "Esperando transportadora". Solo dibuja los DOS conteos que ya se
          muestran; no calcula ninguna métrica nueva. */}
      {showSplit && (
        <motion.div {...fadeUp(0.22)} className="hairline-top bg-card/40 border border-border rounded-2xl p-4 mb-5 shadow-card3d">
          <div className="flex h-2.5 gap-[2px] rounded-full bg-foreground/10 overflow-hidden" aria-hidden="true">
            <div
              className="h-full rounded-full transition-[width] duration-700"
              style={{
                width: `${(porGestionar.length / splitTotal) * 100}%`,
                background: barGradient(SEMANTIC_COLORS.accent),
                boxShadow: `0 0 8px ${ring(SEMANTIC_COLORS.accent, 0.45)}`,
              }}
            />
            <div
              className="h-full rounded-full transition-[width] duration-700"
              style={{
                width: `${(esperando.length / splitTotal) * 100}%`,
                background: barGradient(SEMANTIC_COLORS.info),
                boxShadow: `0 0 8px ${ring(SEMANTIC_COLORS.info, 0.45)}`,
              }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 mt-3">
            <span className="inline-flex items-center gap-2 text-xs min-w-0">
              <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ background: SEMANTIC_COLORS.accent }} aria-hidden="true" />
              <span className="text-muted-foreground truncate">Por gestionar</span>
              <span className="font-mono tabular-nums font-bold text-foreground">{porGestionar.length}</span>
            </span>
            <span className="inline-flex items-center gap-2 text-xs min-w-0">
              <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ background: SEMANTIC_COLORS.info }} aria-hidden="true" />
              <span className="text-muted-foreground truncate">Esperando transportadora</span>
              <span className="font-mono tabular-nums font-bold text-foreground">{esperando.length}</span>
            </span>
          </div>
        </motion.div>
      )}

      {/* Search */}
      {actionable.length > 0 && (
        <motion.div {...fadeUp(0.24)} className="hairline-top bg-card/40 rounded-2xl border border-border p-3 mb-4 shadow-card3d">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar por nombre, teléfono, ciudad, transportadora o novedad..."
              className="w-full h-10 rounded-xl border border-border bg-background/60 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 transition-colors"
            />
          </div>
          {search && (
            <p className="text-xs text-muted-foreground mt-2 pl-1 font-mono tabular-nums">
              {filtered.length} de {porGestionar.length} coincidencias
            </p>
          )}
        </motion.div>
      )}

      {/* Loading state */}
      {novedadesLoading && actionable.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <span className="w-14 h-14 rounded-2xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center" aria-hidden="true">
            <RefreshCw size={26} className="animate-spin" />
          </span>
          <div className="text-center">
            <p className="text-sm font-semibold text-foreground">Cargando novedades…</p>
            <p className="text-xs text-muted-foreground mt-1">Consultando pedidos con incidencias</p>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!novedadesLoading && porGestionar.length === 0 && (
        <motion.div {...fadeUp(0.28)}>
        <TiltCard sheen brackets className="bg-card/40 border border-border rounded-3xl p-12 shadow-card3d-lg flex flex-col items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-success/14 border border-success/30 text-success glow-success flex items-center justify-center tilt-layer-3">
            <CheckCircle2 size={28} />
          </div>
          <div className="text-center tilt-layer-1">
            <h3 className="text-base font-bold text-foreground">
              {esperando.length > 0 ? 'No hay novedades por gestionar' : 'No hay novedades pendientes'}
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              {esperando.length > 0
                ? 'Las que quedan abajo están esperando a la transportadora — no requieren acción.'
                : 'Todas las incidencias de transportadora están resueltas.'}
            </p>
          </div>
        </TiltCard>
        </motion.div>
      )}

      {/* Nota: novedades viejas ocultas (fantasmas ya cerradas en Dropi) */}
      {hiddenOld > 0 && (
        <div className="relative flex items-center gap-3 rounded-2xl border border-info/30 bg-info/10 px-4 pl-5 py-2.5 mb-3 shadow-card3d">
          <span className="absolute left-0 top-2.5 bottom-2.5 w-1 rounded-full bg-info" aria-hidden="true" />
          <span className="w-9 h-9 rounded-xl bg-info/20 glow-info flex items-center justify-center flex-shrink-0 text-info" aria-hidden="true">
            <Info size={17} />
          </span>
          <p className="flex-1 min-w-0 text-[11px] text-muted-foreground">
            {hiddenOld} novedad{hiddenOld === 1 ? '' : 'es'} vieja{hiddenOld === 1 ? '' : 's'} oculta{hiddenOld === 1 ? '' : 's'} (más de {NOVEDAD_WINDOW_DAYS} días — normalmente ya devueltas/cerradas en Dropi).
          </p>
        </div>
      )}

      {/* Queue — solo las gestionables (incidencia abierta en Dropi) */}
      {porGestionar.length > 0 && <NovedadView items={filtered} />}

      {/* Esperando transportadora: estado NOVEDAD sin incidencia abierta.
          La transportadora cerró/venció la incidencia — no hay nada que
          gestionar (Dropi rechaza resolverlas); queda esperar reintento o
          devolución. Plegado por defecto para no distraer de las vivas. */}
      {conocido && esperando.length > 0 && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setShowEsperando(v => !v)}
            aria-expanded={showEsperando}
            aria-controls="novedades-esperando-panel"
            className="hairline-top w-full flex items-center gap-2 px-4 py-3 rounded-2xl border border-border bg-card/40 shadow-card3d text-left text-sm font-medium text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {showEsperando ? <ChevronDown size={14} className="text-info flex-shrink-0" aria-hidden="true" /> : <ChevronRight size={14} className="text-info flex-shrink-0" aria-hidden="true" />}
            <span className="w-7 h-7 rounded-xl bg-info/14 border border-info/30 text-info flex items-center justify-center flex-shrink-0" aria-hidden="true">
              <Clock size={13} />
            </span>
            <span>
              Esperando transportadora (<span className="font-mono tabular-nums">{search ? `${esperandoFiltered.length} de ` : ''}{esperando.length}</span>)
            </span>
            <span className="font-normal text-muted-foreground/80 hidden sm:inline">
              — novedad vencida o cerrada por la transportadora, sin gestión posible
            </span>
          </button>
          {showEsperando && (
            <div className="mt-3" id="novedades-esperando-panel">
              <div className="relative flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-4 pl-5 py-3 mb-3 shadow-card3d">
                <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-warning" aria-hidden="true" />
                <span className="w-9 h-9 rounded-xl bg-warning/20 glow-warning flex items-center justify-center flex-shrink-0 text-warning" aria-hidden="true">
                  <AlertTriangle size={17} />
                </span>
                <span className="flex-1 min-w-0 text-[11px] text-muted-foreground leading-relaxed">
                  Estos pedidos siguen en estado NOVEDAD pero su incidencia <strong>ya no está
                  abierta</strong> en Dropi (por eso no aparecen en su panel). Intentar
                  solucionarlas va a ser rechazado por Dropi — la transportadora los moverá a
                  reintento de entrega o devolución.
                </span>
              </div>
              <NovedadView items={esperandoFiltered} stateKey="novedades:esperando:callOrderId" />
            </div>
          )}
        </div>
      )}
       </>
      )}
    </div>
  );
}
