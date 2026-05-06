import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWalletSync } from '@/hooks/useWalletSync';

// Botón "Sincronizar últimos 30 días" reusable.
// Antes vivía inline en BilleteraTab.tsx; al duplicarlo en CfoTab tenía
// sentido extraerlo para no drift-ear el rango de fechas o el toast.

interface Props {
  size?: 'sm' | 'lg';
  variant?: 'outline' | 'default' | 'secondary';
  label?: string;
  className?: string;
}

export default function WalletSyncButton({
  size = 'sm',
  variant = 'outline',
  label = 'Sincronizar últimos 30 días',
  className = '',
}: Props) {
  const sync = useWalletSync();

  function handleClick() {
    const today = new Date();
    const past = new Date();
    past.setDate(past.getDate() - 30);
    sync.mutate({
      from:   past.toISOString().split('T')[0],
      untill: today.toISOString().split('T')[0],
    });
  }

  return (
    <Button onClick={handleClick} disabled={sync.isPending} size={size} variant={variant} className={className}>
      <RefreshCw size={size === 'lg' ? 16 : 14} className={`mr-1.5 ${sync.isPending ? 'animate-spin' : ''}`} />
      {sync.isPending ? 'Sincronizando…' : label}
    </Button>
  );
}
