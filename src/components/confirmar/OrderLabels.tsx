import { Tag, X, Plus } from 'lucide-react';
import { useOrderLabels } from '@/hooks/useOrderLabels';
import {
  deriveAutoLabels, LABELS, MANUAL_LABELS, type LabelKey, type LabelDef,
} from '@/lib/orderLabels';

// Tonos semánticos del sistema (color + texto, nunca color solo).
// El degradado + el halo son los de la receta del DS: la etiqueta deja de ser
// un rectángulo pintado y pasa a tener la misma materia que los chips del
// Dashboard. Mismo tono, mismo texto, misma semántica.
const TONE_CHIP: Record<LabelDef['tone'], string> = {
  yellow: 'bg-gradient-to-br from-warning/22 to-warning/8 text-warning border-warning/30 glow-warning',
  red:    'bg-gradient-to-br from-danger/22 to-danger/8 text-danger border-danger/30 glow-danger',
  orange: 'bg-gradient-to-br from-attention/22 to-attention/8 text-attention border-attention/30',
  green:  'bg-gradient-to-br from-success/22 to-success/8 text-success border-success/30 glow-success',
};

interface Props {
  orderId?: string | null;
  phone?: string | null;
  validationDecision?: 'green' | 'yellow' | 'red' | 'pickup_office' | null;
  missingFields?: string[] | null;
  /** Cantidad de "no contestó" del pedido (para la etiqueta auto "No contesta"). */
  norespCount?: number;
}

/**
 * Etiquetas del pedido en la ficha (Fase 2b). Muestra:
 *  - AUTO (derivadas, read-only): Datos incompletos, No contesta.
 *  - MANUAL (toggleables, compartidas por tienda): Interesado, Difícil.
 * Norte del dueño: lo más automático posible → las auto no requieren acción.
 */
export default function OrderLabels({ orderId, phone, validationDecision, missingFields, norespCount }: Props) {
  const { manualLabels, toggleLabel, tableMissing } = useOrderLabels(orderId, phone);

  const autoKeys = deriveAutoLabels({ validationDecision, missingFields, norespCount });
  const active = new Set<LabelKey>([...autoKeys, ...manualLabels]);
  // Manuales que aún NO están puestas → se ofrecen como "+ agregar".
  const addable = MANUAL_LABELS.filter((l) => !active.has(l.key));

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="w-7 h-7 rounded-xl bg-muted/60 border border-border text-muted-foreground flex items-center justify-center shrink-0" aria-hidden="true">
        <Tag size={13} />
      </span>

      {autoKeys.map((k) => {
        const def = LABELS[k];
        return (
          <span key={k} className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold ${TONE_CHIP[def.tone]}`}>
            {def.text}
            <span className="opacity-60 text-[9px] uppercase">auto</span>
          </span>
        );
      })}

      {manualLabels.map((k) => {
        const def = LABELS[k];
        return (
          <button
            key={k}
            onClick={() => toggleLabel(k)}
            title="Quitar etiqueta"
            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold ${TONE_CHIP[def.tone]} hover:opacity-80`}
          >
            {def.text}
            <X size={10} />
          </button>
        );
      })}

      {!tableMissing && addable.map((def) => (
        <button
          key={def.key}
          onClick={() => toggleLabel(def.key)}
          title={`Etiquetar como ${def.text}`}
          className="inline-flex items-center gap-0.5 rounded-lg border border-dashed border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors"
        >
          <Plus size={10} />
          {def.text}
        </button>
      ))}
    </div>
  );
}
