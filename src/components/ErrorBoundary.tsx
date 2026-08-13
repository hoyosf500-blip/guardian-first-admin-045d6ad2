import { Component, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  /** El fallo es "el navegador quedó con la versión vieja tras un deploy". */
  esVersionVieja: boolean;
}

/**
 * Fallo típico DESPUÉS de un deploy: la pestaña quedó abierta con el bundle
 * viejo y, al navegar a una ruta que aún no había cargado, pide un chunk con
 * hash que ya no existe en el servidor. El navegador tira "Failed to fetch
 * dynamically imported module" — un error críptico en inglés que la operadora
 * lee como "el CRM se rompió", cuando alcanza con recargar (auditoría
 * 2026-08-13). No es un bug de la app: es la versión nueva pidiendo pista.
 */
const CHUNK_ERROR_RE =
  /dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch dynamically|ChunkLoadError|Loading chunk \d+ failed|Unable to preload/i;

/** Guard anti-loop: si la recarga automática no resuelve (el chunk falta de
 *  verdad), no volver a recargar en bucle — se muestra el aviso normal. */
const RELOAD_KEY = 'guardian.chunkReloadAt';
const RELOAD_COOLDOWN_MS = 60_000;

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, esVersionVieja: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      esVersionVieja: CHUNK_ERROR_RE.test(String(error?.message ?? '')),
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
    if (!CHUNK_ERROR_RE.test(String(error?.message ?? ''))) return;
    // Recarga automática UNA vez: trae el bundle nuevo y el operador ni se
    // entera. Si ya se recargó hace poco, se respeta el cooldown y queda la
    // pantalla con el botón (mejor un aviso claro que un bucle de recargas).
    let ultima = 0;
    try { ultima = Number(sessionStorage.getItem(RELOAD_KEY) ?? '0') || 0; } catch { /* storage bloqueado */ }
    if (Date.now() - ultima < RELOAD_COOLDOWN_MS) return;
    try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch { /* idem */ }
    window.location.reload();
  }

  render() {
    if (this.state.hasError && this.state.esVersionVieja) {
      // Mensaje HUMANO: no es un error, es una actualización.
      return (
        <div className="flex flex-col items-center justify-center min-h-[50vh] px-6 text-center">
          <div className="w-16 h-16 rounded-2xl bg-info/10 flex items-center justify-center mb-4">
            <RefreshCw size={28} className="text-info" />
          </div>
          <h2 className="text-lg font-bold text-foreground mb-2">Guardian se actualizó</h2>
          <p className="text-sm text-muted-foreground max-w-md mb-4">
            Tu pestaña tenía la versión anterior. Recargá para seguir trabajando con la nueva —
            no perdés nada de lo que hiciste.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
          >
            <RefreshCw size={14} /> Recargar
          </button>
        </div>
      );
    }

    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[50vh] px-6 text-center">
          <div className="w-16 h-16 rounded-2xl bg-red-500/10 flex items-center justify-center mb-4">
            <AlertTriangle size={28} className="text-red-500" />
          </div>
          <h2 className="text-lg font-bold text-foreground mb-2">Algo salió mal</h2>
          <p className="text-sm text-muted-foreground max-w-md mb-1">
            Ocurrió un error inesperado. Recarga la página para continuar.
          </p>
          {this.state.error && (
            <p className="text-xs text-muted-foreground/60 font-mono mb-4 max-w-md truncate">
              {this.state.error.message}
            </p>
          )}
          <button
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
          >
            <RefreshCw size={14} /> Recargar
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
