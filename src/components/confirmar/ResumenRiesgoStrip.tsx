import { PRIORIDAD_RIESGO, RIESGO_INFO, type NivelRiesgo, type ConteoRiesgo } from '@/lib/riesgoChat';

/**
 * Resumen de la cola PENDIENTE partido por etiqueta de chat, arriba de
 * Confirmar. Dos pedidos del dueño en uno (25-ago-2026):
 *  - "saber qué trabajo hay" → el conteo por tipo de un vistazo.
 *  - "cola de rescate 'con dudas'" → cada pill FILTRA a esa etiqueta al tocarla.
 *
 * Presentacional puro: recibe el conteo ya calculado y avisa qué se tocó. No
 * consulta nada (misma disciplina que la capa ui3d).
 */

/** Etiqueta corta para el pill (la de RIESGO_INFO es larga para una fila). */
const CORTA: Record<NivelRiesgo, string> = {
  mudo: 'Llamar',
  frio: 'No respondió',
  tibio: 'Con dudas',
  sin_dato: 'Sin leer',
  confirmado: 'Ya confirmó',
};

/** Orden de los pills: el mismo que la cola (peor primero). */
const ORDEN = (Object.keys(PRIORIDAD_RIESGO) as NivelRiesgo[]).sort(
  (a, b) => PRIORIDAD_RIESGO[a] - PRIORIDAD_RIESGO[b],
);

export default function ResumenRiesgoStrip({
  conteo,
  filtroActivo,
  onSelect,
}: {
  conteo: ConteoRiesgo;
  /** El `filter` actual de la cola; para marcar el pill activo. */
  filtroActivo: string;
  /** Tocar un pill: la etiqueta, o null para volver a "Pendientes". */
  onSelect: (r: NivelRiesgo | null) => void;
}) {
  if (conteo.total === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 mb-3" role="group" aria-label="Resumen de la cola por señal de WhatsApp">
      <span className="hud-label text-muted-foreground mr-1">Cómo viene la cola</span>
      {ORDEN.map((r) => {
        const n = conteo[r];
        if (!n) return null;
        const activo = filtroActivo === `riesgo_${r}`;
        const info = RIESGO_INFO[r];
        return (
          <button
            key={r}
            onClick={() => onSelect(activo ? null : r)}
            title={`${info.que} ${info.tasa}. ${info.queHacer}${activo ? ' · Tocá de nuevo para ver toda la cola.' : ' · Tocá para ver solo estos.'}`}
            aria-pressed={activo}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold tabular-nums transition
              ${info.clase} ${activo ? 'ring-2 ring-ring ring-offset-1 ring-offset-background' : 'opacity-90 hover:opacity-100'}`}
          >
            <span>{CORTA[r]}</span>
            <span className="font-bold">{n}</span>
          </button>
        );
      })}
      {filtroActivo.startsWith('riesgo_') && (
        <button
          onClick={() => onSelect(null)}
          className="text-[11px] font-semibold text-primary hover:underline ml-1"
        >
          Ver toda la cola
        </button>
      )}
    </div>
  );
}
