import { useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';

/**
 * Desplegable CON BÚSQUEDA para provincia/ciudad del editor de orden (Ecuador).
 * El operador ESCRIBE para filtrar y CLICKEA — no tipea el nombre libre (que se
 * equivocaba y rompía el envío). Ej.: en una lista de 56 ciudades de Pichincha,
 * teclea "qui" y aparece QUITO al toque, en vez de scrollear hasta encontrarlo.
 *
 * Mismo patrón (Command + Popover) que CityFilter del dashboard de Logística.
 */
interface Props {
  value: string;
  onSelect: (v: string) => void;
  options: string[];
  placeholder: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  /** Ítem extra fijo al final (ej. "➕ Otra ciudad"). Su value se pasa a onSelect. */
  extra?: { value: string; label: string };
}

export default function GeoCombobox({
  value,
  onSelect,
  options,
  placeholder,
  searchPlaceholder = 'Buscar…',
  disabled = false,
  extra,
}: Props) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          // Réplica del estilo de SelectTrigger de shadcn para no romper la simetría
          // con el resto del formulario (Colombia sigue usando <Select>).
          className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className={value ? 'text-foreground truncate' : 'text-muted-foreground truncate'}>
            {value || placeholder}
          </span>
          <ChevronsUpDown size={14} className="ml-2 shrink-0 opacity-50" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} className="h-9 text-sm" />
          <CommandList>
            <CommandEmpty>Sin resultados.</CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt}
                  value={opt}
                  onSelect={() => { onSelect(opt); setOpen(false); }}
                  className="text-sm"
                >
                  <Check
                    size={14}
                    className={`mr-2 ${value === opt ? 'opacity-100' : 'opacity-0'}`}
                    aria-hidden="true"
                  />
                  <span className="truncate">{opt}</span>
                </CommandItem>
              ))}
              {extra && (
                <CommandItem
                  key={extra.value}
                  value={extra.label}
                  onSelect={() => { onSelect(extra.value); setOpen(false); }}
                  className="text-sm text-accent"
                >
                  <span className="ml-6 truncate">{extra.label}</span>
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
