import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock, Loader2 } from 'lucide-react';
import { useStoreSchedule, DEFAULT_SCHEDULE_MINUTES } from '@/hooks/useStoreSchedule';
import { useMapaCalorDia } from '@/hooks/useMapaCalorDia';
import { construirMapaCalor, intensidad, rangoHora, type CeldaMapa } from '@/lib/mapaCalor';
import { bogotaToday, cn } from '@/lib/utils';
import { correrDia, horaDelDiaBogota } from '@/lib/diaBitacora';

/**
 * EL MAPA DE CALOR DEL TURNO — hora por hora, una fila por asesora.
 *
 * Pedido del dueño (3-sep-2026): *"controlar cada hora: de 8 a 9 qué hicieron,
 * de 10 a 11 cuánto avanzaron, qué tocaron"*, y sobre todo: *"hay asesoras que
 * me dicen 'ya lo toqué', pero la última palabra la tiene Guardian"*.
 *
 * ⛔ Por eso ninguna celda vacía significa lo mismo que otra. Los cuatro estados
 * los decide `mapaCalor.ts` y acá solo se dibujan, cada uno distinto:
 *   · trabajo      → color, con el número
 *   · sin trabajo  → hueco marcado. **Esto sí se puede reclamar.**
 *   · todavía no   → rayado tenue: la hora no llegó, no dice nada
 *   · sin medir    → rayado con "?": la lectura falló, tampoco dice nada
 *
 * Clic en una celda ⇒ qué tocó esa hora. Es la mitad de "qué hicieron" que un
 * número solo no contesta.
 */

interface Props {
  storeId: string | null;
  /** Las mismas personas que las tarjetas de abajo (incluye supervisores). */
  asesores: { operatorId: string; name: string }[];
  /** Cambia cuando el panel recibe un aviso de realtime: el mapa se recarga
   *  con él en vez de abrir un canal propio (ver `crm_lento_cinco_bucles`).
   *  ⛔ Sin esto el mapa era una FOTO del momento en que se montó (4-sep-2026):
   *  a las 15:00 seguía mostrando las gestiones de hasta las 9:10. */
  refreshKey?: number;
}

/** El tono de una celda según su estado. Separado del cálculo a propósito: el
 *  día que cambie la paleta no se toca la lógica que decide qué es un cero. */
function claseCelda(celda: CeldaMapa, maximo: number): string {
  const i = intensidad(celda, maximo);
  if (celda.estado === 'sin_medir' || i === null) {
    return 'bg-[repeating-linear-gradient(45deg,transparent,transparent_3px,hsl(var(--muted-foreground)/0.25)_3px,hsl(var(--muted-foreground)/0.25)_4px)] text-muted-foreground';
  }
  if (celda.estado === 'todavia_no') {
    return 'bg-muted/25 text-muted-foreground/60';
  }
  if (celda.estado === 'sin_trabajo') {
    // El hueco se VE. Es el dato que se busca, no un espacio en blanco.
    return 'bg-danger/10 border border-danger/25 text-danger/70';
  }
  // Cinco escalones en vez de una rampa continua: el ojo compara mejor bloques
  // discretos que un degradado, y así "un poco más oscuro" siempre significa lo
  // mismo entre dos filas.
  const paso = i >= 0.8 ? 4 : i >= 0.6 ? 3 : i >= 0.4 ? 2 : i >= 0.2 ? 1 : 0;
  return [
    'bg-accent/12 text-accent',
    'bg-accent/25 text-accent',
    'bg-accent/40 text-accent-foreground',
    'bg-accent/60 text-accent-foreground',
    'bg-accent/80 text-accent-foreground',
  ][paso];
}

function textoCelda(celda: CeldaMapa): string {
  if (celda.estado === 'sin_medir') return '?';
  if (celda.estado === 'todavia_no') return celda.cantidad ? String(celda.cantidad) : '·';
  return String(celda.cantidad ?? 0);
}

function tituloCelda(nombre: string, celda: CeldaMapa): string {
  const cuando = `${nombre} · ${rangoHora(celda.hora)}`;
  const almuerzo = celda.tocaAlmuerzo ? ' (pisa el almuerzo)' : '';
  if (celda.estado === 'sin_medir') return `${cuando}${almuerzo} — no se pudo leer`;
  if (celda.estado === 'todavia_no') return `${cuando}${almuerzo} — esa hora todavía no terminó`;
  if (celda.estado === 'sin_trabajo') return `${cuando}${almuerzo} — sin ninguna gestión`;
  return `${cuando}${almuerzo} — ${celda.cantidad} gestion${celda.cantidad === 1 ? '' : 'es'}`;
}

