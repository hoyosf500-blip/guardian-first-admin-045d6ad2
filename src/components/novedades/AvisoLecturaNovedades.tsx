import { CloudOff, Scissors, RefreshCw } from 'lucide-react';

/**
 * Las dos banderas de honestidad de `useNovedadesSeguimiento`, DIBUJADAS.
 *
 * ⛔ Por qué existe (auditoría 30-ago-2026): el hook calculaba `loadError`,
 * `muestraParcial` y `telefonosOmitidos` —con comentarios que dicen
 * explícitamente que el componente DEBE mostrar "no se pudo leer" en vez de
 * ceros— y NINGUNA de las dos pantallas las desestructuraba. La defensa se
 * calculaba y se tiraba a la basura.
 *
 * Lo que se veía mientras tanto: la tarjeta verde "No hay novedades en el
 * período para analizar", "Novedades analizadas: 0", "Gestionadas hoy 0" con el
 * aviso rojo "nadie tocó novedades hoy" y un badge rojo "0 hoy" al lado de cada
 * asesora — todo eso saliendo de una lectura que FALLÓ o de un universo
 * mutilado. Un cero falso acá es un reclamo injusto a una persona.
 *
 * Tono: el fallo va en rojo (algo se rompió); la muestra parcial en amarillo
 * (el dato existe, pero no es el total). Ninguno de los dos es verde.
 */
export default function AvisoLecturaNovedades({
  loadError,
  muestraParcial,
  telefonosOmitidos,
  onReintentar,
  cargando,
}: {
  loadError: string | null;
  muestraParcial: boolean;
  telefonosOmitidos: number;
  onReintentar?: () => void;
  cargando?: boolean;
}) {
  if (!loadError && !muestraParcial) return null;

  if (loadError) {
    return (
      <div role="alert" className="flex items-start gap-3 rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3">
        <CloudOff size={16} className="mt-0.5 flex-shrink-0 text-danger" aria-hidden="true" />
        <div className="text-[11px] leading-relaxed flex-1 min-w-0">
          <span className="font-semibold text-danger">No se pudieron leer las novedades.</span>{' '}
          <span className="text-muted-foreground">
            Los números de abajo son lo último que sí se pudo leer, o no son números:
            no los tomes como la medición de hoy, y no le reclames a nadie por un
            cero que salió de acá.
          </span>
          <div className="mt-1 text-[10px] text-muted-foreground/80 font-mono break-words">{loadError}</div>
        </div>
        {onReintentar && (
          <button
            type="button"
            onClick={onReintentar}
            disabled={cargando}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[11px] font-semibold text-foreground hover:bg-card/70 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={11} className={cargando ? 'animate-spin' : ''} aria-hidden="true" /> Reintentar
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3">
      <Scissors size={16} className="mt-0.5 flex-shrink-0 text-warning" aria-hidden="true" />
      <div className="text-[11px] leading-relaxed">
        <span className="font-semibold text-warning">Muestra parcial: {telefonosOmitidos} clientes quedaron fuera.</span>{' '}
        <span className="text-muted-foreground">
          Las tasas y los rankings de abajo salen de lo que sí entró, no del total del
          período. Sirven para ver la tendencia, no para poner una cifra en un informe.
        </span>
      </div>
    </div>
  );
}
