import { useState } from 'react';
import { MapPin, Check, ChevronsUpDown, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { useCityList } from '@/hooks/useCityList';

interface Props {
  /** Ciudad seleccionada (undefined = "Todas las ciudades"). */
  value?: string;
  onChange: (ciudad: string | undefined) => void;
  /** Tope de ciudades en el dropdown. Default 200. */
  maxCities?: number;
}

/**
 * Combobox con búsqueda de ciudades para filtrar el dashboard de Logística.
 * Default = "Todas las ciudades" (sin filtro).
 *
 * Ejemplo: si hay 200 ciudades en la base, el admin teclea "bog" y aparece
 * BOGOTA, BUGA, etc. para click rápido.
 */
export default function CityFilter({ value, onChange, maxCities = 200 }: Props) {
  const [open, setOpen] = useState(false);
  const cities = useCityList(maxCities);

  const selectedLabel = value ?? 'Todas las ciudades';

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-2 h-9 rounded-lg border border-border bg-card px-3 text-xs hover:border-border-strong hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none transition-colors"
            aria-label="Filtrar por ciudad"
          >
            <MapPin size={13} className={value ? 'text-info' : 'text-muted-foreground'} aria-hidden="true" />
            <span className={`truncate max-w-[160px] ${value ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
              {selectedLabel}
            </span>
            <ChevronsUpDown size={12} className="text-muted-foreground shrink-0" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="Buscar ciudad…" className="h-9 text-xs" />
            <CommandList>
              <CommandEmpty>
                {cities.isLoading ? 'Cargando ciudades…' : 'No se encontró ninguna ciudad.'}
              </CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value="todas"
                  onSelect={() => { onChange(undefined); setOpen(false); }}
                  className="text-xs"
                >
                  <Check size={13} className={`mr-2 ${!value ? 'opacity-100' : 'opacity-0'}`} aria-hidden="true" />
                  <span className="font-medium">Todas las ciudades</span>
                </CommandItem>
                {(cities.data ?? []).map(c => (
                  <CommandItem
                    key={`${c.ciudad}|${c.departamento}`}
                    value={`${c.ciudad} ${c.departamento}`}
                    onSelect={() => { onChange(c.ciudad); setOpen(false); }}
                    className="text-xs"
                  >
                    <Check
                      size={13}
                      className={`mr-2 ${value === c.ciudad ? 'opacity-100' : 'opacity-0'}`}
                      aria-hidden="true"
                    />
                    <span className="font-medium truncate">{c.ciudad}</span>
                    {c.departamento && (
                      <span className="ml-1.5 text-muted-foreground/70 truncate">· {c.departamento}</span>
                    )}
                    <span className="ml-auto text-[10px] text-muted-foreground tabular-nums shrink-0">
                      {c.total_pedidos.toLocaleString('es-CO')}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* Botón limpiar — solo visible cuando hay ciudad seleccionada */}
      {value && (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label="Limpiar filtro de ciudad"
          title="Quitar filtro de ciudad"
        >
          <X size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
