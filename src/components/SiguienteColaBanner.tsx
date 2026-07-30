import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, AlertTriangle, Package, ArrowRight, PartyPopper } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useOrders } from '@/contexts/OrderContext';
import { classifySegEstado } from '@/lib/segStatus';

/**
 * Guía a la operadora entre colas: cuando TERMINA Confirmar (0 por confirmar),
 * le avisa qué le falta en las OTRAS colas y la lleva — para que nunca crea que
 * terminó el día teniendo Novedades o Seguimiento pendientes.
 *
 * Solo para operadoras (no admin) y solo cuando Confirmar quedó en 0. Los
 * conteos salen de lo que OrderContext YA cargó (novedadesQueue + segData), sin
 * consultas nuevas: Novedades = incidencias activas; Seguimiento = pedidos
 * activos que HOY todavía no gestionó (cruzados contra mySegTouchedToday, igual
 * que "Te faltan N sin tocar"). Los estados terminales no cuentan.
 */

// Estados donde no hay nada que gestionar (no cuentan como "pendiente").
const SEG_TERMINAL = new Set(['entregado', 'cancelado', 'indemnizada', 'devolucion']);

export default function SiguienteColaBanner() {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const { workQueue, novedadesQueue, segData, mySegTouchedToday } = useOrders();

  // Confirmar terminado = ningún pedido de la cola sin resultado.
  const confirmarPend = useMemo(
    () => workQueue.filter(o => !o.result).length,
    [workQueue],
  );

  const novedadesPend = novedadesQueue.length;

  const segPend = useMemo(
    () => segData.filter(o =>
      o.phone
      && !mySegTouchedToday.has(o.phone)
      && !SEG_TERMINAL.has(classifySegEstado(o.estado)),
    ).length,
    [segData, mySegTouchedToday],
  );

  // No es operadora, o todavía le falta confirmar → no molestar.
  if (isAdmin) return null;
  if (confirmarPend > 0) return null;

  // Terminó Confirmar y NO queda nada en ninguna cola → felicitar y listo.
  if (novedadesPend === 0 && segPend === 0) {
    return (
      <div className="rounded-2xl border border-success/40 bg-success/10 px-4 py-3 mb-4 flex items-center gap-3 shadow-card3d">
        <PartyPopper size={18} className="text-success shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-bold text-success">¡Todo al día! ✓</p>
          <p className="text-xs text-muted-foreground">
            Terminaste Confirmar y no hay pendientes en Novedades ni Seguimiento. Excelente.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-accent/40 bg-accent/8 px-4 py-3.5 mb-4 shadow-card3d">
      <div className="flex items-center gap-2.5 mb-2.5">
        <CheckCircle2 size={18} className="text-success shrink-0" aria-hidden="true" />
        <p className="text-sm font-bold text-foreground">
          Terminaste Confirmar. Ahora seguí con lo que falta:
        </p>
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        {novedadesPend > 0 && (
          <button
            type="button"
            onClick={() => navigate('/novedades')}
            className="flex-1 inline-flex items-center gap-2.5 rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-left transition-colors hover:bg-warning/16 focus-visible:ring-2 focus-visible:ring-warning focus-visible:outline-none"
          >
            <AlertTriangle size={16} className="text-warning shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-foreground">
                Novedades · <span className="font-mono tabular-nums text-warning">{novedadesPend}</span>
              </span>
              <span className="block text-[11px] text-muted-foreground">por gestionar</span>
            </span>
            <ArrowRight size={15} className="text-muted-foreground shrink-0" aria-hidden="true" />
          </button>
        )}
        {segPend > 0 && (
          <button
            type="button"
            onClick={() => navigate('/seguimiento')}
            className="flex-1 inline-flex items-center gap-2.5 rounded-xl border border-info/40 bg-info/10 px-3.5 py-2.5 text-left transition-colors hover:bg-info/16 focus-visible:ring-2 focus-visible:ring-info focus-visible:outline-none"
          >
            <Package size={16} className="text-info shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-foreground">
                Seguimiento · <span className="font-mono tabular-nums text-info">{segPend}</span>
              </span>
              <span className="block text-[11px] text-muted-foreground">sin gestionar hoy</span>
            </span>
            <ArrowRight size={15} className="text-muted-foreground shrink-0" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
