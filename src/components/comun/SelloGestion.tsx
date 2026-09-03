import { CheckCircle2, Clock, UserCheck } from 'lucide-react';
import { haceCuanto } from '@/lib/gestionPorPedido';
import { useOperatorNames } from '@/hooks/useOperatorNames';
import { accionLegible, type EstadoSello, type Sello } from '@/hooks/useSelloGestion';
import { cn } from '@/lib/utils';

/**
 * "Ya lo tocó Fulana": quién, qué y hace cuánto.
 *
 * ── Por qué existe (3-sep-2026) ─────────────────────────────────────────────
 * Pedido del dueño: *"necesito etiquetas para saber que el asesor ya tocó ese
 * pedido, sea en Confirmar, Seguimiento o Novedad y hasta en el Inbox, para yo
 * no regañar"*. Salió de un caso real: en Novedades una operadora dijo que había
 * tocado un pedido y él no tuvo con qué contrastarlo.
 *
 * En el CRM había **once** dibujos distintos de esta misma etiqueta, hechos a
 * mano, y **dos pantallas sin ninguno** (Novedades y la bandeja). Este es el
 * primero compartido. Nace para esas dos; las nueve que hoy funcionan NO se
 * reescribieron —tocarlas es riesgo de regresión sin beneficio— pero cualquier
 * etiqueta nueva sale de acá.
 *
 * ── Lo que este componente se niega a decir ─────────────────────────────────
 * ⛔ **Nunca afirma "nadie lo tocó".** Mientras carga no dibuja nada, y si la
 * lectura falló lo dice con esas palabras. La ausencia de sello significa "no
 * hay gestión registrada en los últimos días" — y solo cuando el estado es `ok`.
 * Sobre esta etiqueta se decide si retar a una persona: un cero afirmado sobre
 * datos que no llegaron es una acusación falsa, y es exactamente el error que
 * este componente viene a corregir.
 */
export default function SelloGestion({ sello, estado, miId, className, compacto = false }: {
  /** La última gestión sobre ese teléfono, o `null` si no hay ninguna. */
  sello: Sello | null;
  /** De `useSelloGestion`. Decide si el silencio significa algo. */
  estado: EstadoSello;
  /** Para distinguir "lo trabajé yo" de "lo trabajó otra". */
  miId: string | null;
  className?: string;
  /** Sin la acción, solo quién y cuándo. Para filas angostas. */
  compacto?: boolean;
}) {
  const { nameOf } = useOperatorNames();

  // Todavía no se sabe: no se dibuja nada. Un hueco es honesto; un "nadie lo
  // tocó" que un segundo después se desmiente solo, no.
  if (estado === 'inicial' || estado === 'cargando') return null;

  if (estado === 'error') {
    return (
      <span
        className={cn('inline-flex items-center gap-1 text-[10px] font-semibold text-muted-foreground', className)}
        title="Falló la lectura de las gestiones. NO quiere decir que nadie lo haya tocado."
      >
        <Clock size={10} aria-hidden="true" /> no pude ver si lo tocaron
      </span>
    );
  }

  if (!sello) return null;

  const propio = !!miId && sello.operatorId === miId;
  const quien = propio ? 'Vos' : nameOf(sello.operatorId);
  const cuando = haceCuanto(sello.createdAt);
  const que = accionLegible(sello.action);
  const Icono = propio ? CheckCircle2 : UserCheck;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg border text-[10px] font-bold min-w-0',
        propio
          ? 'border-success/40 bg-success/10 text-success'
          : 'border-accent/40 bg-accent/10 text-accent',
        className,
      )}
      title={`${quien} · ${que || 'gestión registrada'} · ${cuando}`}
    >
      <Icono size={10} className="shrink-0" aria-hidden="true" />
      <span className="truncate">
        {quien}
        {!compacto && que ? ` · ${que}` : ''}
        {cuando ? ` · ${cuando}` : ''}
      </span>
    </span>
  );
}
