import { useEffect, useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { NOVEDADES, VENTANA_NUEVO_DIAS, type Novedad } from '@/lib/novedades';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';

/**
 * Campana de "qué hay de nuevo". Vive en la barra de arriba y NUNCA se abre
 * sola.
 *
 * Esa última parte no es un detalle de estilo: el formulario de apertura que
 * bloqueaba la pantalla al entrar (`OpeningReportGate`) hubo que retirarlo por
 * eso mismo. Nadie que entra a trabajar quiere leer un anuncio primero. Acá el
 * único disparador es el clic del usuario, y el panel se cierra con Esc o
 * clic afuera.
 *
 * Tampoco va en la franja de avisos del contenido: ahí viven las cosas que
 * EXIGEN acción (tienda sin confirmar, sync caído). Meter novedades entre esos
 * rojos les baja el precio a los rojos.
 *
 * No hace ninguna consulta: el contenido viaja en el código.
 */

function claveVisto(userId: string) {
  return `guardian.novedades.visto.${userId}`;
}

function leerVisto(userId: string): string | null {
  try {
    return localStorage.getItem(claveVisto(userId));
  } catch {
    // Safari privado / cuota llena. Ante la duda NO molestar: se devuelve una
    // marca imposible de superar para que el punto quede apagado.
    return '9999-12-31';
  }
}

function guardarVisto(userId: string, id: string) {
  try {
    localStorage.setItem(claveVisto(userId), id);
  } catch { /* si no se puede recordar, el punto vuelve a aparecer: molesto, no roto */ }
}

function diasDesde(id: string): number {
  const t = Date.parse(`${id}T00:00:00`);
  if (!Number.isFinite(t)) return Number.MAX_SAFE_INTEGER;
  return Math.floor((Date.now() - t) / 86_400_000);
}

export default function NovedadesButton() {
  const { user } = useAuth();
  const { isManagerOfActive } = useStore();
  const [abierto, setAbierto] = useState(false);
  // null = todavia no se leyo (el usuario puede no estar listo en el primer
  // render). Mientras sea null NO se enciende el punto: preferimos no avisar a
  // avisar de mas.
  const [visto, setVisto] = useState<string | null>(null);

  const lista: Novedad[] = useMemo(
    () => NOVEDADES.filter((n) => n.para !== 'dueño' || isManagerOfActive),
    [isManagerOfActive],
  );

  const ultima = lista[0];
  // El punto se enciende solo si hay algo más nuevo que lo último visto Y es
  // reciente. Un usuario que se registra hoy NO recibe el badge de todo lo que
  // ya estaba cuando llegó: la primera visita sella la marca sin avisar.
  const hayNuevo = Boolean(
    ultima && visto !== null && ultima.id > visto && diasDesde(ultima.id) <= VENTANA_NUEVO_DIAS,
  );

  const userId = user?.id;
  const ultimaId = ultima?.id;
  useEffect(() => {
    if (!userId || !ultimaId) return;
    const guardado = leerVisto(userId);
    if (guardado === null) {
      // Primera vez: se sella en silencio. Un dueño que se registra hoy no
      // tiene por que recibir el aviso de todo lo que ya estaba cuando llego.
      guardarVisto(userId, ultimaId);
      setVisto(ultimaId);
      return;
    }
    setVisto(guardado);
  }, [userId, ultimaId]);

  if (!lista.length) return null;

  const alAbrir = (v: boolean) => {
    setAbierto(v);
    if (v && user?.id && ultima) {
      guardarVisto(user.id, ultima.id);
      setVisto(ultima.id);
    }
  };

  return (
    <Sheet open={abierto} onOpenChange={alAbrir}>
      <SheetTrigger asChild>
        <button
          type="button"
          className="relative w-8 h-8 rounded-lg bg-card/40 border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors"
          aria-label={hayNuevo ? 'Novedades de Guardian (hay algo nuevo)' : 'Novedades de Guardian'}
          title={hayNuevo ? 'Hay novedades' : 'Novedades'}
        >
          <Sparkles size={15} aria-hidden="true" />
          {hayNuevo && (
            <span
              className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-accent border-2 border-surface"
              aria-hidden="true"
            />
          )}
        </button>
      </SheetTrigger>

      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Novedades de Guardian</SheetTitle>
        </SheetHeader>

        <div className="mt-5 space-y-6">
          {lista.map((n) => (
            <article key={n.id}>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {new Date(`${n.id}T12:00:00`).toLocaleDateString('es-CO', {
                  day: 'numeric', month: 'long', year: 'numeric',
                })}
              </p>
              <h3 className="text-sm font-bold text-foreground mt-0.5">{n.titulo}</h3>
              <ul className="mt-2 space-y-1.5">
                {n.puntos.map((p, i) => (
                  <li key={i} className="text-[12px] text-muted-foreground leading-relaxed flex gap-2">
                    <span className="text-accent shrink-0" aria-hidden="true">•</span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <p className="text-[10px] text-muted-foreground mt-8 leading-relaxed">
          Guardian se actualiza solo. Cuando haya una versión nueva vas a ver un aviso arriba
          para recargar, y acá te contamos qué cambió.
        </p>
      </SheetContent>
    </Sheet>
  );
}
