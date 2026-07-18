interface RankRowProps {
  position: number;
  name: string;
  /** Porcentaje 0-100 que llena la barra. */
  pct: number;
  /** Texto secundario a la derecha del nombre (ej. "63 gest."). */
  detail?: string;
  /** Resalta la fila del usuario actual. */
  isMe?: boolean;
}

/**
 * Fila del ranking del equipo: posición, avatar con inicial, nombre, detalle,
 * porcentaje y barra proporcional.
 *
 * La fila propia va con fondo de acento y glow — el handoff quiere que la
 * operadora se encuentre de un vistazo. Presentación pura.
 */
export default function RankRow({ position, name, pct, detail, isMe = false }: RankRowProps) {
  const width = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const initial = (name || '?')[0].toUpperCase();

  return (
    <div
      className={[
        'flex flex-col gap-2 px-4 py-3 rounded-2xl border transition-colors duration-200',
        isMe
          ? 'bg-accent/12 border-accent/32 glow-accent'
          : 'bg-card/30 border-border hover:border-border-strong',
      ].join(' ')}
    >
      <div className="flex items-center gap-3">
        <span
          className={`font-mono tabular-nums w-6 text-center font-bold text-[15px] ${
            position === 1 ? 'text-warning num-glow-accent' : 'text-muted-foreground'
          }`}
        >
          {position}
        </span>
        <span
          aria-hidden="true"
          className={`w-9 h-9 rounded-xl flex items-center justify-center text-[13px] font-bold flex-shrink-0 ${
            isMe ? 'bg-accent-gradient text-white glow-accent' : 'bg-muted/60 text-muted-foreground'
          }`}
        >
          {initial}
        </span>
        <span className="flex-1 min-w-0 text-[13px] font-semibold text-foreground truncate">
          {name}
          {isMe && (
            <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-accent/25 text-accent">
              Tú
            </span>
          )}
        </span>
        {detail && <span className="font-mono tabular-nums text-xs text-muted-foreground flex-shrink-0">{detail}</span>}
        <span className="font-mono tabular-nums text-sm font-bold text-success flex-shrink-0">{Math.round(pct)}%</span>
      </div>

      <div className="h-1 rounded-full bg-foreground/10 overflow-hidden">
        <div
          data-testid="rank-bar-fill"
          className="h-full rounded-full bg-accent-gradient"
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}
