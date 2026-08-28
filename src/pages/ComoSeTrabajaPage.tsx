import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, Check, Eye, ListOrdered } from 'lucide-react';
import { ESCALERA, NO_ES_TRABAJO } from '@/lib/siguienteAccion';
import { SEG_LISTS } from '@/lib/segLists';
import { etiquetasDe } from '@/lib/etiquetasTrabajo';
import { cn } from '@/lib/utils';

/**
 * "Cómo se trabaja acá" — el protocolo del turno, adentro de Guardian.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * El dueño lo dijo así: *"ni yo mismo sé cómo usarlo… ya tenemos Guardian pero
 * falta ser una empresa con flujos"*. Guardian tenía ocho destinos en el menú y
 * ninguno explicaba el trabajo. Una asesora nueva aprendía preguntando, o sea:
 * aprendía distinto cada vez, y el dueño tenía que estar encima.
 *
 * ── La decisión que hace que esto no se pudra ───────────────────────────────
 * **Esta pantalla no tiene texto propio.** Todo sale de donde vive la lógica:
 * la escalera de `siguienteAccion.ts` (la MISMA que ordena la barra "Lo que
 * sigue") y el `queEs`/`queHacer` de cada lista, escrito al lado de su propio
 * predicado en `segLists.ts`. Un manual escrito aparte se desincroniza en
 * semanas y termina enseñando un protocolo que el sistema ya no aplica — y
 * entonces es peor que no tener manual, porque la gente le cree.
 *
 * Si mañana cambia el orden de prioridad o el criterio de una lista, esta
 * página lo dice sola. Una prueba guardiana impide que una lista llegue a la
 * pantalla sin explicación.
 */

const TONO_LISTA: Record<string, string> = {
  danger: 'border-danger/30 bg-danger/5',
  warning: 'border-warning/30 bg-warning/5',
  info: 'border-accent/25 bg-accent/5',
  success: 'border-success/25 bg-success/5',
  neutral: 'border-border bg-card/40',
};

