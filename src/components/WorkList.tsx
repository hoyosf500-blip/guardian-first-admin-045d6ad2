import { useState } from 'react';
import { OrderData, formatPhone, parseDate } from '@/lib/orderUtils';
import { formatCOP, bogotaToday } from '@/lib/utils';
import { calcPriority, getPriorityLevel, PRIORITY_CONFIG } from '@/lib/alertSystem';
import { CheckCircle2, XCircle, PhoneOff, RotateCcw, UserCog, MessageSquare, Bell, Copy, DollarSign, PhoneOutgoing } from 'lucide-react';
import { useOperatorNames } from '@/hooks/useOperatorNames';
import { haceCuanto, etiquetaResultado, type GestionDelPedido } from '@/lib/gestionPorPedido';
import { MAX_DAILY_ATTEMPTS } from '@/lib/confirmarQueue';
import { TruncatedText } from '@/components/TruncatedText';
import LockBadge from '@/components/LockBadge';
import OrderEditorDialog from '@/components/confirmar/OrderEditorDialog';
import { useRefreshOrderRow } from '@/hooks/useRefreshOrderRow';
import type { NoteIndex } from '@/hooks/useOrderNotesIndex';
import { isReminderDue } from '@/lib/reminders';
import { dupAlertsFor, overchargeFor, type ConfirmarOrderAlerts } from '@/lib/orderAlerts';
// import { useAuth } from '@/contexts/AuthContext'; // gate removed after end-to-end validation

interface Props {
  items: OrderData[];
  onOpenCall: (idx: number) => void;
  /** Mapa agregado de notas por order_id (de `useOrderNotesIndex`). Opcional:
   *  si no se pasa, las filas no muestran ícono de nota. Permite que la tab
   *  padre haga 1 sola query agregada en vez de N. */
  notesIndex?: NoteIndex;
  /** Alertas por pedido (duplicado en curso + sobreprecio vs Shopify) —
   *  las computa ConfirmarTab una sola vez para toda la cola. */
  alerts?: ConfirmarOrderAlerts;
  /** Quién del EQUIPO llamó cada pedido HOY (de OrderContext.gestionPorPedido).
   *  Lo ven todos igual — dueño y asesoras — para no repetir la llamada ni
   *  tener que preguntar "¿ya llamaste estos?". */
  gestionEquipo?: Map<string, GestionDelPedido>;
}

function timeAgo(dias: number): string {
  if (dias === 0) return 'hoy';
  if (dias === 1) return 'hace 1 día';
  return `hace ${dias}d`;
}

// Días calendario REALES desde la fecha del pedido, calculados en cada render.
// El campo `o.dias` se congela al momento de la última sincronización: si el
// sync de la tienda está atrasado/throttleado (caso Ecuador), un pedido de hace
// 2 días seguía mostrando "hoy" (dias=0 viejo). Calcular desde `o.fecha` lo hace
// siempre correcto sin depender de que el sync esté al día. Fallback a `o.dias`
// si la fecha no parsea.
//
// La resta es entre DOS anclajes de medianoche UTC: `parseDate` ancla la fecha
// del pedido ahí y `bogotaToday()` devuelve 'YYYY-MM-DD' (que Date.parse lee
// igual), así que el resultado son días de CALENDARIO Bogotá. Con `Date.now()`
// el contador saltaba a las 00:00 UTC = 19:00 Bogotá: entre las 7pm y la
// medianoche TODA la cola envejecía un día de más y un D6 entraba al chip
// "D7+: cancelar" — pedidos cancelados un día antes de agotar la ventana.
// Exportada porque ConfirmarTab pinta los mismos chips: dos copias de esta
// función ya hicieron que un arreglo tocara una sola pantalla.
export function diasReales(o: OrderData): number {
  try {
    const d = parseDate(o.fecha);
    if (d && !isNaN(d.getTime())) {
      const diff = Math.round((Date.parse(bogotaToday()) - d.getTime()) / 86400000);
      if (diff >= 0) return diff;
    }
  } catch {
    // ignore — caemos al fallback
  }
  return Math.max(0, o.dias ?? 0);
}

