import type { ReactNode } from 'react';

interface RankRowProps {
  position: number;
  name: string;
  /** Porcentaje 0-100 que llena la barra. */
  pct: number;
  /** Texto secundario a la derecha del nombre (ej. "63 gest."). */
  detail?: string;
  /** Resalta la fila del usuario actual. */
  isMe?: boolean;
  /**
   * Clase de color del porcentaje. La decide QUIEN LLAMA, porque el umbral de
   * "buena tasa" es de negocio (CONF_TARGET_PCT), no de presentación.
   * Hardcodear text-success acá pintaba de verde una tasa del 20%.
   */
  pctClassName?: string;
  /** Nodo a la izquierda de la posición (ej. un trofeo para el primero). */
  badge?: ReactNode;
  /**
   * Avatar con la inicial del nombre. Tiene sentido para PERSONAS (el ranking
   * de operadoras, para el que nació este componente); para un ranking de
   * productos dibuja un círculo con la primera letra del nombre del producto,
   * que no significa nada. Default true para no cambiar los call-sites que ya
   * existen.
   */
  showAvatar?: boolean;
}

/**
 * Fila del ranking del equipo: posición, avatar con inicial, nombre, detalle,
 * porcentaje y barra proporcional.
 *
 * La fila propia va con fondo de acento y glow — el handoff quiere que la
 * operadora se encuentre de un vistazo. Presentación pura.
 */
export default function RankRow({
  position, name, pct, detail, isMe = false,
  pctClassName = 'text-foreground', badge, showAvatar = true,
}: RankRowProps) {
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
        <span className="w-6 flex items-center justify-center flex-shrink-0">
          {badge ?? (
            <span className={`font-mono tabular-nums text-center font-bold text-[15px] ${
              position === 1 ? 'text-warning num-glow-accent' : 'text-muted-foreground'
            }`}>
              {position}
            </span>
          )}
        </span>
        {showAvatar && (
          <span
            aria-hidden="true"
            className={`w-9 h-9 rounded-xl flex items-center justify-center text-[13px] font-bold flex-shrink-0 ${
              isMe ? 'bg-accent-gradient text-accent-foreground glow-accent' : 'bg-muted/60 text-muted-foreground'
            }`}
          >
            {initial}
          </span>
        )}
        {/* `truncate` sin `title` esconde el dato: los nombres de producto de
            Dropi son largos y se diferencian por el FINAL ("PACK X2 …" vs
            "PACK X3 …"). El hover tiene que poder revelarlo entero. */}
        <span className="flex-1 min-w-0 text-[13px] font-semibold text-foreground truncate" title={name}>
          {name}
          {isMe && (
            <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-accent/25 text-accent">
              Tú
            </span>
          )}
        </span>
        {detail && <span className="font-mono tabular-nums text-xs text-muted-foreground flex-shrink-0">{detail}</span>}
        <span className={`font-mono tabular-nums text-sm font-bold flex-shrink-0 ${pctClassName}`}>{Math.round(pct)}%</span>
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
