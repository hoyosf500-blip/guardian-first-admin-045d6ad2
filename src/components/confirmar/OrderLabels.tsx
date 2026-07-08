import { Tag, X, Plus } from 'lucide-react';
import { useOrderLabels } from '@/hooks/useOrderLabels';
import {
  deriveAutoLabels, LABELS, MANUAL_LABELS, type LabelKey, type LabelDef,
} from '@/lib/orderLabels';

// Colores estándar de Tailwind (opacidad garantizada) por tono.
const TONE_CHIP: Record<LabelDef['tone'], string> = {
  yellow: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  red:    'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30',
  orange: 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30',
  green:  'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
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
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      <Tag size={12} className="text-muted-foreground shrink-0" />

      {autoKeys.map((k) => {
        const def = LABELS[k];
        return (
          <span key={k} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE_CHIP[def.tone]}`}>
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
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE_CHIP[def.tone]} hover:opacity-80`}
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
          className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-input px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-foreground/30"
        >
          <Plus size={10} />
          {def.text}
        </button>
      ))}
    </div>
  );
}
