import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface Props {
  text: string;
  maxChars?: number;
  className?: string;
  /** Si true, usa CSS truncate en lugar de cortar caracteres (respeta ancho del contenedor). */
  cssTruncate?: boolean;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/**
 * Muestra texto truncado con tooltip cuando excede el límite.
 * - Modo charCount (default): corta a `maxChars` y añade "…" solo si excede.
 * - Modo cssTruncate: confía en `truncate` de Tailwind; el tooltip siempre aparece.
 *
 * Siempre envuelve en <Tooltip> cuando hay potencial truncamiento para que la operadora
 * pueda ver el texto completo con hover/focus.
 */
export function TruncatedText({
  text,
  maxChars,
  className,
  cssTruncate = false,
  side = 'top',
}: Props) {
  const safeText = text ?? '';

  if (cssTruncate) {
    return (
      <Tooltip delayDuration={250}>
        <TooltipTrigger asChild>
          <span className={className}>{safeText}</span>
        </TooltipTrigger>
        <TooltipContent side={side} className="max-w-xs break-words">
          {safeText}
        </TooltipContent>
      </Tooltip>
    );
  }

  const limit = maxChars ?? 20;
  const needsTruncation = safeText.length > limit;
  const displayed = needsTruncation ? safeText.substring(0, limit) + '…' : safeText;

  if (!needsTruncation) {
    return <span className={className}>{displayed}</span>;
  }

  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        <span className={className}>{displayed}</span>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-xs break-words">
        {safeText}
      </TooltipContent>
    </Tooltip>
  );
}
