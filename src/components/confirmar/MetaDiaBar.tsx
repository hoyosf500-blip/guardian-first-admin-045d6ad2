import { Target, Flame } from 'lucide-react';
import { useRachaRapida } from '@/hooks/useRachaRapida';
import { META_GESTIONES_DIA } from '@/lib/responsabilidadAsesor';

/**
 * Meta del día con barra GRANDE + racha de pedidos rápidos. Presión psicológica:
 * la meta deja de ser un número escondido (se ve todo el día) y la racha engancha
 * como un juego ("12 seguidos 🔥"), rompiéndose si se afloja.
 *
 * `gestionados` = lo que YO llevo hoy (myConfirmTouchedToday.size). Presentacional:
 * la racha la calcula useRachaRapida escuchando las marcas.
 */
export default function MetaDiaBar({ gestionados, meta = META_GESTIONES_DIA }: {
  gestionados: number;
  meta?: number;
}) {
  const { racha } = useRachaRapida();
  const faltan = Math.max(0, meta - gestionados);
  const pct = meta > 0 ? Math.min(100, Math.round((gestionados / meta) * 100)) : 0;
  const lograda = gestionados >= meta;
  // Verde cuando ya la alcanzó; acento normal mientras avanza.
  const barra = lograda ? 'bg-success' : 'bg-accent-gradient';

  return (
    <div className="mb-3 rounded-xl border border-border bg-card/40 px-3.5 py-2.5">
      <div className="flex items-center gap-2 mb-1.5">
        <Target size={15} className={lograda ? 'text-success' : 'text-accent'} aria-hidden="true" />
        <span className="text-xs font-bold text-foreground">Meta del día</span>
        <span className="text-xs text-muted-foreground">
          llevás <strong className="tabular-nums text-foreground">{gestionados}</strong>
          {lograda
            ? <span className="text-success font-semibold"> · ¡meta cumplida! 🎉</span>
            : <> · te faltan <strong className="tabular-nums text-foreground">{faltan}</strong> de {meta}</>}
        </span>
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
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Progreso de la meta del día"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-700 ${barra}`}
          style={{ width: `${pct}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
