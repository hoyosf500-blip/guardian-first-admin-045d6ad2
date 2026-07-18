import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export interface RailItem {
  path: string;
  icon: LucideIcon;
  label: string;
}

interface IconRailProps {
  items: RailItem[];
  activePath: string;
  onNavigate: (path: string) => void;
  /** Muestra la palabra bajo el ícono. En móvil el rail se ensancha y va true. */
  showLabels?: boolean;
  /** Bloque de marca / selector de tienda, arriba del nav. */
  top?: ReactNode;
  /** Bloque de usuario, al pie. */
  bottom?: ReactNode;
  className?: string;
}

/**
 * Rail de navegación de 80px, solo íconos (fiel al mockup).
 *
 * El nombre de cada sección viaja en `title` y en `aria-label`, así que el
 * tooltip nativo y los lectores de pantalla lo anuncian aunque no se dibuje.
 * En móvil el rail se ensancha y `showLabels` lo pasa a ícono + texto.
 *
 * Presentación pura: recibe los ítems ya filtrados por rol y un callback de
 * navegación. No conoce roles, rutas ni react-router.
 */
export default function IconRail({
  items, activePath, onNavigate, showLabels = false, top, bottom, className = '',
}: IconRailProps) {
  return (
    <div className={`flex flex-col flex-shrink-0 h-full ${className}`}>
      {top && <div className="flex-shrink-0">{top}</div>}

      <nav aria-label="Secciones del CRM" className="flex-1 overflow-y-auto py-3 px-2 space-y-1.5">
        {items.map(item => {
          const Icon = item.icon;
          const isActive = activePath.startsWith(item.path);
          return (
            <button
              key={item.path}
              onClick={() => onNavigate(item.path)}
              aria-current={isActive ? 'page' : undefined}
              aria-label={item.label}
              title={item.label}
              className={[
                'w-full flex items-center rounded-xl cursor-pointer border',
                'transition-colors duration-200',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                showLabels ? 'gap-3 px-3 py-2.5' : 'flex-col gap-1 justify-center py-3',
                isActive
                  ? 'bg-accent/14 border-accent/30 text-accent shadow-glow3d'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-card/60',
              ].join(' ')}
            >
              <Icon size={20} aria-hidden="true" />
              {showLabels && <span className="text-sm font-medium">{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {bottom && <div className="flex-shrink-0">{bottom}</div>}
    </div>
  );
}
