import { Check } from 'lucide-react';

/**
 * Barra de pasos del onboarding del dueño nuevo. Presentación pura: recibe el
 * paso actual y nada más. Sirve para que el cliente sepa cuánto le falta —
 * antes el flujo eran dos pantallas sueltas que parecían el final del camino.
 */
export const PASOS_ONBOARDING = [
  { n: 1, titulo: 'Crear tu tienda' },
  { n: 2, titulo: 'Conectar Dropi' },
  { n: 3, titulo: 'Entrar a Configuración' },
] as const;

export default function OnboardingStepper({ actual }: { actual: 1 | 2 | 3 }) {
  return (
    <ol
      className="flex items-center gap-2 sm:gap-3"
      aria-label={`Paso ${actual} de ${PASOS_ONBOARDING.length}`}
    >
      {PASOS_ONBOARDING.map((p, i) => {
        const hecho = p.n < actual;
        const activo = p.n === actual;
        return (
          <li key={p.n} className="flex items-center gap-2 min-w-0">
            <span
              aria-hidden
              className={[
                'w-6 h-6 shrink-0 rounded-full border flex items-center justify-center text-[11px] font-bold',
                hecho
                  ? 'bg-success/15 border-success/40 text-success'
                  : activo
                    ? 'bg-accent text-accent-foreground border-accent'
                    : 'bg-muted/40 border-border text-muted-foreground',
              ].join(' ')}
            >
              {hecho ? <Check size={13} /> : p.n}
            </span>
            <span
              className={[
                'text-[11px] sm:text-xs truncate',
                activo ? 'font-semibold text-foreground' : 'text-muted-foreground',
              ].join(' ')}
            >
              {p.titulo}
              {activo && <span className="sr-only"> (paso actual)</span>}
              {hecho && <span className="sr-only"> (completado)</span>}
            </span>
            {i < PASOS_ONBOARDING.length - 1 && (
              <span aria-hidden className="hidden sm:block w-6 h-px bg-border" />
            )}
          </li>
        );
      })}
    </ol>
  );
}
