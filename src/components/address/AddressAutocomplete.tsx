import { useEffect, useRef, useState } from 'react';
import { MapPin, Edit2, Check } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useGooglePlaces } from '@/hooks/useGooglePlaces';
import {
  lookupAutocompleteCache, storeAutocompleteCache, lookupRecurrentCustomer,
} from '@/hooks/useAddressAutocompleteCache';
import { parseGooglePlace } from '@/lib/parseGooglePlace';
import { mapAddressKind } from '@/lib/mapAddressKind';

export interface AddressUpdate {
  direccion: string;
  barrio?: string;
  place_id?: string;
  lat?: number | null;
  lng?: number | null;
  address_kind: 'urban' | 'rural' | 'pickup_office' | 'unknown';
  source: 'autocomplete' | 'free_write' | 'recurrent_customer';
}

interface Suggestion {
  description: string;
  place_id: string;
  structured_formatting?: { main_text: string; secondary_text: string };
}

interface Props {
  value: string;
  onChange: (next: AddressUpdate) => void;
  ciudad?: string;
  departamento?: string;
  customerPhone?: string;
  disabled?: boolean;
  placeholder?: string;
}

const DEBOUNCE_MS = 300;
const MIN_CHARS = 3;

export function AddressAutocomplete({
  value, onChange, ciudad, customerPhone, disabled, placeholder,
}: Props) {
  const [query, setQuery] = useState(value);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [recurrent, setRecurrent] = useState<{ direccion: string; place_id: string; lat: number | null; lng: number | null } | null>(null);
  const [recurrentDismissed, setRecurrentDismissed] = useState(false);
  const [selectedFromAutocomplete, setSelectedFromAutocomplete] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const places = useGooglePlaces();

  useEffect(() => {
    if (!customerPhone) return;
    void lookupRecurrentCustomer(customerPhone).then((hit) => {
      if (hit && hit.direccion !== value) {
        setRecurrent({ direccion: hit.direccion, place_id: hit.google_place_id, lat: hit.lat, lng: hit.lng });
      }
    });
  }, [customerPhone, value]);

  useEffect(() => { setQuery(value); }, [value]);

  const fetchSuggestions = async (q: string) => {
    if (q.length < MIN_CHARS) {
      setSuggestions([]);
      return;
    }
    const cached = await lookupAutocompleteCache(q, ciudad);
    if (cached) {
      setSuggestions(cached);
      setOpen(true);
      return;
    }
    if (places.available) {
      const result = await places.autocomplete(q, ciudad);
      setSuggestions(result);
      setOpen(true);
      void storeAutocompleteCache(q, ciudad, result);
    }
  };

  const handleInput = (next: string) => {
    setQuery(next);
    setSelectedFromAutocomplete(false);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => fetchSuggestions(next), DEBOUNCE_MS);

    onChange({ direccion: next, address_kind: mapAddressKind(next), source: 'free_write' });
  };

  const handleSelect = async (sug: Suggestion) => {
    const details = places.available ? await places.getDetails(sug.place_id) : null;
    if (details) {
      const parsed = parseGooglePlace(details);
      onChange({
        direccion: parsed.direccion,
        barrio: parsed.barrio ?? undefined,
        place_id: parsed.place_id ?? undefined,
        lat: parsed.lat,
        lng: parsed.lng,
        address_kind: parsed.address_kind === 'urban' ? 'urban' : 'unknown',
        source: 'autocomplete',
      });
      setQuery(parsed.direccion);
    } else {
      onChange({ direccion: sug.description, place_id: sug.place_id, address_kind: 'urban', source: 'autocomplete' });
      setQuery(sug.description);
    }
    setSelectedFromAutocomplete(true);
    setOpen(false);
  };

  const useRecurrent = () => {
    if (!recurrent) return;
    setQuery(recurrent.direccion);
    onChange({
      direccion: recurrent.direccion,
      place_id: recurrent.place_id,
      lat: recurrent.lat,
      lng: recurrent.lng,
      address_kind: 'urban',
      source: 'recurrent_customer',
    });
    setRecurrentDismissed(true);
  };

  return (
    <div className="relative w-full space-y-2">
      {recurrent && !recurrentDismissed && (
        <div className="rounded-md border border-info/40 bg-info/10 p-2 text-xs">
          <div className="flex items-center gap-2 text-info font-medium">
            <MapPin size={12} />
            <span>Misma dirección de pedido anterior:</span>
          </div>
          <div className="ml-4 mt-1 text-foreground">{recurrent.direccion}</div>
          <div className="ml-4 mt-1 flex gap-2">
            <button type="button" className="text-info hover:underline" onClick={useRecurrent}>Usar esta</button>
            <button type="button" className="text-muted-foreground hover:underline" onClick={() => setRecurrentDismissed(true)}>Editar nueva</button>
          </div>
        </div>
      )}

      <div className="relative">
        <Input
          value={query}
          onChange={(e) => handleInput(e.target.value)}
          disabled={disabled}
          placeholder={placeholder ?? 'Calle 8 #5-67, Bogotá'}
          onFocus={() => query.length >= MIN_CHARS && suggestions.length > 0 && setOpen(true)}
          className="pr-8"
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground">
          {selectedFromAutocomplete ? <Check size={14} className="text-success" /> : <Edit2 size={14} />}
        </span>
      </div>

      {open && suggestions.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full rounded-md border border-border bg-card shadow-lg">
          {suggestions.slice(0, 5).map((sug) => (
            <li key={sug.place_id}>
              <button
                type="button"
                className="w-full text-left px-3 py-2 hover:bg-muted/40 text-sm"
                onClick={() => handleSelect(sug)}
              >
                <div className="font-medium">{sug.structured_formatting?.main_text ?? sug.description}</div>
                {sug.structured_formatting?.secondary_text && (
                  <div className="text-xs text-muted-foreground">{sug.structured_formatting.secondary_text}</div>
                )}
              </button>
            </li>
          ))}
          <li className="border-t border-border">
            <button
              type="button"
              className="w-full text-left px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40"
              onClick={() => setOpen(false)}
            >
              Mi dirección no está aquí — escribir libre
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
