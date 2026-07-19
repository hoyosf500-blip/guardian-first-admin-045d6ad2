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
        <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span className="inline-block h-2 w-2 rounded-full bg-warning animate-pulse" aria-hidden />
          <span>Validando dirección...</span>
        </div>
      );
    }
    // Estado terminal: la auto-validación corrió y nadie pudo decidir
    // (edge function devolvió decision:null o el fallback heurístico tampoco
    // resolvió). Card estática para que la operadora siga trabajando.
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/50" aria-hidden />
        <span>Sin validar — escribir libre</span>
      </div>
    );
  }

  if (decision === 'green') {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
        <Check size={14} />
        <span>Dirección verificada</span>
      </div>
    );
  }

  if (decision === 'pickup_office') {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-info/40 bg-info/10 px-3 py-2 text-sm text-info">
        <Store size={14} />
        <span>Retiro en oficina{carrier ? ` · ${carrier}` : ''}</span>
      </div>
    );
  }

  // ── Cómo se leen las tarjetas amarilla y roja ──────────────────────────
  // NO son errores del sistema: son el guion de lo que la asesora tiene que
  // preguntarle al cliente que tiene al teléfono. Antes eran un bloque macizo
  // de color (fondo al 10%, borde al 40%) donde los chips —que son el dato
  // accionable— desaparecían dentro del mismo tono que la caja.
  // Ahora el color fuerte vive en un rail de 4px y en el chip del ícono (el
  // patrón de avisos del Dashboard), el fondo se retira y los chips quedan
  // como figura sobre fondo. Mismos tokens semánticos, misma jerarquía del
  // semáforo, mismo texto: cambia el reparto del color, no el mensaje.
  if (decision === 'yellow') {
    return (
      <div className="relative overflow-hidden rounded-xl border border-warning/25 bg-warning/[0.07] p-3 pl-4 text-sm space-y-3">
        <span className="absolute left-0 top-2.5 bottom-2.5 w-1 rounded-full bg-warning" aria-hidden="true" />
        <div>
          <div className="mb-2 flex items-center gap-2 text-warning font-semibold">
            <span className="w-6 h-6 rounded-lg bg-warning/14 border border-warning/30 flex items-center justify-center flex-shrink-0" aria-hidden="true">
              <AlertTriangle size={13} />
            </span>
            <span>Confirmar con cliente:</span>
          </div>
          {/* Chips en vez de viñetas (handoff). Tokens por tema, nunca los rgba
              del mockup — el ámbar claro está oscurecido a propósito por
              contraste. text-xs (12px) y no los 11px del mockup: piso de
              legibilidad, las asesoras trabajan desde el celular. */}
          {/* Sigue siendo <ul>/<li>: los chips son una LISTA de campos que
              faltan. Con display:flex el navegador descarta la semántica de
              lista, por eso el role explícito. Preflight ya quita marcador,
              margen y padding, así que se ve idéntico a un <div>. */}
          {/* pl-8 = ancho del chip del ícono + gap: los chips cuelgan del
              rótulo como una lista guiada, no flotan sueltos en la caja. */}
          <ul role="list" className="flex flex-wrap gap-1.5 pl-8">
            {missingFields.length > 0
              ? missingFields.map((f) => (
                  <li role="listitem" key={f} className="text-xs font-semibold px-2 py-1 rounded-lg bg-warning/14 text-warning border border-warning/30">{FIELD_LABEL_ES[f] ?? f}</li>
                ))
              : <li role="listitem" className="text-xs font-semibold px-2 py-1 rounded-lg bg-warning/14 text-warning border border-warning/30">Verifica datos clave antes de despachar</li>}
          </ul>
        </div>
        {/* Sugerencias de Google Maps removidas a pedido — la operadora
            verifica la dirección directamente con el cliente al teléfono. */}
        {/* Checkbox de override removido — el semáforo es informativo, no bloquea. */}
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-xl border border-danger/25 bg-danger/[0.07] p-3 pl-4 text-sm space-y-3">
      <span className="absolute left-0 top-2.5 bottom-2.5 w-1 rounded-full bg-danger" aria-hidden="true" />
      <div>
        <div className="mb-2 flex items-center gap-2 text-danger font-semibold">
          <span className="w-6 h-6 rounded-lg bg-danger/14 border border-danger/30 flex items-center justify-center flex-shrink-0" aria-hidden="true">
            <AlertCircle size={13} />
          </span>
          <span>Falta:</span>
        </div>
        <ul role="list" className="flex flex-wrap gap-1.5 pl-8">
          {missingFields.map((f) => (
            <li role="listitem" key={f} className="text-xs font-semibold px-2 py-1 rounded-lg bg-danger/14 text-danger border border-danger/30">{FIELD_LABEL_ES[f] ?? f}</li>
          ))}
        </ul>
      </div>

      {/* Sugerencias de Google Maps removidas a pedido. */}

      {/* Checkbox de override removido — el semáforo es informativo, no bloquea. */}
    </div>
  );
}
