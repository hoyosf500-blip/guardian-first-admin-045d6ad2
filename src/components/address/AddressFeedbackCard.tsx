import { useState } from 'react';
import { Check, AlertTriangle, AlertCircle, Store, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

const FIELD_LABEL_ES: Record<string, string> = {
  placa: 'placa de la casa',
  barrio: 'barrio',
  complemento: 'punto de referencia',
  telefono: 'teléfono alternativo',
};

export interface AddressFeedbackCardProps {
  decision: 'green' | 'yellow' | 'red' | 'pickup_office' | null;
  missingFields: string[];
  suggestedMessage: string;
  isAdmin: boolean;
  onOverrideChange: (overrideChecked: boolean) => void;
  carrier?: string;
}

export function AddressFeedbackCard({
  decision, missingFields, suggestedMessage, isAdmin, onOverrideChange, carrier,
}: AddressFeedbackCardProps) {
  const [copied, setCopied] = useState(false);
  const [overrideChecked, setOverrideChecked] = useState(false);

  if (decision === null) return null;

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
      <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
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
    );
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(suggestedMessage);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

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

      {suggestedMessage && (
        <div>
          <div className="mb-1 font-medium text-foreground">Mensaje WhatsApp sugerido:</div>
          <div className="rounded bg-card border border-border p-2 text-xs text-muted-foreground whitespace-pre-wrap">
            {suggestedMessage}
          </div>
          <Button size="sm" variant="outline" className="mt-2" onClick={handleCopy}>
            <Copy size={12} className="mr-1" />
            {copied ? 'Copiado' : 'Copiar'}
          </Button>
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
