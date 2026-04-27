import { memo, useCallback } from 'react';
import { Calendar } from 'lucide-react';

interface Range {
  fromDate: string;
  toDate: string;
}

interface Props {
  value: Range;
  onChange: (next: Range) => void;
}

const PRESETS: { label: string; days: number }[] = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

export default memo(function DateRangeFilter({ value, onChange }: Props) {
  const applyPreset = useCallback((days: number) => {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - days);
    onChange({ fromDate: isoDate(from), toDate: isoDate(to) });
  }, [onChange]);

  // Detecta cuál preset coincide para resaltar.
  const activePreset = PRESETS.find(p => {
    const expectedFrom = new Date();
    expectedFrom.setDate(expectedFrom.getDate() - p.days);
    return isoDate(expectedFrom) === value.fromDate
        && isoDate(new Date()) === value.toDate;
  })?.label;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Calendar size={14} className="text-muted-foreground" aria-hidden="true" />
      <span className="text-xs text-muted-foreground">Rango:</span>
      <div className="flex gap-1">
        {PRESETS.map(p => (
          <button
            key={p.label}
            type="button"
            onClick={() => applyPreset(p.days)}
            aria-pressed={activePreset === p.label}
            className={`px-3 py-1 rounded-lg text-xs font-semibold border transition-colors ${
              activePreset === p.label
                ? 'bg-accent text-accent-foreground border-accent'
                : 'bg-card text-muted-foreground border-border hover:text-foreground'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <input
        type="date"
        value={value.fromDate}
        max={value.toDate}
        onChange={e => onChange({ ...value, fromDate: e.target.value })}
        aria-label="Desde"
        className="text-xs px-2 py-1 rounded-lg bg-card border border-border focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <span className="text-xs text-muted-foreground">→</span>
      <input
        type="date"
        value={value.toDate}
        min={value.fromDate}
        onChange={e => onChange({ ...value, toDate: e.target.value })}
        aria-label="Hasta"
        className="text-xs px-2 py-1 rounded-lg bg-card border border-border focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
    </div>
  );
});
