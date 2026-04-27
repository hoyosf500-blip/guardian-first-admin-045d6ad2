import { memo, useCallback } from 'react';
import { Filter } from 'lucide-react';

interface Props {
  value: number;
  onChange: (n: number) => void;
}

export default memo(function MinOrdersFilter({ value, onChange }: Props) {
  const handle = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const n = parseInt(e.target.value, 10);
    if (Number.isFinite(n) && n >= 1) onChange(n);
  }, [onChange]);

  return (
    <div className="flex items-center gap-2">
      <Filter size={14} className="text-muted-foreground" aria-hidden="true" />
      <label htmlFor="min-orders" className="text-xs text-muted-foreground">
        Mínimo de pedidos:
      </label>
      <input
        id="min-orders"
        type="number"
        min={1}
        max={100}
        value={value}
        onChange={handle}
        className="w-16 text-xs px-2 py-1 rounded-lg bg-card border border-border tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <span className="text-[10px] text-muted-foreground/70">
        (filtra ruido en rankings)
      </span>
    </div>
  );
});