export default function MapaCalorEquipo({ storeId, asesores, refreshKey }: Props) {
  const [ymd, setYmd] = useState(() => bogotaToday());
  const [abierta, setAbierta] = useState<{ operatorId: string; hora: number } | null>(null);

  const hoy = bogotaToday();
  const esHoy = ymd === hoy;

  const scheduleQuery = useStoreSchedule(storeId);
  const { gestiones, marcas, estado, recargar } = useMapaCalorDia(storeId, ymd);

  // Vivo, de dos formas: (1) cada aviso de realtime del panel padre; (2) un
  // reloj de 60 s para que la hora "en curso" avance sola, y una recarga de
  // respaldo cada 5 min por si el realtime se durmió. Solo para HOY: un día
  // cerrado no cambia.
  // `recargar` va por ref: si estuviera en las deps, cambiar de tienda o de
  // día disparaba esta recarga A LA VEZ que la del propio hook → dos lecturas
  // paralelas del día completo (revisión 3-sep-2026).
  const recargarRef = useRef(recargar);
  recargarRef.current = recargar;
  useEffect(() => { if (refreshKey) void recargarRef.current(); }, [refreshKey]);
  const [ahoraMs, setAhoraMs] = useState(() => Date.now());
  useEffect(() => {
    if (!esHoy) return;
    const reloj = setInterval(() => setAhoraMs(Date.now()), 60_000);
    const respaldo = setInterval(() => { void recargar(); }, 5 * 60_000);
    return () => { clearInterval(reloj); clearInterval(respaldo); };
  }, [esHoy, recargar]);

  const operadores = useMemo(() => asesores.map((a) => a.operatorId), [asesores]);
  const nombreDe = useMemo(() => {
    const m = new Map(asesores.map((a) => [a.operatorId, a.name]));
    return (id: string) => m.get(id) || 'Sin nombre';
  }, [asesores]);

  const mapa = useMemo(() => construirMapaCalor({
    marcas,
    operadores,
    // Sin horario configurado se usa el default 9-17, igual que el resto del
    // CRM. No se inventa un horario a partir de los datos: un turno deducido de
    // las gestiones haría que quien empieza tarde nunca aparezca como tarde.
    horario: scheduleQuery.data ?? DEFAULT_SCHEDULE_MINUTES,
    medible: estado === 'ok',
    // Solo hoy tiene horas que "todavía no pasaron".
    horaActual: esHoy ? horaDelDiaBogota(new Date(ahoraMs).toISOString()) : null,
  }), [marcas, operadores, scheduleQuery.data, estado, esHoy, ahoraMs]);

  const detalle = useMemo(() => {
    if (!abierta) return [];
    return gestiones.filter((g) => g.operatorId === abierta.operatorId && g.hora === abierta.hora);
  }, [abierta, gestiones]);

  if (asesores.length === 0) return null;

  return (
    <section className="rounded-2xl border border-border bg-card/40 shadow-card3d overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 border-b border-border/60">
        <span className="hud-label inline-flex items-center gap-1.5">
          <Clock size={12} aria-hidden="true" /> Hora por hora
        </span>
        {estado === 'cargando' && (
          <Loader2 size={12} className="animate-spin text-muted-foreground" aria-hidden="true" />
        )}
        <span className="ml-auto inline-flex items-center gap-1">
          <button
            type="button"
            onClick={() => { setYmd((d) => correrDia(d, -1)); setAbierta(null); }}
            className="rounded-lg border border-border p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label="Día anterior"
          >
            <ChevronLeft size={13} aria-hidden="true" />
          </button>
          <span className="inline-flex items-center gap-1.5 px-2 text-[11px] font-semibold tabular-nums">
            <CalendarDays size={12} className="text-muted-foreground" aria-hidden="true" />
            {esHoy ? 'Hoy' : ymd}
          </span>
          <button
            type="button"
            disabled={esHoy}
            onClick={() => { setYmd((d) => correrDia(d, 1)); setAbierta(null); }}
            className="rounded-lg border border-border p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/40 disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label="Día siguiente"
          >
            <ChevronRight size={13} aria-hidden="true" />
          </button>
        </span>
      </div>

      {/* HONESTIDAD: si no se pudo leer, se dice — y las celdas van rayadas, no
          en cero. Un cero acá se lee como "no trabajó" y sobre eso se reclama. */}
      {(estado === 'error' || estado === 'not_ready') && (
        <p className="px-4 py-2 text-[11px] text-warning border-b border-border/60">
          {estado === 'not_ready'
            ? 'Todavía no puedo leer las gestiones de este día.'
            : 'No se pudieron leer las gestiones de este día.'}
          {' '}Las celdas van rayadas: no quiere decir que no hayan trabajado.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-separate border-spacing-[2px] px-3 py-3">
          <thead>
            <tr>
              <th className="w-[9rem] text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Asesora
              </th>
              {mapa.horas.map((h) => (
                <th key={h} className="text-center text-[10px] font-mono tabular-nums text-muted-foreground font-normal">
                  {h}
                </th>
              ))}
              <th
                className="w-[3.5rem] text-right text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
                title="Gestiones antes de la primera hora del horario o después de la última. Cuentan en el total: quien entró a las 7:30 trabajó."
              >
                Fuera
              </th>
              <th className="w-[3.5rem] text-right text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Día
              </th>
            </tr>
          </thead>
          <tbody>
            {mapa.filas.map((fila) => (
              <tr key={fila.operatorId}>
                <td className="max-w-[9rem] truncate pr-2 text-xs font-semibold" title={nombreDe(fila.operatorId)}>
                  {nombreDe(fila.operatorId)}
                </td>
                {fila.celdas.map((celda) => {
                  const activa = abierta?.operatorId === fila.operatorId && abierta.hora === celda.hora;
                  return (
                    <td key={celda.hora} className="p-0">
                      <button
                        type="button"
                        onClick={() => setAbierta(
                          activa ? null : { operatorId: fila.operatorId, hora: celda.hora },
                        )}
                        title={tituloCelda(nombreDe(fila.operatorId), celda)}
                        className={cn(
                          'w-full h-7 rounded-md text-[10px] font-mono tabular-nums font-semibold',
                          'transition-transform hover:scale-[1.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                          claseCelda(celda, mapa.maximo),
                          activa && 'ring-2 ring-accent',
                          celda.tocaAlmuerzo && 'opacity-90',
                        )}
                      >
                        {textoCelda(celda)}
                      </button>
                    </td>
                  );
                })}
                <td className="pl-2 text-right text-xs font-mono tabular-nums text-muted-foreground">
                  {fila.fueraDeHorario == null ? '—' : fila.fueraDeHorario === 0 ? '·' : fila.fueraDeHorario}
                </td>
                <td className="pl-2 text-right text-xs font-mono tabular-nums font-semibold">
                  {fila.total ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {abierta && (
        <div className="border-t border-border/60 px-4 py-3">
          <p className="text-[11px] font-semibold mb-2">
            {nombreDe(abierta.operatorId)} · {rangoHora(abierta.hora)}
            <span className="ml-2 font-normal text-muted-foreground">
              {detalle.length} gestion{detalle.length === 1 ? '' : 'es'}
            </span>
          </p>
          {detalle.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {mapa.medible
                ? 'No marcó nada en esa hora.'
                : 'No se pudieron leer las gestiones de este día — esto NO quiere decir que no haya trabajado.'}
            </p>
          ) : (
            <ul className="space-y-1 max-h-52 overflow-y-auto">
              {detalle.map((g, i) => (
                <li key={`${g.reloj}-${g.phone}-${i}`} className="flex items-baseline gap-2 text-[11px]">
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{g.reloj}</span>
                  <span className="min-w-0 flex-1 truncate">{g.accion}</span>
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{g.phone}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="px-4 pb-3 text-[10px] leading-relaxed text-muted-foreground">
        Cada columna es una hora del horario de la tienda. Los huecos en rojo son horas que
        pasaron sin ninguna gestión; el rayado es «no se sabe», no «no trabajó». Se cuentan
        las gestiones registradas en Guardian: una llamada hecha desde el celular, sin marcar,
        no aparece acá.
      </p>
    </section>
  );
}
