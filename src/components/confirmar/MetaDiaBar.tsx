import { Target, Flame } from 'lucide-react';
import { useRachaRapida } from '@/hooks/useRachaRapida';

/**
 * Meta del día = COBERTURA, no un número fijo. La regla del dueño (25-ago-2026):
 * "si me entran 100 pedidos al día, que a los 100 se les llame — que nada se
 * enfríe". Entonces la barra mide cuántos de la cola YA recibieron un intento y
 * cuántos siguen SIN TOCAR (enfriándose). La meta es 0 sin tocar.
 *
 * A la derecha, la racha de pedidos rápidos (engancha como un juego). `sinTocar`
 * null = no se pudo medir la cobertura → "—", nunca 0 (un 0 falso diría "todos
 * llamados" con clientes fríos esperando).
 */
export default function MetaDiaBar({ total, sinTocar }: {
  total: number;
  sinTocar: number | null;
}) {
  const { racha } = useRachaRapida();
  const medible = sinTocar != null;
  const llamados = medible ? Math.max(0, total - (sinTocar as number)) : 0;
  const pct = medible && total > 0 ? Math.round((llamados / total) * 100) : 0;
  const colaVacia = total === 0;
  const todosLlamados = medible && sinTocar === 0;
  const logrado = colaVacia || todosLlamados;

  const barra = logrado ? 'bg-success' : 'bg-accent-gradient';

  return (
    <div className="mb-3 rounded-xl border border-border bg-card/40 px-3.5 py-2.5">
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <Target size={15} className={logrado ? 'text-success' : 'text-accent'} aria-hidden="true" />
        <span className="text-xs font-bold text-foreground">Meta del día · que a todos se les llame</span>
        {!medible ? (
          <span className="text-xs text-muted-foreground italic">— no se pudo leer la cobertura</span>
        ) : colaVacia ? (
          <span className="text-xs text-success font-semibold">cola en cero · nada frío ✓</span>
        ) : todosLlamados ? (
          <span className="text-xs text-success font-semibold">todos con primer intento · nada frío 🎉</span>
        ) : (
          <span className="text-xs text-muted-foreground">
            llamados <strong className="tabular-nums text-foreground">{llamados}</strong> de {total} ·{' '}
            <strong className="tabular-nums text-danger">{sinTocar}</strong> sin tocar
            <span className="text-danger"> (se enfrían)</span>
          </span>
        )}
        {racha >= 3 && (
          <span
            className="ml-auto inline-flex items-center gap-1 rounded-lg bg-warning/15 px-2 py-0.5 text-[11px] font-bold text-warning"
            title="Pedidos seguidos gestionados en menos de 3 minutos. Se rompe si te demorás."
          >
            <Flame size={12} aria-hidden="true" />
            {racha} seguidos
          </span>
        )}
      </div>
      <div
        className="relative h-2.5 w-full rounded-full bg-foreground/10 overflow-hidden"
        role="progressbar"
        aria-valuenow={medible ? pct : 0}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Cobertura de la cola: cuántos recibieron un primer intento"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-700 ${barra}`}
          style={{ width: `${logrado ? 100 : pct}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
