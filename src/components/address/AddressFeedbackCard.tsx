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
   * "Calle 21 # 10-78, Barrio el 12, Fonseca, La Guajira" cuando está completa,
   * o "Calle 7A en Tumaco, Nariño" cuando faltan partes (sin placeholders).
   * Cuando faltan datos, `missingNote` describe en lenguaje natural qué
   * confirmar con el cliente (ej. "Falta confirmar: pídele al cliente el
   * número exacto de la casa con guion (ej. 23-45)."). Se renderiza en
   * yellow/red bajo el label "Cómo debería verse esta dirección" sólo si
   * hasEnoughInfo es true.
   */
  addressSuggestion?: {
    suggested: string;
    missingNote?: string | null;
    hasEnoughInfo: boolean;
  } | null;
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
  /**
   * True mientras useGoogleAddressLookup está buscando la dirección real
   * en Google Places. Mostramos un indicador sutil debajo del bloque "Cómo
   * debería verse" para que la operadora sepa que la sugerencia puede
   * mejorar en breve. Si Google devuelve, addressSuggestion se actualiza
   * y este flag desaparece. NO bloquea el render.
   */
  lookupLoading?: boolean;
}

export function AddressFeedbackCard({
  decision, missingFields, suggestedAddress, onApplySuggestion, addressSuggestion, isAdmin, onOverrideChange, carrier, loading = false, lookupLoading = false,
}: AddressFeedbackCardProps) {
  const [overrideChecked, setOverrideChecked] = useState(false);
  const handleOverrideChange = (checked: boolean) => {
    setOverrideChecked(checked);
    onOverrideChange(checked);
  };

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
            {addressSuggestion.missingNote ? (
              <div className="text-warning text-[11px] pl-4 mt-1">
                {addressSuggestion.missingNote}
              </div>
            ) : (
              <div className="text-muted-foreground text-[10px] pl-4">
                Confirma con el cliente que sea correcta.
              </div>
            )}
          </div>
        )}
        {lookupLoading && !addressSuggestion?.hasEnoughInfo && (
          <div className="text-muted-foreground text-[10px] pl-4 mt-1 animate-pulse">
            Buscando dirección en Google Maps...
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
        {/* Validador-direcciones: checkbox de override para destrabar el gate
            de Confirmar. En yellow CUALQUIER usuario puede marcarlo (no
            requiere isAdmin) — la regla del spec es que el admin solo es
            necesario para red. La operadora marca este check después de
            hablar con el cliente y confirmar los datos. */}
        <label className="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground">
          <Checkbox checked={overrideChecked} onCheckedChange={(v) => handleOverrideChange(v === true)} />
          <span>Confirmé con el cliente — proceder a despachar</span>
        </label>
      </div>
    );
  }

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
          {addressSuggestion.missingNote ? (
            <div className="text-warning text-[11px] pl-4 mt-1">
              {addressSuggestion.missingNote}
            </div>
          ) : (
            <div className="text-muted-foreground text-[10px] pl-4">
              Confirma con el cliente que sea correcta.
            </div>
          )}
        </div>
      )}

      {lookupLoading && !addressSuggestion?.hasEnoughInfo && (
        <div className="text-muted-foreground text-[10px] pl-4 mt-1 animate-pulse">
          Buscando dirección en Google Maps...
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

      {/* Validador-direcciones: checkbox de override para destrabar el gate
          de Confirmar también en RED. Antes solo se renderizaba para isAdmin,
          lo que dejaba a la operadora sin manera de confirmar pedidos válidos
          que el heurístico/Google/Haiku marcaba mal (rural, barrios nuevos,
          complementos ambiguos como "18a19"). Ahora cualquier usuario puede
          destrabar tras confirmar verbalmente con el cliente — el texto es
          enfático para que entienda que asume responsabilidad por el despacho. */}
      <label className="flex items-start gap-2 cursor-pointer text-xs text-foreground border-t border-danger/30 pt-2 mt-1">
        <Checkbox
          checked={overrideChecked}
          onCheckedChange={(v) => handleOverrideChange(v === true)}
          className="mt-0.5"
        />
        <span>
          <span className="font-semibold text-danger">Verifiqué la dirección con el cliente al teléfono</span>{' '}
          <span className="text-muted-foreground">— proceder a despachar bajo mi responsabilidad</span>
          {!isAdmin && (
            <span className="block text-[10px] text-muted-foreground/80 mt-0.5">
              Si la dirección es incorrecta, el pedido se devuelve.
            </span>
          )}
        </span>
      </label>
    </div>
  );
}
