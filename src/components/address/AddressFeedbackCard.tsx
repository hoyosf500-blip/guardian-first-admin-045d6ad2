import { useState } from 'react';
import { Check, AlertTriangle, AlertCircle, Store, Lightbulb } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

const FIELD_LABEL_ES: Record<string, string> = {
  numero_casa: 'número de la casa (ej. 23-45)',
  tipo_via: 'tipo de vía (Calle, Carrera o Avenida)',
  numero_via: 'número de la calle o carrera',
  barrio: 'barrio',
  referencia: 'cerca de qué queda (referencia)',
  apto_torre: 'apartamento o torre',
  // legacy keys mantenidos por compat:
  placa: 'número de la casa (ej. 23-45)',
  complemento: 'cerca de qué queda (referencia)',
  telefono: 'teléfono alternativo',
};

export interface AddressFeedbackCardProps {
  decision: 'green' | 'yellow' | 'red' | 'pickup_office' | null;
  missingFields: string[];
  /** @deprecated Mensaje WhatsApp eliminado del UI; la operadora improvisa.
   *  Mantenemos el prop opcional para no romper consumidores que aún lo pasan. */
  suggestedMessage?: string;
  /** Dirección sugerida (Google formattedAddress o Haiku) — render como
   *  "¿Quisiste decir: <suggestedAddress>?" en badges yellow/red. */
  suggestedAddress?: string | null;
  /** Callback al hacer click en "Aplicar" sobre la sugerencia. */
  onApplySuggestion?: () => void;
  /**
   * Sugerencia client-side calculada por buildAddressSuggestion — formato
   * "Calle 21 # 10-78, Barrio el 12, Fonseca, La Guajira" o template con
   * placeholders ___ cuando falta info. Se renderiza en yellow/red bajo el
   * label "Cómo debería verse esta dirección" sólo si hasEnoughInfo es true,
   * para que la operadora tenga un molde concreto que confirmar al cliente.
   */
  addressSuggestion?: { suggested: string; hasEnoughInfo: boolean } | null;
  isAdmin: boolean;
  onOverrideChange: (overrideChecked: boolean) => void;
  carrier?: string;
  /**
   * True mientras la auto-validación está en vuelo. Si decision === null y
   * loading === true → placeholder pulsante "Validando...". Si decision ===
   * null y loading === false → estado terminal "Sin validar — escribir libre"
   * (la card no se queda pulsando para siempre cuando la edge function
   * devuelve decision:null o el fallback heurístico tampoco resuelve).
   */
  loading?: boolean;
}

export function AddressFeedbackCard({
  decision, missingFields, suggestedAddress, onApplySuggestion, addressSuggestion, isAdmin, onOverrideChange, carrier, loading = false,
}: AddressFeedbackCardProps) {
  const [overrideChecked, setOverrideChecked] = useState(false);

  if (decision === null) {
    if (loading) {
      // Validador-direcciones: pedidos pre-feature (sync legacy de Dropi/Excel)
      // entran con decision=null. CallView dispara auto-validación al abrirlos
      // — mientras tanto mostramos placeholder pulsante para que la operadora
      // sepa que el sistema está trabajando, en vez de no ver nada.
      return (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span className="inline-block h-2 w-2 rounded-full bg-warning animate-pulse" aria-hidden />
          <span>Validando dirección...</span>
        </div>
      );
    }
    // Estado terminal: la auto-validación corrió y nadie pudo decidir
    // (edge function devolvió decision:null o el fallback heurístico tampoco
    // resolvió). Card estática para que la operadora siga trabajando.
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/50" aria-hidden />
        <span>Sin validar — escribir libre</span>
      </div>
    );
  }

  if (decision === 'green') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
        <Check size={14} />
        <span>Dirección verificada</span>
      </div>
    );
  }

  if (decision === 'pickup_office') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-info/40 bg-info/10 px-3 py-2 text-sm text-info">
        <Store size={14} />
        <span>Retiro en oficina{carrier ? ` · ${carrier}` : ''}</span>
      </div>
    );
  }

  if (decision === 'yellow') {
    return (
      <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm space-y-3">
        <div>
          <div className="mb-1 flex items-center gap-2 text-warning font-medium">
            <AlertTriangle size={14} />
            <span>Confirmar con cliente:</span>
          </div>
          <ul className="ml-6 list-disc text-foreground">
            {missingFields.length > 0
              ? missingFields.map((f) => <li key={f}>{FIELD_LABEL_ES[f] ?? f}</li>)
              : <li>Verifica datos clave antes de despachar</li>}
          </ul>
        </div>
        {addressSuggestion?.hasEnoughInfo && (
          <div className="mt-3 rounded bg-card/40 border border-border/60 p-2 text-xs space-y-1">
            <div className="font-medium text-foreground inline-flex items-center gap-1.5">
              <Lightbulb size={12} className="text-warning" />
              <span>Cómo debería verse esta dirección:</span>
            </div>
            <div className="text-foreground font-mono text-[11px] leading-relaxed pl-4">
              {addressSuggestion.suggested}
            </div>
            <div className="text-muted-foreground text-[10px] pl-4">
              Confirma con el cliente que sea correcta.
            </div>
          </div>
        )}
        {suggestedAddress && (
          <div className="rounded bg-card/50 border border-border p-2 text-xs space-y-1.5">
            <div className="font-medium text-foreground">¿Quisiste decir?</div>
            <div className="text-muted-foreground">{suggestedAddress}</div>
            {onApplySuggestion && (
              <Button size="sm" variant="outline" onClick={onApplySuggestion}>
                Aplicar
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }

  const handleOverride = (checked: boolean) => {
    setOverrideChecked(checked);
    onOverrideChange(checked);
  };

  return (
    <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm space-y-3">
      <div>
        <div className="mb-1 flex items-center gap-2 text-danger font-medium">
          <AlertCircle size={14} />
          <span>Falta:</span>
        </div>
        <ul className="ml-6 list-disc text-foreground">
          {missingFields.map((f) => <li key={f}>{FIELD_LABEL_ES[f] ?? f}</li>)}
        </ul>
      </div>

      {addressSuggestion?.hasEnoughInfo && (
        <div className="mt-3 rounded bg-card/40 border border-border/60 p-2 text-xs space-y-1">
          <div className="font-medium text-foreground inline-flex items-center gap-1.5">
            <Lightbulb size={12} className="text-warning" />
            <span>Cómo debería verse esta dirección:</span>
          </div>
          <div className="text-foreground font-mono text-[11px] leading-relaxed pl-4">
            {addressSuggestion.suggested}
          </div>
          <div className="text-muted-foreground text-[10px] pl-4">
            Confirma con el cliente que sea correcta.
          </div>
        </div>
      )}

      {suggestedAddress && (
        <div className="rounded bg-card/50 border border-border p-2 text-xs space-y-1.5">
          <div className="font-medium text-foreground">¿Quisiste decir?</div>
          <div className="text-muted-foreground">{suggestedAddress}</div>
          {onApplySuggestion && (
            <Button size="sm" variant="outline" onClick={onApplySuggestion}>
              Aplicar
            </Button>
          )}
        </div>
      )}

      {isAdmin && (
        <label className="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground">
          <Checkbox checked={overrideChecked} onCheckedChange={(v) => handleOverride(v === true)} />
          <span>Confirmé manualmente con el cliente — proceder</span>
        </label>
      )}
    </div>
  );
}
