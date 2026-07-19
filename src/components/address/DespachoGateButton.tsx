import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { canConfirmOrder, type CanConfirmInput } from '@/lib/canConfirmOrder';

interface Props {
  gate: CanConfirmInput;
  onConfirm: () => void;
  children: ReactNode;
  variant?: 'default' | 'outline';
  size?: 'default' | 'sm' | 'lg';
  /** Solo presentación: se pasa tal cual al <Button> en AMBAS ramas (habilitada
   *  y bloqueada) para que el CTA pueda igualar la caja de sus hermanos de fila.
   *  No afecta el gate ni el tooltip. */
  className?: string;
  /** Bloqueo TRANSITORIO ajeno al gate: hay un marcado en vuelo.
   *  La rama bloqueada por el gate ya nacía `disabled`; la habilitada era un
   *  <Button> pelado sin forma de apagarse, así que un segundo click durante
   *  el await de markResult caía sobre el pedido SIGUIENTE (el avance ocurre
   *  antes del await) y lo despachaba sin que nadie lo llamara. */
  disabled?: boolean;
}

export function DespachoGateButton({ gate, onConfirm, children, variant = 'default', size = 'default', className, disabled = false }: Props) {
  const result = canConfirmOrder(gate);

  if (result.canConfirm) {
    return <Button variant={variant} size={size} className={className} disabled={disabled} onClick={onConfirm}>{children}</Button>;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* El <span> es obligatorio: un <button disabled> no emite eventos de
              puntero, así que sin él el TooltipTrigger de Radix perdería en
              silencio el motivo de por qué no se puede confirmar. w-full para
              que la celda del grid no quede a medias. */}
          <span className="inline-block w-full">
            <Button variant={variant} size={size} className={className} disabled>{children}</Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{result.reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
