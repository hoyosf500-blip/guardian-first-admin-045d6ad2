import { Menu } from 'lucide-react';
import type { ReactNode } from 'react';

interface HudTopbarProps {
  title: string;
  /** Rótulo mono tras una barra (ej. "Dashboard / OPERADORA"). */
  section?: string;
  /** Reloj, toggle de tema, avatar. */
  right?: ReactNode;
  /** Si se pasa, aparece el botón hamburguesa (solo móvil). */
  onMenu?: () => void;
}

/**
 * Barra superior HUD de 52px: título de sección, rótulo mono tras una barra,
 * chip "SISTEMA EN LÍNEA" con latido y slot derecho.
 *
 * Presentación pura: no sabe qué ruta está activa ni quién es el usuario;
 * recibe strings y nodos.
 */
export default function HudTopbar({ title, section, right, onMenu }: HudTopbarProps) {
  return (
    <header className="h-[52px] flex-shrink-0 flex items-center justify-between gap-3 px-4 border-b border-border bg-surface/80">
      <div className="flex items-center gap-3 min-w-0">
        {onMenu && (
          <button
            onClick={onMenu}
            aria-label="Abrir menú"
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-card transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <Menu size={18} aria-hidden="true" />
          </button>
        )}
        <h1 className="text-sm font-semibold text-foreground truncate">{title}</h1>
        {section && (
          <span className="hud-label text-subtle truncate hidden sm:block">/ {section.toUpperCase()}</span>
        )}
      </div>

      <div className="flex items-center gap-2.5 flex-shrink-0">
        <span className="hidden md:inline-flex items-center gap-2 hud-label text-cyan">
          <span
            aria-hidden="true"
            className="w-1.5 h-1.5 rounded-full bg-cyan animate-gb-pulse"
            style={{ boxShadow: '0 0 8px hsl(var(--cyan))' }}
          />
          Sistema en línea
        </span>
        {right}
      </div>
    </header>
  );
}
