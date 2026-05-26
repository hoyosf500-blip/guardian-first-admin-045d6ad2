import { memo, useMemo, useState } from 'react';
import { Calendar as CalendarIcon } from 'lucide-react';
import {
  format, subDays, subMonths, startOfMonth, endOfMonth, isValid,
} from 'date-fns';
import { es } from 'date-fns/locale';
import type { DateRange } from 'react-day-picker';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * Selector de rango de fechas con presets (estilo dashboard).
 *
 * Reemplaza los dos `<input type="date">` por un solo botón que abre un popover
 * con una lista de presets (Hoy / Ayer / Últimos 7·14·30 días / Este mes /
 * Mes anterior / Personalizado) + un calendario para rango manual.
 *
 * El valor entra y sale como ISO `yyyy-MM-dd` (string), igual que lo esperan
 * las RPCs (`p_from`/`p_to` DATE). Las fechas se formatean en hora LOCAL
 * (date-fns `format`), NO con `toISOString()`, para no correrse un día por el
 * desfase UTC en Colombia (UTC-5).
 */

export interface IsoRange {
  from: string; // 'yyyy-MM-dd'
  to: string;   // 'yyyy-MM-dd'
}

interface Props {
  value: IsoRange;
  onChange: (next: IsoRange) => void;
  /** Alinea el popover (default 'start'). */
  align?: 'start' | 'center' | 'end';
}

const toIso = (d: Date): string => format(d, 'yyyy-MM-dd');
const fromIso = (s: string): Date => new Date(`${s}T00:00:00`); // local midnight

interface Preset {
  label: string;
  /** Devuelve el rango calculado en el momento del click. */
  compute: () => { from: Date; to: Date };
}

const PRESETS: Preset[] = [
  { label: 'Hoy', compute: () => ({ from: new Date(), to: new Date() }) },
  { label: 'Ayer', compute: () => { const d = subDays(new Date(), 1); return { from: d, to: d }; } },
  { label: 'Últimos 7 Días', compute: () => ({ from: subDays(new Date(), 6), to: new Date() }) },
  { label: 'Últimos 14 Días', compute: () => ({ from: subDays(new Date(), 13), to: new Date() }) },
  { label: 'Últimos 30 Días', compute: () => ({ from: subDays(new Date(), 29), to: new Date() }) },
  { label: 'Este Mes', compute: () => ({ from: startOfMonth(new Date()), to: new Date() }) },
  {
    label: 'El Mes Anterior',
    compute: () => { const p = subMonths(new Date(), 1); return { from: startOfMonth(p), to: endOfMonth(p) }; },
  },
];

const CUSTOM = 'Personalizado';

export default memo(function PresetDateRangePicker({ value, onChange, align = 'start' }: Props) {
  const [open, setOpen] = useState(false);

  // Preset activo = el que produce exactamente el rango actual (comparando ISO).
  // Si ninguno matchea → "Personalizado".
  const activePreset = useMemo(() => {
    const hit = PRESETS.find((p) => {
      const { from, to } = p.compute();
      return toIso(from) === value.from && toIso(to) === value.to;
    });
    return hit?.label ?? CUSTOM;
  }, [value]);

  // Rango seleccionado para el calendario (en Date locales).
  const selected: DateRange | undefined = useMemo(() => {
    const from = fromIso(value.from);
    const to = fromIso(value.to);
    if (!isValid(from)) return undefined;
    return { from, to: isValid(to) ? to : from };
  }, [value]);

  const triggerLabel = useMemo(() => {
    const f = fromIso(value.from);
    const t = fromIso(value.to);
    if (!isValid(f)) return 'Seleccionar fechas';
    if (value.from === value.to) return format(f, "d 'de' MMM, yyyy", { locale: es });
    return `${format(f, 'd MMM', { locale: es })} – ${format(t, 'd MMM yyyy', { locale: es })}`;
  }, [value]);

  function applyPreset(p: Preset) {
    const { from, to } = p.compute();
    onChange({ from: toIso(from), to: toIso(to) });
    setOpen(false);
  }

  function onCalendarSelect(range: DateRange | undefined) {
    if (!range?.from) return;
    // Primer click → from definido, to aún no: esperamos el segundo click.
    if (!range.to) {
      onChange({ from: toIso(range.from), to: toIso(range.from) });
      return;
    }
    onChange({ from: toIso(range.from), to: toIso(range.to) });
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 h-8 px-3 rounded-lg border border-border bg-card text-xs font-medium text-foreground hover:bg-muted/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <CalendarIcon size={14} className="text-muted-foreground" />
          {triggerLabel}
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-auto p-0 flex" sideOffset={6}>
        {/* Columna de presets */}
        <div className="flex flex-col gap-0.5 p-2 border-r border-border min-w-[150px]">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p)}
              aria-pressed={activePreset === p.label}
              className={`text-left text-xs px-3 py-1.5 rounded-md transition-colors ${
                activePreset === p.label
                  ? 'bg-accent text-accent-foreground font-semibold'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={activePreset === CUSTOM}
            // "Personalizado" no calcula nada: solo indica que el rango actual no
            // matchea un preset. El calendario de la derecha es el que edita.
            className={`text-left text-xs px-3 py-1.5 rounded-md transition-colors ${
              activePreset === CUSTOM
                ? 'bg-accent text-accent-foreground font-semibold'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            }`}
          >
            {CUSTOM}
          </button>
        </div>

        {/* Calendario de rango */}
        <Calendar
          mode="range"
          selected={selected}
          onSelect={onCalendarSelect}
          defaultMonth={isValid(fromIso(value.to)) ? fromIso(value.to) : new Date()}
          numberOfMonths={1}
          locale={es}
          weekStartsOn={0}
        />
      </PopoverContent>
    </Popover>
  );
});
