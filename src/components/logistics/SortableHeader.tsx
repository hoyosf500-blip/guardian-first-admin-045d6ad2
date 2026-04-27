import { memo } from 'react';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';

export type SortDir = 'asc' | 'desc';

interface Props<Key extends string> {
  label: string;
  sortKey: Key;
  activeKey: Key | null;
  activeDir: SortDir;
  onSort: (key: Key) => void;
  className?: string;
}

function SortableHeaderInner<Key extends string>({
  label, sortKey, activeKey, activeDir, onSort, className,
}: Props<Key>) {
  const isActive = activeKey === sortKey;
  const Icon = !isActive ? ChevronsUpDown : activeDir === 'asc' ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={`inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider hover:text-foreground transition-colors ${
        isActive ? 'text-foreground' : 'text-muted-foreground'
      } ${className || ''}`}
      aria-sort={isActive ? (activeDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span>{label}</span>
      <Icon size={11} aria-hidden="true" />
    </button>
  );
}

export const SortableHeader = memo(SortableHeaderInner) as typeof SortableHeaderInner;
