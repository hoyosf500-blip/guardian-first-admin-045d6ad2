import { Plug, ArrowRight } from 'lucide-react';

/**
 * Aviso de "todavía falta conectar Dropi", visible DENTRO del CRM.
 *
 * Reemplaza al portón: antes, una tienda sin `dropi_api_key` no mostraba la app
 * sino el asistente a pantalla completa, y si la verificación tenía una falla
 * bloqueante no había ningún botón de salida — el dueño quedaba encerrado en la
 * pantalla de credenciales. Se vio en el recorrido real del 2026-08-13.
 *
 * Ahora el asistente es una AYUDA, no una condición: se entra igual y esto
 * queda arriba en todas las pantallas hasta que la clave esté cargada.
 *
 * No se puede cerrar a propósito. Sin credenciales el CRM está vacío, y un
 * tablero vacío sin explicación se lee como "Guardian no sirve": el aviso es
 * justamente lo que evita esa conclusión.
 */
export default function ConectarDropiBanner({ onAbrir }: { onAbrir: () => void }) {
  return (
    <div
      role="status"
      className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 shadow-card3d"
    >
      <span
        className="w-9 h-9 rounded-xl bg-warning/15 border border-warning/30 text-warning flex items-center justify-center flex-shrink-0"
        aria-hidden="true"
      >
        <Plug size={16} />
      </span>
      <div className="min-w-0 flex-1 text-xs text-foreground">
        <p className="font-semibold text-sm">Te falta conectar tu cuenta de Dropi</p>
        <p className="text-muted-foreground mt-0.5">
          Podés mirar Guardian, pero hasta que la conectes tus pedidos no van a entrar y las
          pantallas van a estar vacías. Son dos minutos.
        </p>
      </div>
      <button
        type="button"
        onClick={onAbrir}
        className="inline-flex items-center gap-2 px-4 h-10 rounded-lg bg-accent text-accent-foreground text-sm font-semibold hover:opacity-90 transition cursor-pointer flex-shrink-0"
      >
        Conectar ahora
        <ArrowRight size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
