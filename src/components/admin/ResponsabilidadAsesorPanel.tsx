import { motion } from 'framer-motion';
import { Loader2, ShieldCheck, AlertTriangle } from 'lucide-react';
import { useResponsabilidadAsesor, type ProdRowLite } from '@/hooks/useResponsabilidadAsesor';
import { semaforoAsesor, motivoSemaforo, metaGestionesDelRango, META_GESTIONES_DIA } from '@/lib/responsabilidadAsesor';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { useStoreSchedule } from '@/hooks/useStoreSchedule';
import { scheduleFromMinutes, DEFAULT_SCHEDULE, bogotaSecondsOfDay } from '@/lib/inactivityWindow';

type Range = 'today' | '7d' | '30d';

/** Fracción del turno laboral ya transcurrida hoy (0..1), para prorratear la meta
 *  de "Hoy". Descuenta lo previo al inicio y topa al fin del horario. */
function fraccionTurnoHoy(schedule: { workStartSec: number; workEndSec: number }, now: Date): number {
  const nowSec = bogotaSecondsOfDay(now);
  const total = schedule.workEndSec - schedule.workStartSec;
  if (total <= 0) return 1;
  return Math.max(0, Math.min(1, (nowSec - schedule.workStartSec) / total));
}

const SEMAFORO_DOT: Record<'rojo' | 'ambar' | 'verde' | 'neutro', string> = {
  rojo: 'bg-danger shadow-[0_0_6px_hsl(var(--danger))]',
  ambar: 'bg-warning shadow-[0_0_6px_hsl(var(--warning))]',
  verde: 'bg-success shadow-[0_0_6px_hsl(var(--success))]',
  neutro: 'bg-muted-foreground/40',
};
const SEMAFORO_LABEL: Record<'rojo' | 'ambar' | 'verde' | 'neutro', string> = {
  rojo: 'Revisar — no llega a la meta, o mucha devolución, o despacha en rojo',
  ambar: 'Ojo — en la banda de alerta',
  verde: 'Bien',
  neutro: 'Sin actividad para evaluar',
};

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

/**
 * Tablero UNIFICADO de responsabilidad por asesor: esfuerzo (gestionados vs meta),
 * resultado (confirmados), calidad (devoluciones + tasa) y disciplina de validación
 * (% despachado en rojo). Una fila, un semáforo — "el sistema que funciona solo".
 *
 * Recibe las filas de productividad que el dashboard ya cargó; el resto lo junta el
 * hook. Honesto: dato que no se pudo medir va "—", nunca 0.
 */
