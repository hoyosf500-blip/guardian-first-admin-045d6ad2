import { memo } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Loader2, MapPin, WifiOff } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAddressValidation, type AddressValidationStatus } from '@/hooks/useAddressValidation';

interface Props {
  direccion: string;
  ciudad?: string;
  departamento?: string;
  /** País de la tienda activa (EC/CO) — define las reglas de validación. */
  countryCode?: string;
  /** Tamaño del icono. Default: 14. */
  size?: number;
}

const ISSUE_LABELS: Record<string, string> = {
  empty:           'Dirección vacía',
  too_short:       'Demasiado corta',
  no_via_type:     'Falta tipo de vía (Calle/Carrera/Av/etc.)',
  no_numbers:      'Sin números de calle/casa',
  short_length:    'Algo corta (verifique completitud)',
  repeated_chars:  'Caracteres repetidos sospechosos',
  no_letters:      'Solo números — falta texto',
};

const STATUS_TONE: Record<AddressValidationStatus, {
  icon: typeof CheckCircle2;
  bgClass: string;
  textClass: string;
  ringClass: string;
  label: string;
}> = {
  valid: {
    icon: CheckCircle2,
    bgClass: 'bg-emerald-500/15',
    textClass: 'text-emerald-500',
    ringClass: 'ring-emerald-500/30',
    label: 'Dirección válida',
  },
  suspicious: {
    icon: AlertTriangle,
    bgClass: 'bg-amber-500/15',
    textClass: 'text-amber-500',
    ringClass: 'ring-amber-500/30',
    label: 'Dirección sospechosa',
  },
  invalid: {
    icon: XCircle,
    bgClass: 'bg-red-500/15',
    textClass: 'text-red-500',
    ringClass: 'ring-red-500/30',
    label: 'Dirección inválida',
  },
};

export default memo(function AddressValidationBadge({
  direccion,
  ciudad,
  departamento,
  countryCode,
  size = 14,
}: Props) {
  const validation = useAddressValidation({ direccion, ciudad, departamento, countryCode });

  if (!direccion?.trim()) return null;

  // Loading state
  if (validation.isLoading && !validation.data) {
    return (
      <span
        className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-muted/40"
        aria-label="Validando dirección"
        title="Validando dirección…"
      >
        <Loader2 size={size - 2} className="animate-spin text-muted-foreground" aria-hidden="true" />
      </span>
    );
  }

  // Fallback fatal (no debería pasar — el hook tiene fallback local).
  if (validation.isError || !validation.data) {
    return (
      <span
        className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-muted/40"
        aria-label="No se pudo validar"
        title="No se pudo validar la dirección"
      >
        <WifiOff size={size - 2} className="text-muted-foreground" aria-hidden="true" />
      </span>
    );
  }

  const { status, score, issues, geocoded, localOnly } = validation.data;
  const tone = STATUS_TONE[status];
  const Icon = tone.icon;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center justify-center h-5 w-5 rounded-full ring-1 transition-colors ${tone.bgClass} ${tone.ringClass} hover:ring-2 focus-visible:ring-2 focus-visible:outline-none`}
          aria-label={tone.label}
          title={`${tone.label}${localOnly ? ' (solo formato)' : ''} — click para detalles`}
        >
          <Icon size={size - 2} className={tone.textClass} aria-hidden="true" strokeWidth={2.25} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className={`px-4 py-3 border-b border-border/60 ${tone.bgClass}`}>
          <div className="flex items-center gap-2">
            <Icon size={16} className={tone.textClass} aria-hidden="true" strokeWidth={2.25} />
            <h3 className={`text-sm font-bold ${tone.textClass}`}>{tone.label}</h3>
            <span className="ml-auto text-[11px] font-mono tabular-nums text-muted-foreground">
              {score}/100
            </span>
          </div>
          {localOnly && (
            <p className="text-[10px] text-muted-foreground mt-1 leading-tight">
              ⚡ Solo formato verificado · Geocoding no disponible
            </p>
          )}
        </div>

        <div className="px-4 py-3 space-y-3 text-xs">
          <div>
            <div className="text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground mb-1">
              Dirección ingresada
            </div>
            <p className="text-foreground font-mono leading-relaxed break-words">
              {direccion}
            </p>
            {(ciudad || departamento) && (
              <p className="text-muted-foreground mt-0.5">
                {ciudad}{ciudad && departamento ? ', ' : ''}{departamento}
              </p>
            )}
          </div>

          {issues.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground mb-1">
                Posibles problemas
              </div>
              <ul className="space-y-1">
                {issues.map(code => (
                  <li key={code} className="flex items-start gap-1.5">
                    <span className={`mt-1 h-1 w-1 rounded-full shrink-0 ${tone.bgClass}`} aria-hidden="true" />
                    <span className="text-foreground">{ISSUE_LABELS[code] ?? code}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {geocoded && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground mb-1">
                Encontrada en el mapa
              </div>
              <p className="text-foreground leading-relaxed">{geocoded.display}</p>
              <a
                href={`https://www.google.com/maps?q=${geocoded.lat},${geocoded.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 mt-2 text-[11px] text-info hover:underline"
              >
                <MapPin size={11} aria-hidden="true" />
                Ver en Google Maps
              </a>
            </div>
          )}

          {status === 'suspicious' && !geocoded && !localOnly && (
            <p className="text-[11px] text-muted-foreground italic">
              El formato es razonable pero el mapa no la ubica. Confirme con el cliente si es correcta.
            </p>
          )}

          {status === 'suspicious' && localOnly && (
            <p className="text-[11px] text-muted-foreground italic">
              Formato OK pero no pude verificar si existe en el mapa (servicio de geocoding no disponible).
              Confirme con el cliente si es correcta.
            </p>
          )}

          {status === 'invalid' && (
            <p className="text-[11px] text-muted-foreground italic">
              Pídale al cliente que repita la dirección. Probablemente está incompleta o mal escrita.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
});
