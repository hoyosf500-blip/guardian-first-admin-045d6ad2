import { useEffect, useState } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { useAuth } from '@/contexts/AuthContext';
import { AlertTriangle, RefreshCw, Search, CheckCircle2, Truck } from 'lucide-react';
import { motion } from 'framer-motion';
import NovedadView from '@/components/NovedadView';

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

export default function NovedadesTab() {
  const { user } = useAuth();
  const { novedadesQueue, novedadesLoading, loadNovedades } = useOrders();
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (user) loadNovedades();
  }, [user, loadNovedades]);

  const filtered = novedadesQueue.filter(o => {
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
    total: novedadesQueue.length,
    urgentes: novedadesQueue.filter(o => o.dias >= 7).length,
    warning: novedadesQueue.filter(o => o.dias >= 4 && o.dias < 7).length,
    carriers: new Set(novedadesQueue.map(o => o.transportadora).filter(Boolean)).size,
  };

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-5 gap-3">
        <div>
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-orange-500" />
            <h2 className="text-lg font-bold text-foreground">Novedades</h2>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Gestión de incidencias reportadas por las transportadoras. Resolución en tiempo real contra Dropi.
          </p>
        </div>
        <button
          onClick={() => loadNovedades()}
          disabled={novedadesLoading}
          className="h-9 px-3 rounded-lg border border-border bg-secondary text-secondary-foreground text-xs font-medium flex items-center gap-1.5 hover:bg-secondary/80 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={13} className={novedadesLoading ? 'animate-spin' : ''} />
          Recargar
        </button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0 }} className="bg-card rounded-xl border border-border p-4">
          <div className="text-xs text-muted-foreground font-medium mb-1">Pendientes</div>
          <div className="font-mono text-2xl font-bold text-foreground">{stats.total}</div>
        </motion.div>
        <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.05 }} className="bg-card rounded-xl border border-border p-4">
          <div className="text-xs text-muted-foreground font-medium mb-1">D7+ críticas</div>
          <div className="font-mono text-2xl font-bold text-red">{stats.urgentes}</div>
        </motion.div>
        <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }} className="bg-card rounded-xl border border-border p-4">
          <div className="text-xs text-muted-foreground font-medium mb-1">D4-6 urgentes</div>
          <div className="font-mono text-2xl font-bold text-yellow">{stats.warning}</div>
        </motion.div>
        <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.15 }} className="bg-card rounded-xl border border-border p-4">
          <div className="text-xs text-muted-foreground font-medium mb-1 flex items-center gap-1">
            <Truck size={11} /> Transportadoras
          </div>
          <div className="font-mono text-2xl font-bold text-cyan">{stats.carriers}</div>
        </motion.div>
      </div>

      {/* Search */}
      {novedadesQueue.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-3 mb-4">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar por nombre, teléfono, ciudad, transportadora o novedad..."
              className="w-full h-9 rounded-lg border border-border bg-background pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>
      )}

      {/* Loading state */}
      {novedadesLoading && novedadesQueue.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <RefreshCw size={32} className="text-primary animate-spin" />
          <div className="text-center">
            <p className="text-sm font-semibold text-foreground">Cargando novedades…</p>
            <p className="text-xs text-muted-foreground mt-1">Consultando pedidos con incidencias</p>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!novedadesLoading && novedadesQueue.length === 0 && (
        <motion.div {...fadeUp} className="bg-card rounded-2xl border border-border p-12 flex flex-col items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-green/10 flex items-center justify-center">
            <CheckCircle2 size={28} className="text-green" />
          </div>
          <div className="text-center">
            <h3 className="text-base font-bold text-foreground">No hay novedades pendientes</h3>
            <p className="text-xs text-muted-foreground mt-1">Todas las incidencias de transportadora están resueltas 🎉</p>
          </div>
        </motion.div>
      )}

      {/* Queue */}
      {novedadesQueue.length > 0 && <NovedadView items={filtered} />}
    </div>
  );
}
