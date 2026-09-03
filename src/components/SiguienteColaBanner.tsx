import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, AlertTriangle, Package, ArrowRight, PartyPopper, Inbox } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { useOrders } from '@/contexts/OrderContext';
import { classifySegEstado } from '@/lib/segStatus';
import { isLocallyDead } from '@/lib/duplicateOrders';
import { isLockedByOther } from '@/lib/callQueueNav';
import { useInboxEsperando } from '@/hooks/useInboxEsperando';

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
  const { isOwnerOfActive, activeStoreId } = useStore();
  const { workQueue, novedadesQueue, segData, mySegTouchedToday, coverageSegError } = useOrders();

  // ⛔ LA BANDEJA FALTABA ACÁ (3-sep-2026). Pedido del dueño: *"si terminó
  // Seguimiento que le señale que falta Inbox"*. Este banner listaba solo
  // Novedades y Seguimiento, así que la asesora terminaba Confirmar, veía «Todo
  // al día ✓» y se iba con clientes esperando respuesta sin contestar.
  //
  // Mismo hook que la barra del turno y que `/inbox`: una consulta, un canal.
  const bandeja = useInboxEsperando(activeStoreId);
  // Solo se cuenta con `status === 'ok'`. Con `sin_medir`/`error`, este banner
  // NO puede decir «todo al día»: es exactamente el cero que celebró una
  // bandeja con 39 clientes esperando.
  const bandejaMedida = bandeja.status === 'ok';
  const bandejaPend = bandejaMedida ? bandeja.items.length + bandeja.sinRespuesta.length : 0;

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

  // No es operadora (el jefe: admin o dueño), o todavía le falta confirmar → no molestar.
  if (isAdmin || isOwnerOfActive) return null;
  if (confirmarPend > 0) return null;

  // Terminó Confirmar y NO queda nada en ninguna cola → felicitar y listo.
  // Con el cruce de Seguimiento caído no podemos saber qué gestionó hoy: solo
  // felicitamos si NO hay activos en absoluto (eso sí lo sabemos sin el set).
  const segTerminado = coverageSegError ? segActivos === 0 : segPend === 0;
  // ⛔ Con la bandeja sin medir NO se felicita: se cae al listado de abajo, que
  // dice lo que sí sabe. Un «Todo al día ✓» sobre un dato que no se pudo leer
  // es la buena noticia falsa que este proyecto ya pagó dos veces.
  if (novedadesPend === 0 && segTerminado && bandejaMedida && bandejaPend === 0) {
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
        {bandejaPend > 0 && (
          <button
            type="button"
            onClick={() => navigate('/inbox')}
            className="flex-1 inline-flex items-center gap-2.5 rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-left transition-colors hover:bg-danger/16 focus-visible:ring-2 focus-visible:ring-danger focus-visible:outline-none"
          >
            <Inbox size={16} className="text-danger shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-foreground">
                Escribieron · <span className="font-mono tabular-nums text-danger">{bandejaPend}</span>
              </span>
              <span className="block text-[11px] text-muted-foreground">
                {bandeja.sinRespuesta.length > 0 && bandeja.items.length > 0
                  ? `${bandeja.items.length} esperando · ${bandeja.sinRespuesta.length} sin respuesta`
                  : bandeja.sinRespuesta.length > 0
                    ? 'les escribiste y no contestaron'
                    : 'esperando respuesta'}
              </span>
            </span>
            <ArrowRight size={15} className="text-muted-foreground shrink-0" aria-hidden="true" />
          </button>
        )}
        {!bandejaMedida && (
          <p className="flex-1 self-center text-[11px] text-warning">
            No pude leer la bandeja: puede haber clientes esperando respuesta.
          </p>
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
