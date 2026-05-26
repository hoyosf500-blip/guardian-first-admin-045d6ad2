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

// `days = null` significa "Histórico" (desde el inicio de los registros
// hasta hoy). Usamos 2020-01-01 como ancla — Dropi Colombia empezó a
// operar bastante después, así que cubre todo el histórico real.
const HISTORICO_FROM = '2020-01-01';

// `kind: 'month'` = mes calendario actual (1ro → hoy). Es el default del panel
// (ver LogisticaTab.defaultRange) — el dueño quiere "cómo voy este mes".
type Preset = { label: string; days: number | null; kind?: 'month' };
const PRESETS: Preset[] = [
  { label: 'Mes actual', days: null, kind: 'month' },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '365d', days: 365 },
  { label: 'Histórico', days: null },
];

// Fecha en formato YYYY-MM-DD usando hora LOCAL (no toISOString, que en CO
// de noche —UTC-5— adelanta el día y corre el rango).
const pad2 = (n: number) => String(n).padStart(2, '0');
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function firstOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export default memo(function DateRangeFilter({ value, onChange }: Props) {
  const applyPreset = useCallback((p: Preset) => {
    const to = new Date();
    if (p.kind === 'month') {
      onChange({ fromDate: isoDate(firstOfMonth(to)), toDate: isoDate(to) });
      return;
    }
    if (p.days == null) {
      onChange({ fromDate: HISTORICO_FROM, toDate: isoDate(to) });
      return;
    }
    const from = new Date(to);
    from.setDate(from.getDate() - p.days);
    onChange({ fromDate: isoDate(from), toDate: isoDate(to) });
  }, [onChange]);

  // Detecta cuál preset coincide para resaltar.
  const today = isoDate(new Date());
  const activePreset = PRESETS.find(p => {
    if (p.kind === 'month') {
      return value.fromDate === isoDate(firstOfMonth(new Date())) && value.toDate === today;
    }
    if (p.days == null) {
      return value.fromDate === HISTORICO_FROM && value.toDate === today;
    }
    const expectedFrom = new Date();
    expectedFrom.setDate(expectedFrom.getDate() - p.days);
    return isoDate(expectedFrom) === value.fromDate && today === value.toDate;
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
            onClick={() => applyPreset(p)}
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
