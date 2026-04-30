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
}

export function DespachoGateButton({ gate, onConfirm, children, variant = 'default', size = 'default' }: Props) {
  const result = canConfirmOrder(gate);

  if (result.canConfirm) {
    return <Button variant={variant} size={size} onClick={onConfirm}>{children}</Button>;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-block">
            <Button variant={variant} size={size} disabled>{children}</Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{result.reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