export default function WorkList({ items, onOpenCall, notesIndex, alerts, gestionEquipo }: Props) {
  const [visibleCount, setVisibleCount] = useState(50);
  // Cache módulo-level compartido: no dispara una consulta por fila.
  const { nameOf } = useOperatorNames();
  const [editingOrder, setEditingOrder] = useState<OrderData | null>(null);
  // Editar desde la lista ahora SÍ refresca la fila al guardar (antes no pasaba
  // onSuccess y la lista quedaba vieja hasta el próximo sync).
  const refreshOrderRow = useRefreshOrderRow();
  // isAdmin gate removed — feature validated end-to-end. Ownership is now
  // enforced by the protect_order_financial_fields trigger (assigned_to = auth.uid()).

  if (!items.length) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <CheckCircle2 size={36} className="mx-auto mb-3 text-green opacity-60" aria-hidden="true" />
        <p className="text-sm">No hay pedidos en este filtro</p>
      </div>
    );
  }

  return (
    <>
    <div className="space-y-0 glass-panel rounded-xl overflow-hidden shadow-card3d">
      {items.slice(0, visibleCount).map((o, i) => {
        const pLevel = getPriorityLevel(calcPriority(o));
        const pCfg = PRIORITY_CONFIG[pLevel];
        // Edad real desde la fecha del pedido (no el `o.dias` congelado en el sync).
        const dias = diasReales(o);
        /* Badge color for estado "Pendiente" */
        const isPending = !o.result;
        const resultBg = o.result === 'conf'
          ? 'bg-green/15 text-green border-green/20'
          : o.result === 'canc'
            ? 'bg-red/15 text-red border-red/20'
            : 'bg-card text-muted-foreground border-border';

        return (
          <div
            key={`${o.phone}-${o.idx}`}
            role="button"
            tabIndex={0}
            onClick={() => onOpenCall(i)}
            onKeyDown={(e) => e.key === 'Enter' && onOpenCall(i)}
            aria-label={`Gestionar pedido de ${o.nombre}`}
            className={[
              'flex items-center gap-3 px-4 py-0 border-b border-border last:border-b-0',
              'min-h-[56px] cursor-pointer transition-colors duration-200',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
              o.result
                ? 'opacity-50 bg-background'
                : isPending
                  ? 'bg-surface hover:bg-card'
                  : 'bg-surface hover:bg-card',
              dias >= 7 && !o.result ? 'urgent-pulse' : '',
            ].join(' ')}
          >
            {/* Priority bar — barra de acento con glow (Dirección 3D) */}
            <div className={`w-[3px] self-stretch flex-shrink-0 ${
              dias >= 7 ? 'bg-danger shadow-[0_0_12px_hsl(var(--danger))]'
              : dias >= 4 ? 'bg-warning shadow-[0_0_12px_hsl(var(--warning))]'
              : 'bg-success shadow-[0_0_12px_hsl(var(--success)/0.7)]'
            }`} aria-hidden="true" />

            {/* Two-line content */}
            <div className="flex-1 min-w-0 py-3">
              {/* Line 1: Name + phone */}
              <div className="flex items-center gap-2">
                <TruncatedText
                  text={o.nombre}
                  cssTruncate
                  className="block text-sm font-semibold text-foreground truncate flex-1"
                />
                <span className="font-mono text-xs text-muted-foreground/70 flex-shrink-0 hidden sm:block">
                  {formatPhone(o.phone)}
                </span>
              </div>
              {/* Line 2: Product · city · time */}
              <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
                <TruncatedText text={o.producto || '—'} maxChars={20} className="truncate" />
                <span className="text-muted-foreground/60" aria-hidden="true">·</span>
                <span className="flex-shrink-0">{o.ciudad || '—'}</span>
                <span className="text-muted-foreground/60" aria-hidden="true">·</span>
                <span className="flex-shrink-0">{timeAgo(dias)}</span>
              </div>
              {/* Renglón de traspaso entre asesoras. Se lee como una frase:
                "Ana llamó hace 20 min · No contestó · pidió llamar mañana".
                Responde las tres preguntas que antes se hacían de viva voz —
                quién, hace cuánto y qué pasó — sin abrir el pedido. El motivo
                es LO QUE ESCRIBIÓ la asesora, no un resumen inventado. */}
              {(() => {
              const g = o.dbId ? gestionEquipo?.get(o.dbId) : undefined;
              if (!g) return null;
              const quien = nameOf(g.ultimoPor);
              const cuando = haceCuanto(g.ultimoAt);
              const queHizo = etiquetaResultado(g.ultimoResult);
              return (
                <div className="mt-1.5 pt-1.5 border-t border-border/40 flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
                  <PhoneOutgoing size={11} aria-hidden="true" className="flex-shrink-0 opacity-70" />
                  <span className="font-semibold text-foreground/80 flex-shrink-0 truncate max-w-[110px]">{quien}</span>
                    {cuando && <span className="flex-shrink-0">{cuando}</span>}
                  <span className="opacity-40 flex-shrink-0">·</span>
                  <span className="font-semibold flex-shrink-0">{queHizo}</span>
                    {/* En los que no contestaron interesa el INTENTO, no el
                      total: "intento 2 de 3" dice de un vistazo cuántas
                      llamadas le quedan al cliente hoy. Antes había que abrir
                      el pedido para saberlo. */}
                  {g.ultimoResult === 'noresp' ? (
                    <span
                      className="flex-shrink-0 font-semibold text-warning"
                      title={`Le queda${MAX_DAILY_ATTEMPTS - g.intentos === 1 ? '' : 'n'} ${Math.max(0, MAX_DAILY_ATTEMPTS - g.intentos)} llamada${MAX_DAILY_ATTEMPTS - g.intentos === 1 ? '' : 's'} hoy`}
                    >
                      intento {Math.min(g.intentos, MAX_DAILY_ATTEMPTS)} de {MAX_DAILY_ATTEMPTS}
                    </span>
                  ) : g.intentos > 1 && (
                    <span className="flex-shrink-0 opacity-80" title={`${g.intentos} llamadas hoy`}>
                      ({g.intentos} llamadas)
                    </span>
                  )}
                    {g.ultimoMotivo && (
                    <>
                      <span className="opacity-40 flex-shrink-0">·</span>
                      <span className="italic truncate min-w-0" title={g.ultimoMotivo}>{g.ultimoMotivo}</span>
                    </>
                  )}
                </div>
              );
              })()}
            </div>

            {/* Right side: value + badge */}
            <div className="flex items-center gap-2 flex-shrink-0">
              {o.valor > 0 && (
                <span className="font-mono font-semibold text-xs text-foreground tabular-nums hidden sm:block">
                  {formatCOP(o.valor)}
                </span>
              )}
              {/* Edit order button — visible to anyone; trigger enforces ownership.
                  Tamaño 36x36 (era 28x28) para tocarlo sin mis-tap en mobile. */}
              {o.externalId && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setEditingOrder(o); }}
                  onKeyDown={(e) => e.stopPropagation()}
                  aria-label={`Editar datos del pedido de ${o.nombre}`}
                  title="Editar datos del cliente"
                  className="w-9 h-9 rounded-md bg-success/12 hover:bg-success/20 border border-success/30 hover:border-success/45 text-success inline-flex items-center justify-center transition-colors flex-shrink-0 focus-visible:ring-2 focus-visible:ring-success focus-visible:outline-none"
                >
                  <UserCog size={15} aria-hidden="true" />
                </button>
              )}
              {/* Aviso duplicado: el cliente tiene otro pedido en curso (detalle en la ficha) */}
              {!o.result && dupAlertsFor(alerts?.dupByPhone, o).length > 0 && (
                <span
                  title="Este cliente tiene otro pedido en curso — abrí la ficha para ver el detalle"
                  aria-label="Posible duplicado"
                  className="text-[9px] font-bold px-1.5 py-0.5 rounded border flex-shrink-0 bg-destructive/15 text-destructive border-destructive/30 inline-flex items-center gap-0.5"
                >
                  <Copy size={9} aria-hidden="true" /> DUP
                </span>
              )}
              {/* Aviso sobreprecio: Dropi cobra más que el total de Shopify */}
              {!o.result && overchargeFor(alerts?.mismatchByExt, o) && (
                <span
                  title={`Dropi cobra ${formatCOP(o.valor)} y el cliente aceptó ${formatCOP(overchargeFor(alerts?.mismatchByExt, o)!.shopifyTotal)} en Shopify — corregilo desde la ficha`}
                  aria-label="Valor distinto a Shopify"
                  className="text-[9px] font-bold px-1.5 py-0.5 rounded border flex-shrink-0 bg-warning/15 text-warning border-warning/30 inline-flex items-center gap-0.5"
                >
                  <DollarSign size={9} aria-hidden="true" /> DE MÁS
                </span>
              )}
              {/* Badge D7+ — la MISMA regla de días que alimenta el KPI
                  "N cancelar (D7+)" del header. Va aparte del badge de
                  prioridad porque ese sale de calcPriority (un score
                  compuesto): un pedido podía contar en el KPI "cancelar" y
                  mostrar "Alta" en la fila, y la asesora no encontraba cuáles
                  eran los que el contador le estaba señalando. */}
              {dias >= 7 && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border flex-shrink-0 bg-danger/15 text-danger border-danger/30">
                  CANCELAR
                </span>
              )}
              {/* Priority badge (high/critical only) */}
              {pLevel !== 'low' && (
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border flex-shrink-0 ${pCfg.bgClass} ${pCfg.color}`}>
                  {pCfg.label}
                </span>
              )}
              {/* Lock badge — visible only when another operator owns the lock */}
              <LockBadge lockedBy={o.lockedBy} lockedAt={o.lockedAt} />
              {/* Indicador de notas: cuenta + pulse si hay recordatorio vencido.
                  La data viene del agregado `useOrderNotesIndex` que carga el
                  tab padre (1 sola query, no N). */}
              {(() => {
                const n = o.dbId ? notesIndex?.get(o.dbId) : undefined;
                if (!n || n.count === 0) return null;
                const due = isReminderDue(n.nextReminderAt);
                return (
                  <span
                    title={due ? 'Recordatorio para ahora' : `${n.count} nota${n.count > 1 ? 's' : ''}`}
                    aria-label={due ? `Recordatorio vencido (${n.count} nota${n.count > 1 ? 's' : ''})` : `${n.count} nota${n.count > 1 ? 's' : ''}`}
                    className={[
                      'text-[10px] px-1.5 py-0.5 rounded-md font-bold inline-flex items-center gap-0.5 flex-shrink-0 border',
                      due
                        ? 'bg-warning/15 text-warning border-warning/40 motion-safe:animate-pulse'
                        : 'bg-accent/10 text-accent border-accent/25',
                    ].join(' ')}
                  >
                    {due ? <Bell size={9} aria-hidden="true" /> : <MessageSquare size={9} aria-hidden="true" />}
                    {n.count}
                  </span>
                );
              })()}
              {/* ETIQUETA DE UN VISTAZO — va en el grupo de badges de la derecha,
                  que es la zona que la asesora ya recorre con la vista al bajar
                  por la lista. El renglón de abajo tiene el detalle (qué dijo el
                  cliente); esto responde de un golpe "¿ya la llamaron y cómo
                  salió?". El color ES el resultado: verde confirmó, rojo canceló,
                  ámbar no contestó. Nunca color solo — el nombre siempre está. */}
              {(() => {
                const g = o.dbId ? gestionEquipo?.get(o.dbId) : undefined;
                if (!g) return null;
                const quien = nameOf(g.ultimoPor);
                const piel = g.ultimoResult === 'conf'
                  ? 'bg-success/15 text-success border-success/35'
                  : g.ultimoResult === 'canc'
                    ? 'bg-danger/15 text-danger border-danger/35'
                    : 'bg-warning/15 text-warning border-warning/35';
                return (
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-md font-bold border inline-flex items-center gap-1 flex-shrink-0 max-w-[130px] ${piel}`}
                    title={`${quien} · ${etiquetaResultado(g.ultimoResult)} · ${haceCuanto(g.ultimoAt) || 'hoy'}`}
                    aria-label={`Ya gestionado por ${quien}: ${etiquetaResultado(g.ultimoResult)}, ${haceCuanto(g.ultimoAt)}`}
                  >
                    <PhoneOutgoing size={9} aria-hidden="true" className="flex-shrink-0" />
                    <span className="truncate">{quien}</span>
                    <span className="opacity-75 flex-shrink-0 font-semibold">{haceCuanto(g.ultimoAt)}</span>
                  </span>
                );
              })()}
              {/* Retry badge — dice "Volvió" con todas las letras: el dato medido
                  (13-ago, bloque A) es que el reintento vuelve a la cola a la hora
                  pero se llama con mediana 2,6 h — el "2/3" críptico no le decía a
                  la asesora que ESTE pedido está esperando su segunda llamada. */}
              {o.retryCount && !o.result && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-md font-bold font-mono tabular-nums bg-attention/15 text-attention border border-attention/30 inline-flex items-center gap-0.5 flex-shrink-0" aria-label={`Volvió a la cola: intento ${o.retryCount + 1} de 3`}>
                  <RotateCcw size={9} aria-hidden="true" /> Volvió · {o.retryCount}/3 usados
                </span>
              )}
              {/* Status badge */}
              {o.result ? (
                <span className={`text-[10px] px-2 py-0.5 rounded-md font-semibold border inline-flex items-center gap-1 flex-shrink-0 ${resultBg}`}>
                  {o.result === 'conf' ? <CheckCircle2 size={11} aria-hidden="true" /> : o.result === 'canc' ? <XCircle size={11} aria-hidden="true" /> : <PhoneOff size={11} aria-hidden="true" />}
                  {o.result === 'conf' ? 'Confirmado' : o.result === 'canc' ? 'Cancelado' : 'N/R'}
                </span>
              ) : (
                <span className="text-[10px] px-2 py-0.5 rounded-md font-semibold border bg-accent/12 text-accent border-accent/30 flex-shrink-0">
                  Pendiente
                </span>
              )}
            </div>
          </div>
        );
      })}
      {items.length > visibleCount && (
        <div className="px-4 py-3 flex items-center justify-between bg-card/40 border-t border-border">
          <p className="text-xs text-muted-foreground font-mono tabular-nums">Mostrando {visibleCount} de {items.length}</p>
          <button
            onClick={() => setVisibleCount(prev => prev + 50)}
            className="text-xs px-4 py-1.5 rounded-lg bg-accent-gradient text-accent-foreground font-semibold shadow-glow hover:brightness-110 transition-all cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            Ver más
          </button>
        </div>
      )}
    </div>
    {editingOrder && (
      <OrderEditorDialog
        open={!!editingOrder}
        onOpenChange={(o) => { if (!o) setEditingOrder(null); }}
        order={editingOrder}
        onSuccess={() => { void refreshOrderRow(editingOrder.dbId); }}
      />
    )}
    </>
  );
}
