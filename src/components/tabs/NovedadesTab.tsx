import { useEffect, useState } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { useAuth } from '@/contexts/AuthContext';
import { isWithinLastDays } from '@/lib/orderUtils';
import { AlertTriangle, RefreshCw, Search, CheckCircle2, Truck, ListChecks, BarChart3, Lightbulb, Target } from 'lucide-react';
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
  const { isManagerOfActive } = useStore();
  const { novedadesQueue, novedadesLoading, loadNovedades } = useOrders();
  const [search, setSearch] = useState('');
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

  const filtered = actionable.filter(o => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      o.nombre.toLowerCase().includes(s) ||
      o.phone.includes(s) ||
      o.ciudad.toLowerCase().includes(s) ||
      (o.transportadora || '').toLowerCase().includes(s) ||
      (o.novedad || '').toLowerCase().includes(s)
    );
  });

  const stats = {
    total: actionable.length,
    urgentes: actionable.filter(o => o.dias >= 7).length,
    warning: actionable.filter(o => o.dias >= 4 && o.dias < 7).length,
    carriers: new Set(actionable.map(o => o.transportadora).filter(Boolean)).size,
  };

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-5 gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-gradient-to-br from-warning to-warning/70 text-warning-foreground shadow-ds-md" aria-hidden="true">
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
              onClick={() => loadNovedades(true)}
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
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Pendientes</div>
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
              {filtered.length} de {actionable.length} coincidencias
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
      {!novedadesLoading && actionable.length === 0 && (
        <motion.div {...fadeUp} className="bg-card rounded-2xl border border-border p-12 flex flex-col items-center gap-4 shadow-ds-sm">
          <div className="w-16 h-16 rounded-2xl bg-success/10 border border-success/25 flex items-center justify-center">
            <CheckCircle2 size={28} className="text-success" />
          </div>
          <div className="text-center">
            <h3 className="text-base font-bold text-foreground">No hay novedades pendientes</h3>
            <p className="text-xs text-muted-foreground mt-1">Todas las incidencias de transportadora están resueltas.</p>
          </div>
        </motion.div>
      )}

      {/* Nota: novedades viejas ocultas (fantasmas ya cerradas en Dropi) */}
      {hiddenOld > 0 && (
        <p className="text-[11px] text-muted-foreground/80 mb-3 pl-1">
          {hiddenOld} novedad{hiddenOld === 1 ? '' : 'es'} vieja{hiddenOld === 1 ? '' : 's'} oculta{hiddenOld === 1 ? '' : 's'} (más de {NOVEDAD_WINDOW_DAYS} días — normalmente ya devueltas/cerradas en Dropi).
        </p>
      )}

      {/* Queue */}
      {actionable.length > 0 && <NovedadView items={filtered} />}
       </>
      )}
    </div>
  );
}
