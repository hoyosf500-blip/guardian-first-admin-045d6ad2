import { useEffect, useRef, useState } from 'react';
import { MapPin, Edit2, Check } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useGooglePlaces } from '@/hooks/useGooglePlaces';
import {
  lookupAutocompleteCache, storeAutocompleteCache, lookupRecurrentCustomer,
} from '@/hooks/useAddressAutocompleteCache';
import { parseGooglePlace } from '@/lib/parseGooglePlace';
import { mapAddressKind } from '@/lib/mapAddressKind';
import { useActiveStoreId } from '@/contexts/StoreContext';

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
  /**
   * Cuántos ms de quietud esperar antes de avisar un texto escrito a mano
   * (`source: 'free_write'`). `0`/ausente = se avisa EN CADA TECLA, que es lo
   * que necesita un formulario controlado (CustomerForm del editor).
   *
   * La ficha de Confirmar lo pone en >0 porque ahí cada `onChange` es una
   * escritura en `orders` y un viaje a Dropi (4-sep-2026): con el aviso por
   * tecla, "Calle 8 #5-67 apto 302" eran ~25 UPDATEs contra una tabla caliente
   * y ninguno llegaba a Dropi. En este modo el aviso sale al quedarse quieto
   * `commitDelayMs`, al salir del campo (blur) o al desmontarse el campo con
   * texto sin avisar — nunca se pierde lo escrito. Elegir una sugerencia o
   * "Usar esta" avisan en el acto (son acciones puntuales, no tipeo).
   */
  commitDelayMs?: number;
}

const DEBOUNCE_MS = 300;
const MIN_CHARS = 3;

/** La tienda activa, tolerante: este input también se monta fuera del
 *  StoreProvider (tests, formularios sueltos). Sin tienda no hay banner de
 *  cliente recurrente — mejor sin sugerencia que con una de otro país. */
function useStoreIdTolerante(): string | null {
  try {
    return useActiveStoreId();
  } catch {
    return null;
  }
}

export function AddressAutocomplete({
  value, onChange, ciudad, departamento, customerPhone, disabled, placeholder, commitDelayMs = 0,
}: Props) {
  const storeId = useStoreIdTolerante();
  const [query, setQuery] = useState(value);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [recurrent, setRecurrent] = useState<{ direccion: string; place_id: string; lat: number | null; lng: number | null } | null>(null);
  const [recurrentDismissed, setRecurrentDismissed] = useState(false);
  const [selectedFromAutocomplete, setSelectedFromAutocomplete] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const places = useGooglePlaces();

  // Modo diferido (ver `commitDelayMs`): lo último que se AVISÓ al padre y el
  // timer del aviso pendiente. Van en refs y no en estado porque los lee el
  // cleanup de desmontaje, que tiene que ver el valor vigente sin re-render.
  const lastCommittedRef = useRef(value);
  const commitTimerRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const avisarLibre = (texto: string) => {
    if (commitTimerRef.current) { window.clearTimeout(commitTimerRef.current); commitTimerRef.current = null; }
    if (texto === lastCommittedRef.current) return;
    lastCommittedRef.current = texto;
    onChangeRef.current({ direccion: texto, address_kind: mapAddressKind(texto), source: 'free_write' });
  };
  // Lo mismo que el blur: lo que quedó escrito sin avisar sale al desmontarse
  // (la asesora pasó al siguiente pedido con el foco todavía en el campo).
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => () => {
    if (commitDelayMs > 0 && commitTimerRef.current) {
      window.clearTimeout(commitTimerRef.current);
      const texto = queryRef.current;
      if (texto !== lastCommittedRef.current) {
        lastCommittedRef.current = texto;
        onChangeRef.current({ direccion: texto, address_kind: mapAddressKind(texto), source: 'free_write' });
      }
    }
  }, [commitDelayMs]);

  useEffect(() => {
    if (!customerPhone || !storeId) return;
    void lookupRecurrentCustomer(customerPhone, storeId, ciudad, departamento).then((hit) => {
      // Sin hit se LIMPIA: si el banner ya estaba puesto y cambia la ciudad (o
      // la tienda), dejarlo colgado ofrecería la dirección del pedido viejo
      // sobre un destino que ya no coincide.
      setRecurrent(hit && hit.direccion !== value
        ? { direccion: hit.direccion, place_id: hit.google_place_id, lat: hit.lat, lng: hit.lng }
        : null);
    });
  }, [customerPhone, value, storeId, ciudad, departamento]);

  // El padre manda un valor nuevo (otro pedido, corrección desde otra pantalla)
  // → se refleja. Pero si lo que llega es el ECO de lo que este campo acaba de
  // avisar (el UPDATE volvió por realtime), no se toca `query`: en modo diferido
  // la asesora pudo seguir escribiendo y el eco le pisaría el texto a medias.
  useEffect(() => {
    if (value === lastCommittedRef.current) return;
    lastCommittedRef.current = value;
    setQuery(value);
  }, [value]);

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

    if (commitDelayMs > 0) {
      if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = window.setTimeout(() => avisarLibre(next), commitDelayMs);
      return;
    }
    lastCommittedRef.current = next;
    onChange({ direccion: next, address_kind: mapAddressKind(next), source: 'free_write' });
  };

  const handleBlur = () => {
    if (commitDelayMs > 0) avisarLibre(query);
  };

  const handleSelect = async (sug: Suggestion) => {
    // Una sugerencia elegida vale más que el tipeo que quedó pendiente.
    if (commitTimerRef.current) { window.clearTimeout(commitTimerRef.current); commitTimerRef.current = null; }
    const details = places.available ? await places.getDetails(sug.place_id) : null;
    if (details) {
      const parsed = parseGooglePlace(details);
      lastCommittedRef.current = parsed.direccion;
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
      lastCommittedRef.current = sug.description;
      onChange({ direccion: sug.description, place_id: sug.place_id, address_kind: 'urban', source: 'autocomplete' });
      setQuery(sug.description);
    }
    setSelectedFromAutocomplete(true);
    setOpen(false);
  };

  const useRecurrent = () => {
    if (!recurrent) return;
    if (commitTimerRef.current) { window.clearTimeout(commitTimerRef.current); commitTimerRef.current = null; }
    setQuery(recurrent.direccion);
    lastCommittedRef.current = recurrent.direccion;
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
          onBlur={handleBlur}
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
