import { memo, useMemo } from 'react';
import { MapPin } from 'lucide-react';
import { deriveDeliveryMaturity, isRatePreliminary, MIN_RESUELTOS_CONFIABLE } from '@/lib/logisticsRates';
import type { CityReturns } from '@/lib/logistics.types';

interface Props {
  rows: CityReturns[];
}

/** Paleta cíclica para identificar ciudades visualmente. Guarda el NOMBRE
 *  del token (no el `hsl(...)` armado) para poder componer también la
 *  variante con alpha del aro. Usa tokens semánticos del DS para que
 *  dark/light mode adapte solo. */
const CITY_PALETTE = [
  '--info',
  '--accent',
  '--success',
  '--ai',
  '--warning',
  '--danger',
];

/** Geo distribution: panel lateral con top 6 ciudades por volumen.
 *  Cada ciudad muestra dot de color, nombre + departamento, progress
 *  bar proporcional al % del total, y % numérico. Agrega "Otros" si
 *  hay más de 6 ciudades. Patrón inspirado en dashboards logísticos
 *  profesionales (referencia: panel "Geo Distribution" con bars). */
export default memo(function GeoDistribution({ rows }: Props) {
  const total = useMemo(
    () => rows.reduce((s, r) => s + (r.total_pedidos ?? 0), 0),
    [rows],
  );

  const top = useMemo(() => {
    return [...rows]
      .sort((a, b) => (b.total_pedidos ?? 0) - (a.total_pedidos ?? 0))
      .slice(0, 6)
      .map((r, idx) => {
        const token = CITY_PALETTE[idx % CITY_PALETTE.length];
        // Madurez SOLO como compuerta del veredicto de color — la tasa que se
        // muestra sigue siendo la del server (`tasa_devolucion`), sin cambiar
        // fórmula ni umbrales. Mismo criterio que la tabla de abajo
        // (CityReturnsTable), que para la MISMA ciudad ya muestra "—" cuando
        // nada concluyó: sin esto los dos paneles se contradecían.
        const m = deriveDeliveryMaturity(
          r.entregados, r.devueltos, r.total_pedidos, r.rechazados ?? 0,
        );
        return {
          ...r,
          pct: total > 0 ? ((r.total_pedidos ?? 0) / total) * 100 : 0,
          resueltos: m.resueltos,
          prelim: isRatePreliminary(m),
          // `isRatePreliminary` dispara por DOS motivos distintos (muestra
          // chica O cohorte inmaduro). Guardamos con cuál para que el tooltip
          // diga el motivo REAL: en un rango reciente la mayoría de las
          // ciudades son prelim. por cohorte inmaduro, no por pocos datos.
          muestraChica: m.resueltos < MIN_RESUELTOS_CONFIABLE,
          pctConcluido: m.pctConcluido,
          color: `hsl(var(${token}))`,
          // Aro suave del dot. Antes era `${c.color}22` — el idiom `+22`
          // sólo sirve con hex de 6 dígitos; sobre un `hsl(...)` producía
          // CSS inválido y el boxShadow nunca se pintaba.
          ring: `hsl(var(${token}) / 0.13)`,
        };
      });
  }, [rows, total]);

  const otros = useMemo(() => {
    const restRows = rows.length > 6
      ? [...rows].sort((a, b) => (b.total_pedidos ?? 0) - (a.total_pedidos ?? 0)).slice(6)
      : [];
    const sum = restRows.reduce((s, r) => s + (r.total_pedidos ?? 0), 0);
    return {
      count: restRows.length,
      total: sum,
      pct: total > 0 ? (sum / total) * 100 : 0,
    };
  }, [rows, total]);

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card/40 p-5 shadow-card3d hairline-top h-full flex flex-col items-center justify-center text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted/40">
          <MapPin size={18} className="text-muted-foreground" aria-hidden="true" />
        </div>
        <p className="text-sm font-semibold text-foreground mb-1">Sin datos geográficos</p>
        <p className="text-xs text-muted-foreground max-w-xs">
          No hay ciudades con suficientes pedidos en este rango.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card/40 p-5 shadow-card3d hairline-top h-full flex flex-col">
      <header className="mb-4">
        <div className="flex items-center gap-2">
          <MapPin size={14} className="text-info" aria-hidden="true" strokeWidth={2.25} />
          <h2 className="text-sm font-bold text-foreground tracking-tight">Distribución geográfica</h2>
        </div>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Top {top.length} de {rows.length} ciudades por volumen de envíos
        </p>
        {/* El denominador de los % es la suma de las ciudades RECIBIDAS, no el
            total de envíos del rango: la consulta que alimenta este panel pide
            un tope de filas, así que puede faltar la cola larga de ciudades.
            Decirlo evita leer estos % como reparto del país entero. */}
        <p className="text-[10px] text-muted-foreground/80 mt-1 leading-snug">
          % sobre los {total.toLocaleString('es-CO')} envíos de estas {rows.length} ciudades
          {' '}— puede no incluir todas las ciudades del rango.
        </p>
      </header>

      <div className="space-y-4 flex-1">
        {top.map((c, idx) => (
          <div key={`${c.ciudad}|${c.departamento}`} className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <div className="inline-flex items-center gap-2.5 min-w-0">
                {/* Ranking number — patrón leaderboard, da contexto inmediato. */}
                <span className="font-mono text-[10px] font-bold tabular-nums text-muted-foreground/70 w-4 text-center">
                  {String(idx + 1).padStart(2, '0')}
                </span>
                <span
                  className="h-3 w-3 rounded-full shrink-0"
                  style={{ background: c.color, boxShadow: `0 0 0 3px ${c.ring}` }}
                  aria-hidden="true"
                />
                <span className="font-semibold text-sm text-foreground truncate" title={c.ciudad}>
                  {c.ciudad}
                </span>
                {c.departamento && (
                  <span className="text-muted-foreground/70 text-[10px] truncate hidden sm:inline">
                    · {c.departamento}
                  </span>
                )}
              </div>
              <span className="font-mono text-sm font-extrabold tabular-nums text-foreground shrink-0">
                {c.pct.toFixed(0)}%
              </span>
            </div>
            {/* Barra h-2.5 (vs h-1.5 antes) — más legible, mejor jerarquía. */}
            <div className="h-2.5 w-full rounded-full bg-muted/40 overflow-hidden">
              <div
                className="h-full rounded-full transition-[width] duration-700 ease-out"
                style={{ width: `${c.pct}%`, background: c.color }}
                aria-hidden="true"
              />
            </div>
            <div className="flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
              <span>{(c.total_pedidos ?? 0).toLocaleString('es-CO')} envíos</span>
              {/* Sin desenlaces no hay tasa: "0.0% devol." en verde hacía ver
                  impecable a una ciudad donde simplemente no concluyó ningún
                  pedido todavía. Con muestra chica se marca prelim. en gris en
                  vez de gritar rojo/verde sobre 1-4 concluidos. */}
              {c.resueltos === 0 ? (
                <span className="text-muted-foreground" title="Sin pedidos concluidos aún — todavía no hay tasa de devolución">
                  — devol.
                </span>
              ) : !Number.isFinite(c.tasa_devolucion) ? (
                /* La consulta no trajo la tasa (drift del RPC). Antes el
                   `?? 0` la imprimía como "0.0%" y el semáforo la pintaba
                   VERDE: un veredicto inventado sobre un dato que no llegó. */
                <span className="text-muted-foreground" title="La consulta no devolvió la tasa de devolución de esta ciudad">
                  — devol.
                </span>
              ) : (
                <span
                  className={
                    c.prelim ? 'text-muted-foreground' :
                    c.tasa_devolucion >= 30 ? 'text-danger font-bold' :
                    c.tasa_devolucion >= 15 ? 'text-warning font-semibold' :
                    'text-success font-medium'
                  }
                  title={
                    !c.prelim ? undefined
                      : c.muestraChica
                        ? `Preliminar: solo ${c.resueltos} pedido(s) concluido(s) — hacen falta ${MIN_RESUELTOS_CONFIABLE} para que la tasa sea confiable`
                        : `Preliminar: solo el ${c.pctConcluido}% de los pedidos concluyó — la tasa todavía puede moverse`
                  }
                >
                  {c.tasa_devolucion.toFixed(1)}% devol.{c.prelim ? ' ·prelim.' : ''}
                </span>
              )}
            </div>
          </div>
        ))}

        {otros.count > 0 && (
          <div className="pt-3 mt-3 border-t border-border/40 flex items-center justify-between text-xs">
            {/* Antes decía "Otros (N ciudades)", que se lee como "todo el resto
                del país". En realidad son las ciudades restantes DE ESTA LISTA
                (que viene topeada), así que el conteo prometía un universo que
                no medimos. "listadas" lo deja literalmente cierto. */}
            <span className="text-muted-foreground">
              Otras {otros.count} ciudades listadas
            </span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-muted-foreground tabular-nums">
                {otros.total.toLocaleString('es-CO')}
              </span>
              <span className="font-mono text-foreground font-bold tabular-nums">
                {otros.pct.toFixed(0)}%
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
