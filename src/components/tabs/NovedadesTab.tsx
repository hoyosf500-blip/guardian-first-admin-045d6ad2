import { useEffect, useState } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { useAuth } from '@/contexts/AuthContext';
import { isWithinLastDays } from '@/lib/orderUtils';
import { splitNovedades } from '@/lib/novedadesSplit';
import { useOpenIncidences } from '@/hooks/useOpenIncidences';
import { AlertTriangle, RefreshCw, Search, CheckCircle2, Truck, ListChecks, BarChart3, Lightbulb, Target, Clock, ChevronDown, ChevronRight } from 'lucide-react';
import { motion } from 'framer-motion';
import NovedadView from '@/components/NovedadView';
import NovedadesSeguimiento from '@/components/NovedadesSeguimiento';
import NovedadesPuntosMejora from '@/components/novedades/NovedadesPuntosMejora';
import NovedadesCausaRaiz from '@/components/novedades/NovedadesCausaRaiz';
import { useStore } from '@/contexts/StoreContext';
import { useSessionState } from '@/hooks/useSessionState';

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

export default function NovedadesTab() {
  const { user } = useAuth();
  const { isManagerOfActive, activeStoreId } = useStore();
  const { novedadesQueue, novedadesLoading, loadNovedades } = useOrders();
  const [search, setSearch] = useState('');
  const [showEsperando, setShowEsperando] = useState(false);
  // Incidencias ABIERTAS según Dropi (misma consulta que su panel de
  // novedades). null = no disponible → no separamos (lista única, como antes).
  const { openIds, reloadOpen } = useOpenIncidences(activeStoreId);
  const [view, setView] = useSessionState<'pendientes' | 'seguimiento' | 'mejora' | 'causa'>('novedades:view', 'pendientes');
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

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-5 gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-gradient-to-br from-warning to-warning/70 text-warning-foreground glow-warning" aria-hidden="true">
            <AlertTriangle size={18} />
          </div>
          <div>
            <h2 className="text-lg font-bold text-foreground tracking-tight">Novedades</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Incidencias reportadas por transportadoras — resolución en vivo contra Dropi
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
            <button
              onClick={() => setView('pendientes')}
              className={`px-3 h-8 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                effectiveView === 'pendientes' ? 'bg-accent/10 text-accent' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <ListChecks size={13} /> Pendientes
            </button>
            <button
              onClick={() => setView('seguimiento')}
              className={`px-3 h-8 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                effectiveView === 'seguimiento' ? 'bg-accent/10 text-accent' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <BarChart3 size={13} /> Seguimiento
            </button>
            <button
              onClick={() => setView('mejora')}
              className={`px-3 h-8 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                effectiveView === 'mejora' ? 'bg-accent/10 text-accent' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Lightbulb size={13} /> Mejora
            </button>
            {isManagerOfActive && (
              <button
                onClick={() => setView('causa')}
                className={`px-3 h-8 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                  effectiveView === 'causa' ? 'bg-accent/10 text-accent' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Target size={13} /> Causa raíz
              </button>
            )}
          </div>
          {effectiveView === 'pendientes' && (
            <button
              onClick={() => { loadNovedades(true); void reloadOpen(true); }}
              disabled={novedadesLoading}
              className="h-9 px-3 rounded-lg border border-border bg-surface text-muted-foreground text-xs font-semibold flex items-center gap-1.5 hover:text-foreground hover:border-accent/30 hover:bg-accent/5 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw size={13} className={novedadesLoading ? 'animate-spin' : ''} />
              Recargar
            </button>
          )}
        </div>
      </div>

      {effectiveView === 'seguimiento' && <NovedadesSeguimiento />}

      {effectiveView === 'mejora' && <NovedadesPuntosMejora />}

      {effectiveView === 'causa' && <NovedadesCausaRaiz />}

      {effectiveView === 'pendientes' && (
       <>
      {/* KPIs — sistema unificado de tonos */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0 }} className="relative overflow-hidden bg-card rounded-xl border border-border p-4 shadow-ds-xs">
          <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-muted-foreground/40" aria-hidden="true" />
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            {conocido ? 'Por gestionar' : 'Pendientes'}
          </div>
          <div className="font-mono text-2xl font-bold text-foreground tabular-nums">{stats.total}</div>
        </motion.div>
        <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.05 }} className="relative overflow-hidden bg-card rounded-xl border border-danger/25 p-4 shadow-ds-xs">
          <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-danger" aria-hidden="true" />
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">D7+ críticas</div>
          <div className="font-mono text-2xl font-bold text-danger tabular-nums">{stats.urgentes}</div>
        </motion.div>
        <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }} className="relative overflow-hidden bg-card rounded-xl border border-warning/25 p-4 shadow-ds-xs">
          <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-warning" aria-hidden="true" />
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">D4-6 urgentes</div>
          <div className="font-mono text-2xl font-bold text-warning tabular-nums">{stats.warning}</div>
        </motion.div>
        <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.15 }} className="relative overflow-hidden bg-card rounded-xl border border-info/25 p-4 shadow-ds-xs">
          <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-info" aria-hidden="true" />
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
            <Truck size={11} /> Transportadoras
          </div>
          <div className="font-mono text-2xl font-bold text-info tabular-nums">{stats.carriers}</div>
        </motion.div>
      </div>

      {/* Search */}
      {actionable.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-3 mb-4 shadow-ds-xs">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar por nombre, teléfono, ciudad, transportadora o novedad..."
              className="w-full h-10 rounded-lg border border-border bg-background pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 transition-colors"
            />
          </div>
          {search && (
            <p className="text-xs text-muted-foreground mt-2 pl-1">
              {filtered.length} de {porGestionar.length} coincidencias
            </p>
          )}
        </div>
      )}

      {/* Loading state */}
      {novedadesLoading && actionable.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <RefreshCw size={32} className="text-accent animate-spin" />
          <div className="text-center">
            <p className="text-sm font-semibold text-foreground">Cargando novedades…</p>
            <p className="text-xs text-muted-foreground mt-1">Consultando pedidos con incidencias</p>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!novedadesLoading && porGestionar.length === 0 && (
        <motion.div {...fadeUp} className="bg-card rounded-2xl border border-border p-12 flex flex-col items-center gap-4 shadow-ds-sm">
          <div className="w-16 h-16 rounded-2xl bg-success/10 border border-success/25 flex items-center justify-center">
            <CheckCircle2 size={28} className="text-success" />
          </div>
          <div className="text-center">
            <h3 className="text-base font-bold text-foreground">
              {esperando.length > 0 ? 'No hay novedades por gestionar' : 'No hay novedades pendientes'}
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              {esperando.length > 0
                ? 'Las que quedan abajo están esperando a la transportadora — no requieren acción.'
                : 'Todas las incidencias de transportadora están resueltas.'}
            </p>
          </div>
        </motion.div>
      )}

      {/* Nota: novedades viejas ocultas (fantasmas ya cerradas en Dropi) */}
      {hiddenOld > 0 && (
        <p className="text-[11px] text-muted-foreground/80 mb-3 pl-1">
          {hiddenOld} novedad{hiddenOld === 1 ? '' : 'es'} vieja{hiddenOld === 1 ? '' : 's'} oculta{hiddenOld === 1 ? '' : 's'} (más de {NOVEDAD_WINDOW_DAYS} días — normalmente ya devueltas/cerradas en Dropi).
        </p>
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
            onClick={() => setShowEsperando(v => !v)}
            className="w-full flex items-center gap-2 px-3 h-10 rounded-lg border border-border bg-surface text-left text-xs font-semibold text-muted-foreground hover:text-foreground hover:border-accent/30 transition-colors cursor-pointer"
          >
            {showEsperando ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Clock size={13} />
            Esperando transportadora ({search ? `${esperandoFiltered.length} de ` : ''}{esperando.length})
            <span className="font-normal text-muted-foreground/80 hidden sm:inline">
              — novedad vencida o cerrada por la transportadora, sin gestión posible
            </span>
          </button>
          {showEsperando && (
            <div className="mt-3">
              <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 mb-3 text-[11px] text-muted-foreground flex items-start gap-2">
                <AlertTriangle size={13} className="text-warning mt-0.5 flex-shrink-0" aria-hidden="true" />
                <span>
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