export default function ComoSeTrabajaPage() {
  const navigate = useNavigate();
  const { hash } = useLocation();

  // Los chips de Seguimiento enlazan a `#lista-<slug>`: quien no sabe qué es
  // "En agencia" lo lee sin salir de la operación y vuelve.
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [hash]);

  const listas = SEG_LISTS.filter((l) => l.queEs);

  return (
    <div className="max-w-3xl mx-auto pb-16">
      <header className="mb-6">
        <p className="hud-label">Protocolo del turno</p>
        <h1 className="text-2xl font-bold mt-1">Cómo se trabaja acá</h1>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
          El orden no es por antigüedad ni por monto: es <strong className="text-foreground">por
          lo que se pierde si espera un día más</strong>. Se empieza por el escalón 1 y se baja.
          Cuando todo está en cero, el turno está hecho.
        </p>
      </header>

      {/* ── La escalera ───────────────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="hud-label inline-flex items-center gap-1.5 mb-3">
          <ListOrdered size={12} aria-hidden="true" /> El orden
        </h2>
        <ol className="space-y-2.5">
          {ESCALERA.map((e) => (
            <li
              key={e.key}
              id={`escalon-${e.key}`}
              className="rounded-2xl border border-border bg-card/40 p-4 shadow-card3d"
            >
              <div className="flex items-baseline gap-3">
                <span className="font-mono tabular-nums text-lg font-bold text-accent shrink-0">
                  {e.orden}
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold">{e.nombre}</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">{e.porque}</p>
                  <p className="text-[13px] mt-2 leading-relaxed">{e.queHacer}</p>
                </div>
                <button
                  type="button"
                  onClick={() => navigate(e.ruta)}
                  className="shrink-0 inline-flex items-center gap-1 rounded-xl border border-border px-2.5 py-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Ir <ArrowRight size={11} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ── Lo que NO es trabajo ──────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="hud-label inline-flex items-center gap-1.5 mb-3">
          <Eye size={12} aria-hidden="true" /> Lo que se vigila, no se gestiona
        </h2>
        <div className="rounded-2xl border border-border bg-card/40 p-4 shadow-card3d">
          <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
            Esta es la mitad menos obvia. Estar ocupada no sirve si es en lo que no vence:
            un pedido en tránsito no necesita a nadie, necesita tiempo.
          </p>
          <ul className="space-y-2">
            {NO_ES_TRABAJO.map((n) => (
              <li key={n.que} className="flex gap-2.5 text-[13px]">
                <Check size={14} className="text-success shrink-0 mt-0.5" aria-hidden="true" />
                <span>
                  <strong className="font-semibold">{n.que}</strong>
                  <span className="text-muted-foreground"> — {n.porque}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── Las listas ────────────────────────────────────────────────── */}
      <section>
        <h2 className="hud-label mb-1">Qué significa cada lista</h2>
        <p className="text-xs text-muted-foreground mb-3">
          Son las listas de Seguimiento. Cada chip de esa pantalla enlaza acá.
        </p>
        <div className="space-y-2.5">
          {listas.map((l) => (
            <div
              key={l.slug}
              id={`lista-${l.slug}`}
              className={cn('rounded-2xl border p-4 shadow-card3d scroll-mt-6', TONO_LISTA[l.tone] ?? TONO_LISTA.neutral)}
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h3 className="text-sm font-semibold">{l.label}</h3>
                {l.slaDias > 0 && (
                  <span className="text-[10px] font-mono text-muted-foreground">
                    vence a los {l.slaDias} días hábiles
                  </span>
                )}
              </div>
              <p className="text-[13px] mt-1.5 leading-relaxed">{l.queEs}</p>
              <p className="text-[13px] mt-1.5 leading-relaxed">
                <span className="text-muted-foreground">Qué se hace: </span>
                {l.queHacer}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ── El glosario ───────────────────────────────────────────────────
          Pedido del dueño (28-ago-2026): *"que puedan diferenciar y coincidir
          en las etiquetas"*. Llamada y Seguimiento describen los mismos hechos
          con palabras distintas, y una asesora que cambia de pantalla traducía
          de memoria. Sale de `etiquetasTrabajo.ts`, que a su vez lee de
          `RIESGO_INFO` — no hay copias de texto que se puedan desincronizar. */}
      <section className="mt-8">
        <h2 className="hud-label mb-1">Qué quiere decir cada etiqueta</h2>
        <p className="text-xs text-muted-foreground mb-3">
          Las mismas cosas se llaman distinto en Llamada y en Seguimiento. Acá está la
          traducción, para que el equipo hable un solo idioma.
        </p>
        {(['llamada', 'seguimiento'] as const).map((p) => (
          <div key={p} className="mb-4">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
              {p === 'llamada' ? 'En Confirmar (llamada)' : 'En Seguimiento'}
            </h3>
            <div className="space-y-2.5">
              {etiquetasDe(p).map((e) => (
                <div
                  key={e.clave}
                  id={`etiqueta-${e.clave}`}
                  className="rounded-2xl border border-border bg-card/40 p-4 shadow-card3d scroll-mt-6"
                >
                  <h4 className="text-sm font-semibold">{e.etiqueta}</h4>
                  <p className="text-[13px] mt-1.5 leading-relaxed">{e.que}</p>
                  <p className="text-[13px] mt-1.5 leading-relaxed">
                    <span className="text-muted-foreground">Qué se hace: </span>{e.queHacer}
                  </p>
                  <p className="text-[12px] mt-1.5 text-muted-foreground">
                    {e.equivaleA
                      ? <>En la otra pantalla es <strong className="text-foreground font-semibold">«{e.equivaleA}»</strong>.</>
                      : 'No tiene equivalente en la otra pantalla: este dato solo se ve acá.'}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

      <p className="text-[11px] text-muted-foreground/70 mt-8 leading-relaxed">
        Esta pantalla no tiene texto propio: lo saca del mismo lugar donde el sistema decide
        las prioridades. Si cambia el protocolo, cambia acá solo.
      </p>
    </div>
  );
}
