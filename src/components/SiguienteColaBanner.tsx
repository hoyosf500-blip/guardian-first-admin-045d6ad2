import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, AlertTriangle, Package, ArrowRight, PartyPopper } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useOrders } from '@/contexts/OrderContext';
import { classifySegEstado } from '@/lib/segStatus';
import { isLocallyDead } from '@/lib/duplicateOrders';
import { isLockedByOther } from '@/lib/callQueueNav';

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

interface Props {
  /** Pedidos ocultos de la lista por duplicado (superseded), pasados por
   *  ConfirmarTab. Sin excluirlos, un duplicado sin cancelar mantenía
   *  confirmarPend > 0 para siempre y este banner NUNCA aparecía, aunque el
   *  headline de la pantalla ya dijera "0 por confirmar". */
  supersededIds?: Set<string>;
}

export default function SiguienteColaBanner({ supersededIds }: Props) {
  const navigate = useNavigate();
  const { isAdmin, user } = useAuth();
  const { workQueue, novedadesQueue, segData, mySegTouchedToday, coverageSegError } = useOrders();

  // Confirmar terminado = ningún pedido ACCIONABLE de la cola sin resultado.
  // Mismo criterio que el headline "por confirmar" de ConfirmarTab: se excluyen
  // los duplicados ocultos (superseded), los muertos localmente (cancelado/
  // reemplazado — la lista tampoco los ofrece) y los lockeados FRESCOS por otra
  // asesora (los está atendiendo ella; para MÍ, Confirmar ya terminó). Contar
  // sobre workQueue crudo hacía que el banner jamás saliera si quedaba un
  // duplicado sin cancelar o un pedido en manos de otra.
  const confirmarPend = useMemo(
    () => workQueue.filter(o =>
      !o.result
      && !supersededIds?.has(String(o.externalId))
      && !isLocallyDead(o.estado)
      && !isLockedByOther(o, user?.id ?? null, Date.now()),
    ).length,
    [workQueue, supersededIds, user?.id],
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

  // Con coverageSegError la query de touchpoints FALLÓ: mySegTouchedToday está
  // vacío/parcial y segPend se inflaría a TODO lo activo ("no gestionaste nada
  // en el día" — un dato inventado). Contamos los activos solo para saber si
  // hay ALGO en Seguimiento; el número no se muestra (contrato de honestidad
  // de OrderContext: dato ausente = "—", nunca un cero/N falso).
  const segActivos = useMemo(
    () => segData.filter(o =>
      o.phone && !SEG_TERMINAL.has(classifySegEstado(o.estado)),
    ).length,
    [segData],
  );

  // No es operadora, o todavía le falta confirmar → no molestar.
  if (isAdmin) return null;
  if (confirmarPend > 0) return null;

  // Terminó Confirmar y NO queda nada en ninguna cola → felicitar y listo.
  // Con el cruce de Seguimiento caído no podemos saber qué gestionó hoy: solo
  // felicitamos si NO hay activos en absoluto (eso sí lo sabemos sin el set).
  const segTerminado = coverageSegError ? segActivos === 0 : segPend === 0;
  if (novedadesPend === 0 && segTerminado) {
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
        {!segTerminado && (
          <button
            type="button"
            onClick={() => navigate('/seguimiento')}
            className="flex-1 inline-flex items-center gap-2.5 rounded-xl border border-info/40 bg-info/10 px-3.5 py-2.5 text-left transition-colors hover:bg-info/16 focus-visible:ring-2 focus-visible:ring-info focus-visible:outline-none"
          >
            <Package size={16} className="text-info shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-foreground">
                Seguimiento · <span className="font-mono tabular-nums text-info">{coverageSegError ? '—' : segPend}</span>
              </span>
              <span className="block text-[11px] text-muted-foreground">
                {coverageSegError ? 'sin datos — no se pudo leer tu avance de hoy' : 'sin gestionar hoy'}
              </span>
            </span>
            <ArrowRight size={15} className="text-muted-foreground shrink-0" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
