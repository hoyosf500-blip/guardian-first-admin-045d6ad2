import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { History, ChevronLeft, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import { useStore } from '@/contexts/StoreContext';
import { useAuth } from '@/contexts/AuthContext';
import { useAdvisorRoster } from '@/hooks/useAdvisorRoster';
import { useBitacoraDia, promedioPorPedido, type FilaBitacora } from '@/hooks/useBitacoraDia';
import { bogotaToday } from '@/lib/utils';
import { correrDia, horaBogota } from '@/lib/diaBitacora';
import { NOMBRE_EVENTO, duracionLegible, saltoSinMirar } from '@/lib/eventosPedido';

/**
 * La bitácora del turno: qué hizo cada quien, en orden, con el reloj al lado.
 *
 * ── Por qué existe (pedido del dueño, 3-sep-2026) ───────────────────────────
 * *"Ayer en Novedades la operadora me dijo que lo había tocado, pero no sé si
 * me miente."*
 *
 * ── Quién ve qué ────────────────────────────────────────────────────────────
 * Decisión del dueño: **la asesora ve el suyo, el dueño y el supervisor ven el
 * de todas.** No es una cortesía: es lo que convierte esto en una prueba en vez
 * de una acusación. Ante un desacuerdo ella señala su propia bitácora.
 *
 * La reja de verdad es la RLS de `order_events`, no esta pantalla: quien entre
 * por URL sin ser jefe solo va a poder leer sus propias filas. Acá el rol
 * decide únicamente si se muestra el selector de personas.
 *
 * ── La regla que ordena todo ────────────────────────────────────────────────
 * ⛔ **Vacío mientras carga NO es "no hizo nada".** Sobre esta pantalla se va a
 * hablar con una persona de su trabajo; una lista vacía dibujada antes de que
 * lleguen los datos es una acusación falsa. Por eso `cargando`, `not_ready` y
 * `ok`-con-cero son tres carteles distintos, y ninguno dice lo del otro.
 */

/** Cuántas filas se DIBUJAN (el resumen se calcula sobre todas). */
const TOPE_FILAS_DIBUJADAS = 500;

const EVENTO_TONO: Record<string, string> = {
  salto: 'text-warning',
  gestiono: 'text-success',
  marco: 'text-success',
  edito: 'text-success',
  llamo: 'text-accent',
  escribio: 'text-accent',
  leyo_chat: 'text-muted-foreground',
  abrio: 'text-muted-foreground',
  cerro: 'text-muted-foreground',
};

function Metrica({ valor, etiqueta, tono }: { valor: string; etiqueta: string; tono?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card/40 px-3 py-2 min-w-0">
      <div className={`text-lg font-bold font-mono tabular-nums ${tono || 'text-foreground'}`}>{valor}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{etiqueta}</div>
    </div>
  );
}

function Fila({ f, nombre }: { f: FilaBitacora; nombre: string }) {
  const esSalto = f.evento === 'salto';
  const dePaso = esSalto && saltoSinMirar(f.msEnPantalla);
  return (
    <div className="flex items-start gap-3 px-3 py-2 min-w-0 border-b border-border/50 last:border-0">
      <span className="shrink-0 text-[11px] font-mono tabular-nums text-muted-foreground pt-0.5 w-11">
        {horaBogota(f.createdAt)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2 flex-wrap">
          <span className={`text-xs font-semibold ${EVENTO_TONO[f.evento] || 'text-foreground'}`}>
            {NOMBRE_EVENTO[f.evento] || f.evento}
          </span>
          {f.externalId && (
            <Link to={`/pedido/${f.externalId}`} className="text-[11px] font-mono tabular-nums text-accent hover:underline">
              #{f.externalId}
            </Link>
          )}
          {(f.evento === 'cerro' || esSalto) && (
            <span className="text-[11px] font-mono tabular-nums text-muted-foreground">
              {duracionLegible(f.msEnPantalla)}
            </span>
          )}
          {/* Solo se marca lo que se MIDIÓ por debajo del umbral. Un salto sin
              medición no se acusa de nada. */}
          {dePaso && (
            <span
              className="text-[9px] px-1.5 py-0.5 rounded-full font-bold border border-warning/40 bg-warning/10 text-warning"
              title="Estuvo menos de 2 segundos: no alcanza para leer la novedad."
            >
              de paso
            </span>
          )}
        </span>
        {typeof f.detalle?.accion === 'string' && (
          <span className="block text-[11px] text-muted-foreground truncate mt-0.5">{String(f.detalle.accion)}</span>
        )}
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground truncate max-w-[120px]">{nombre}</span>
    </div>
  );
}

export default function ActividadPage() {
  const { activeStoreId, isManagerOfActive } = useStore();
  const { user, isAdmin } = useAuth();
  const puedeVerATodas = isManagerOfActive || isAdmin;

  const [dia, setDia] = useState<string>(() => bogotaToday());
  // Quien no es jefe solo se ve a sí misma. La RLS lo garantiza igual; esto
  // evita además dibujar un selector que no llevaría a ningún lado.
  const [quien, setQuien] = useState<string | null>(null);
  const filtroOperador = puedeVerATodas ? quien : (user?.id ?? null);

  const { roster } = useAdvisorRoster(activeStoreId);
  const { filas, resumen, estado, truncado, recargar } = useBitacoraDia(activeStoreId, dia, filtroOperador);

  // Nombres para la lista: el roster no incluye al dueño, y el dueño también
  // trabaja pedidos. Sin esto sus propias filas saldrían sin nombre.
  const nombreDe = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of roster) m.set(a.operator_id, a.display_name);
    if (user?.id && !m.has(user.id)) m.set(user.id, 'Vos');
    return (id: string) => m.get(id) || 'Alguien del equipo';
  }, [roster, user?.id]);

  // Si el día cambia mientras hay un filtro puesto, no se toca el filtro: es
  // justamente lo que la persona quiere comparar de un día a otro.
  useEffect(() => { if (!puedeVerATodas) setQuien(null); }, [puedeVerATodas]);

  const esHoy = dia === bogotaToday();

  return (
    <div className="max-w-4xl mx-auto min-w-0">
      <header className="mb-4">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">CRM · Control</div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-3">
          <span className="w-11 h-11 rounded-2xl bg-accent/14 border border-accent/30 text-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
            <History size={20} strokeWidth={2.25} />
          </span>
          Actividad
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {puedeVerATodas
            ? 'Qué se hizo en cada pedido, en orden y con el tiempo al lado. Incluye los pedidos que se abrieron y se dejaron sin gestionar.'
            : 'Tu propio registro del día: qué pedidos abriste, cuánto estuviste en cada uno y qué gestionaste.'}
        </p>
      </header>

      {/* ── Controles ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <div className="inline-flex items-center rounded-xl border border-border bg-card/40">
          <button
            type="button"
            onClick={() => setDia((d) => correrDia(d, -1))}
            className="px-2 py-2 text-muted-foreground hover:text-foreground"
            aria-label="Día anterior"
          >
            <ChevronLeft size={15} />
          </button>
          <span className="px-2 text-xs font-mono tabular-nums text-foreground">{dia}{esHoy ? ' · hoy' : ''}</span>
          <button
            type="button"
            onClick={() => setDia((d) => correrDia(d, 1))}
            disabled={esHoy}
            className="px-2 py-2 text-muted-foreground hover:text-foreground disabled:opacity-30"
            aria-label="Día siguiente"
          >
            <ChevronRight size={15} />
          </button>
        </div>

        {puedeVerATodas && (
          <select
            value={quien ?? ''}
            onChange={(e) => setQuien(e.target.value || null)}
            className="rounded-xl border border-border bg-card/40 px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Filtrar por persona"
          >
            <option value="">Todo el equipo</option>
            {roster.map((a) => (
              <option key={a.operator_id} value={a.operator_id}>{a.display_name}</option>
            ))}
          </select>
        )}

        <button
          type="button"
          onClick={() => void recargar()}
          disabled={estado === 'cargando'}
          aria-busy={estado === 'cargando'}
          className="ml-auto inline-flex items-center gap-1.5 rounded-xl border border-border bg-card/40 px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-60 disabled:cursor-wait"
        >
          <RefreshCw size={13} className={estado === 'cargando' ? 'animate-spin' : ''} /> Actualizar
        </button>
      </div>

      {estado === 'cargando' && (
        <div role="status" aria-live="polite" className="flex items-center justify-center py-16 text-muted-foreground text-sm">
          <Loader2 size={16} className="animate-spin mr-2" aria-hidden="true" /> Leyendo la bitácora…
        </div>
      )}

      {/* ⛔ Esto NO es "no hizo nada". Es "la tabla todavía no existe". */}
      {estado === 'not_ready' && (
        <div role="status" className="rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          <p className="font-semibold">La bitácora todavía no está prendida en la base.</p>
          <p className="text-xs mt-1 opacity-90">
            Falta aplicar la migración <span className="font-mono">order_events</span>. Hasta que corra, esta
            pantalla no puede mostrar nada — <strong>y eso no quiere decir que nadie haya trabajado.</strong>
          </p>
        </div>
      )}

      {estado === 'error' && (
        <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          No se pudo leer la bitácora ahora mismo. Reintentá en un momento.
        </div>
      )}

      {estado === 'ok' && (
        <>
          {/* ⛔ Si se tocó el tope, el resumen está INCOMPLETO y se dice: sobre
              estos números se habla con una persona. Lo que falta es lo más
              viejo del día (la mañana). */}
          {truncado && (
            <div role="status" className="rounded-2xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning mb-4">
              Este día tiene más eventos de los que puedo leer de una vez: la lista y el resumen
              están <strong>incompletos</strong> (falta lo más temprano). Elegí una persona para verla completa.
            </div>
          )}
          {/* ── Resumen por persona ─────────────────────────────────────── */}
          {resumen.length > 0 && (
            <div className="flex flex-col gap-3 mb-5">
              {resumen.map((r) => {
                const prom = promedioPorPedido(r);
                return (
                  <div key={r.operatorId} className="rounded-2xl border border-border bg-card/30 p-3 min-w-0">
                    <div className="text-sm font-bold text-foreground mb-2 truncate">{nombreDe(r.operatorId)}</div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                      <Metrica valor={String(r.abrio)} etiqueta="pedidos abiertos" />
                      <Metrica valor={String(r.gestiono)} etiqueta="gestionados" tono="text-success" />
                      <Metrica valor={String(r.salto)} etiqueta="sin gestionar" tono={r.salto > 0 ? 'text-warning' : undefined} />
                      <Metrica valor={String(r.llamo)} etiqueta="llamadas" />
                      <Metrica valor={String(r.escribio)} etiqueta="whatsapps" />
                      {/* ⛔ "—" cuando no hay ni una medición. "0 s por pedido"
                          sobre datos que no existen es una acusación falsa. */}
                      <Metrica valor={duracionLegible(prom)} etiqueta="por pedido" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {filas.length === 0 ? (
            <div className="rounded-2xl border border-border bg-card/30 px-4 py-8 text-center">
              <p className="text-sm font-semibold text-foreground">Ninguna actividad registrada ese día</p>
              <p className="text-xs text-muted-foreground mt-1">
                Ojo: la bitácora empieza a llenarse desde que se prendió. Si el día es anterior a eso,
                esto no dice que no se trabajó — dice que no había quién anotara.
              </p>
            </div>
          ) : (
            <div className="rounded-2xl border border-border bg-card/30 overflow-hidden">
              <div className="px-3 py-2 border-b border-border/70 flex items-center gap-2">
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                  Lo que pasó, del último al primero
                </span>
                <span className="ml-auto text-[11px] font-mono tabular-nums text-muted-foreground">{filas.length}</span>
              </div>
              <div className="max-h-[60vh] overflow-y-auto">
                {/* Tope de dibujo (revisión 3-sep-2026): "Todo el equipo" pasa
                    de 2.000 filas antes del mediodía y hasta 10.000; pintarlas
                    todas de una (cada una con Link y ~8 spans) congelaba la
                    pantalla varios segundos. El resumen de arriba sí usa todas. */}
                {filas.slice(0, TOPE_FILAS_DIBUJADAS).map((f) => (
                  <Fila key={f.id} f={f} nombre={nombreDe(f.operatorId)} />
                ))}
                {filas.length > TOPE_FILAS_DIBUJADAS && (
                  <p className="px-3 py-2 text-[11px] text-muted-foreground border-t border-border/70">
                    Se muestran las últimas {TOPE_FILAS_DIBUJADAS} de {filas.length}. Elegí una persona arriba para ver su día completo.
                  </p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
