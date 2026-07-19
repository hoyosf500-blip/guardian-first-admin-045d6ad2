import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  message?: string;
  onRetry?: () => void;
}

export default function LogisticsErrorState({ message, onRetry }: Props) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/40 px-6 py-16 shadow-card3d text-center" role="alert">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10">
        <AlertTriangle size={20} className="text-red-500" aria-hidden="true" />
      </div>
      <h3 className="text-base font-semibold text-foreground">No se pudo cargar la información</h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        {message || 'Verifica tu conexión o tu rol de admin.'}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold hover:border-border-strong"
        >
          <RefreshCw size={14} aria-hidden="true" /> Reintentar
        </button>
      )}
    </div>
  );
}