export default function ResponsabilidadAsesorPanel({
  range, prodRows,
}: { range: Range; prodRows: ProdRowLite[] }) {
  const activeStoreId = useActiveStoreId();
  const { data: scheduleMin } = useStoreSchedule(activeStoreId);
  const schedule = scheduleMin ? scheduleFromMinutes(scheduleMin) : DEFAULT_SCHEDULE;
  // Meta del rango: para "Hoy" prorrateada al turno transcurrido (justa a media
  // mañana); para 7d/30d, la meta completa de días cerrados.
  const metaGestionesInput = metaGestionesDelRango(
    range,
    range === 'today' ? fraccionTurnoHoy(schedule, new Date()) : 1,
  );
  const { loading, status, scores, metaGestiones, selloEscaso } = useResponsabilidadAsesor(range, prodRows, metaGestionesInput);

  if (status === 'error') return null;

  return (
    <motion.section
      {...fadeUp(0.04)}
      className="hairline-top bg-card/40 border border-border rounded-2xl p-5 shadow-card3d"
    >
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck size={17} className="text-accent" aria-hidden="true" strokeWidth={2.25} />
        <h3 className="text-base font-bold text-foreground">Responsabilidad por asesor</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-2.5">
        Todo junto por asesor: cuánto trabajó, cuántas devoluciones dejó, y cuántos pedidos despachó
        a una dirección mala (sin corregir). El punto de color te dice de un vistazo a quién revisar.
      </p>

      {/* Leyenda VISIBLE de los colores — el dueño pidió no tener que acordarse de
          qué significa cada uno. Antes solo estaba en el tooltip del punto. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-4 text-[11px]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-success" />
          <span className="text-muted-foreground"><b className="text-foreground">Verde</b> — bien</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-warning" />
          <span className="text-muted-foreground"><b className="text-foreground">Amarillo</b> — ojo, está en la banda de alerta</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-danger" />
          <span className="text-muted-foreground"><b className="text-foreground">Rojo</b> — revisar: va lento, mucha devolución, o despacha a direcciones malas</span>
        </span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="animate-spin text-accent" size={18} aria-hidden="true" />
        </div>
      ) : scores.length === 0 ? (
        <p className="text-xs text-muted-foreground py-6 text-center">Sin asesores con actividad en el período.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-8" title="Semáforo: verde bien · ámbar ojo · rojo revisar" aria-label="Semáforo" />
                <th>Asesor</th>
                <th className="text-right" title={`Pedidos trabajados (confirmó + canceló + no contestó). Óptimo: ${metaGestiones}${range === 'today' ? ' hasta esta hora del turno (se prorratea — a media mañana no se exige el día entero)' : ' del período'} · ${META_GESTIONES_DIA}/día laboral (3 min/pedido). Verde = en el óptimo · ámbar = aceptable · rojo = bajo la alerta (5 min/pedido). Ajustable.`}>
                  Gestionados
                </th>
                <th className="text-right">Confirmó</th>
                <th className="text-right" title="Devoluciones del período atribuidas a este asesor como confirmador.">Devol.</th>
                <th className="text-right" title="Devoluciones ÷ confirmados. La medida justa: el conteo absoluto castiga al que más volumen mueve.">Tasa</th>
                <th className="text-right" title="De los pedidos que este asesor confirmó y que YA se despacharon, qué porcentaje salió con la dirección en rojo/amarillo (mala, sin corregir). Alto = confirmó rápido sin arreglar la dirección → riesgo de devolución. El sello arrancó el 22-ago, así que aún hay poca base.">
                  Direcciones malas
                </th>
              </tr>
            </thead>
            <tbody>
              {scores.map((s) => {
                const sem = semaforoAsesor(s);
                const motivo = motivoSemaforo(s);
                return (
                  <tr key={s.operatorId}>
                    <td>
                      <span
                        className={`inline-block w-2.5 h-2.5 rounded-full ${SEMAFORO_DOT[sem]}`}
                        title={SEMAFORO_LABEL[sem]}
                        aria-label={SEMAFORO_LABEL[sem]}
                      />
                    </td>
                    <td className="font-semibold text-foreground">
                      <div className="leading-tight">
                        <span>{s.name}</span>
                        {/* El PORQUÉ del color, visible en la fila — no escondido en
                            el tooltip del punto. Solo cuando hay algo que revisar. */}
                        {motivo && (
                          <span className={`block text-[10px] font-medium ${sem === 'rojo' ? 'text-danger' : 'text-warning'}`}>
                            {motivo}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="text-right">
                      <div className="inline-flex flex-col items-end leading-tight">
                        <span className={`font-mono tabular-nums font-bold ${
                          s.nivelMeta === 'lento' ? 'text-danger'
                            : s.nivelMeta === 'aceptable' ? 'text-warning'
                            : s.nivelMeta === 'optimo' ? 'text-success' : 'text-foreground'
                        }`} title={
                          s.nivelMeta === 'lento' ? 'Bajo la alerta (menos del 60% del óptimo = ritmo de +5 min/pedido).'
                            : s.nivelMeta === 'aceptable' ? 'Aceptable pero bajo el óptimo (entre 60% y 100% de la meta).'
                            : s.nivelMeta === 'optimo' ? 'En el óptimo o por encima (3 min/pedido).' : ''
                        }>
                          {s.gestionados}
                        </span>
                        <span className="text-[10px] text-muted-foreground tabular-nums">óptimo {s.metaGestiones}</span>
                      </div>
                    </td>
                    <td className="text-right font-mono tabular-nums text-foreground">{s.confirmados}</td>
                    <td className="text-right font-mono tabular-nums text-muted-foreground">
                      {s.devoluciones}
                      {s.evitables > 0 && <span className="ml-1 text-danger text-[10px]">· {s.evitables} evit</span>}
                    </td>
                    <td className="text-right">
                      <span className={`font-mono tabular-nums font-bold ${
                        s.tasaDevolucion == null ? 'text-muted-foreground'
                          : s.tasaDevolucion >= 15 ? 'text-danger'
                          : s.tasaDevolucion >= 10 ? 'text-warning' : 'text-muted-foreground'
                      }`} title={s.tasaDevolucion == null ? 'Sin confirmados para calcular.' : `${s.devoluciones} devol ÷ ${s.confirmados} confirmados`}>
                        {s.tasaDevolucion == null ? '—' : `${s.tasaDevolucion}%`}
                      </span>
                    </td>
                    <td className="text-right">
                      <span className={`font-mono tabular-nums font-bold ${
                        s.pctEnRojo == null || s.despachadosConSello < 5 ? 'text-muted-foreground'
                          : s.pctEnRojo >= 30 ? 'text-danger'
                          : s.pctEnRojo >= 15 ? 'text-warning' : 'text-muted-foreground'
                      }`} title={s.pctEnRojo == null
                        ? 'Todavía no hay pedidos con sello de este asesor.'
                        : `${s.despachadosEnRojo} en rojo de ${s.despachadosConSello} con sello`}>
                        {s.pctEnRojo == null ? '—' : `${s.pctEnRojo}%`}
                        {s.pctEnRojo != null && s.despachadosConSello < 5 && (
                          <span className="ml-1 text-[9px] text-muted-foreground">(poca base)</span>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selloEscaso && !loading && scores.length > 0 && (
        <div className="mt-3 flex items-start gap-2 text-[11px] text-muted-foreground">
          <AlertTriangle size={13} className="text-warning mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            La columna «% en rojo» usa el sello del despacho, que arrancó el 22-ago y no tiene histórico:
            se va a ir llenando con los pedidos nuevos. La tasa de devolución y la meta sí son completas.
          </span>
        </div>
      )}

      <p className="mt-3 text-[10px] text-muted-foreground">
        Óptimo {META_GESTIONES_DIA}/día laboral = 3 min/pedido (verde). Ámbar = aceptable pero bajo el óptimo;
        rojo = bajo la alerta (ritmo de +5 min/pedido). Orientativo — decime el número que querés y lo cambio.
        Devoluciones por confirmador = match exacto por pedido; la tasa es devol ÷ confirmados.
        <strong className="text-foreground/80"> «Direcciones malas»</strong> = de lo que confirmó y ya se
        despachó, cuánto salió con la dirección en rojo/amarillo sin corregir (confirmó apurado sin arreglarla)
        — alto = más riesgo de que se devuelva. Es para revisar con datos, no una condena automática.
      </p>
    </motion.section>
  );
}
