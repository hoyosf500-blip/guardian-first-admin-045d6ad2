import { memo, useState } from 'react';
import { motion } from 'framer-motion';
import { ShieldCheck, ShieldAlert, RefreshCw, Wrench, Info } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import { useConciliacionDevoluciones } from '@/hooks/useConciliacionDevoluciones';
import { useRepararDevoluciones, MAX_POR_TANDA } from '@/hooks/useRepararDevoluciones';
import { useStore } from '@/contexts/StoreContext';

/**
 * "Dropi me cobró N devoluciones — ¿tengo las N?"
 *
 * Es la única pantalla que cruza las dos fuentes: la billetera (lo que Dropi
 * COBRA) y los pedidos (lo que Guardian VE). Sin ella, una devolución podía
 * existir, pagarse, y no aparecer nunca en el CRM.
 *
 * Las tres situaciones se muestran SEPARADAS porque son problemas distintos:
 *  · sin respaldo por AUSENCIA → el sync nunca trajo el pedido.
 *  · sin respaldo por ESTADO VIEJO → el pedido figura vivo o entregado, así que
 *    además de esconder la devolución INFLA la tasa de entrega.
 *  · sin referencia → el cobro no dice de qué pedido es: no se puede verificar.
 *    Ese NO se cuenta como faltante; afirmarlo sería inventar.
 */

const fadeUp = (delay: number) => ({
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay },
});

interface Props {
  fromDate: string;
  toDate: string;
}

export default memo(function ConciliacionDevolucionesCard({ fromDate, toDate }: Props) {
  const { activeStoreId, isManagerOfActive } = useStore();
  const { status, resumen, loading, refresh } = useConciliacionDevoluciones(fromDate, toDate);
  const { progreso, reparar } = useRepararDevoluciones();
  const [mostrarDetalle, setMostrarDetalle] = useState(false);

  // Sin RPC aplicada, sin permiso o con error: NO se dibuja. Una tarjeta que
  // dijera "0 sin respaldo" sin haber podido mirar sería justo la afirmación
  // sin verificar que este panel existe para evitar.
  if (status !== 'ok' || !resumen) return null;
  if (resumen.totalPeriodo === 0) return null;

  const r = resumen;
  const hayProblema = r.sinRespaldo.cobros > 0;
  const puedeReparar = isManagerOfActive && r.externalIdsAReparar.length > 0;

  const onReparar = async () => {
    await reparar(activeStoreId, r.externalIdsAReparar);
    // Re-consultar SIEMPRE, aunque la tanda haya fallado: el número que queda en
    // pantalla tiene que ser el real, no el que teníamos antes de intentar.
    refresh();
  };

  return (
    <motion.div
      {...fadeUp(0.215)}
      className={`hairline-top rounded-2xl border p-4 shadow-card3d ${
        hayProblema ? 'bg-warning/8 border-warning/30' : 'bg-card/40 border-border'
      }`}
    >
      <div className="flex items-start gap-3 flex-wrap">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${
          hayProblema ? 'bg-warning/20' : 'bg-success/15'
        }`}>
          {hayProblema
            ? <ShieldAlert size={17} className="text-warning" aria-hidden="true" />
            : <ShieldCheck size={17} className="text-success" aria-hidden="true" />}
        </div>

        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-foreground">
            Devoluciones que Dropi te cobró: {r.totalPeriodo}
            {r.plataPeriodo > 0 && (
              <span className="font-normal text-muted-foreground"> · {formatCOP(r.plataPeriodo)}</span>
            )}
          </h3>

          <p className="text-[11px] text-muted-foreground leading-relaxed mt-1">
            {hayProblema ? (
              <>
                <strong className="text-warning">{r.sinRespaldo.cobros} sin respaldo en el CRM</strong>
                {r.sinRespaldo.plata > 0 && <> ({formatCOP(r.sinRespaldo.plata)})</>}:{' '}
                {r.noEsta.cobros > 0 && <>{r.noEsta.cobros} de pedidos que nunca llegaron</>}
                {r.noEsta.cobros > 0 && r.noMarcado.cobros > 0 && ' · '}
                {r.noMarcado.cobros > 0 && (
                  <>
                    <strong className="text-foreground">{r.noMarcado.cobros} de pedidos que figuran en otro estado</strong>
                    {' '}(esos además inflan tu tasa de entrega)
                  </>
                )}
                .
              </>
            ) : (
              <>
                Todas tienen su pedido registrado como devolución. Las cifras de devoluciones
                de esta pantalla están respaldadas una por una.
              </>
            )}
          </p>

          {/* La cobertura va explícita: si muchos cobros no traen el id del
              pedido, el veredicto de arriba habla de una parte, no del total. */}
          {r.sinReferencia.cobros > 0 && (
            <p className="text-[10px] text-muted-foreground mt-1.5">
              {r.sinReferencia.cobros} cobro(s) no indican de qué pedido son: no se pueden verificar
              (no se cuentan como faltantes). Verificados {r.verificables} de {r.analizados}.
            </p>
          )}
          {r.parcial && (
            <p className="text-[10px] text-warning mt-1">
              Mostrando los {r.analizados} de mayor valor de {r.totalPeriodo}: acortá el rango para verlos todos.
            </p>
          )}

          {/* Progreso / resultado de la reparación */}
          {progreso.corriendo && (
            <p className="text-[11px] text-foreground mt-2 flex items-center gap-1.5">
              <RefreshCw size={12} className="animate-spin" aria-hidden="true" />
              Trayendo de Dropi {progreso.hechos} de {progreso.total}… (de a uno, para que Dropi no corte)
            </p>
          )}
          {!progreso.corriendo && progreso.hechos > 0 && (
            <p className="text-[11px] text-foreground mt-2">
              Se actualizaron <strong>{progreso.reparados}</strong> pedido(s)
              {progreso.fallidos > 0 && <> · {progreso.fallidos} no se pudieron traer</>}
              {progreso.frenadoPorThrottle && (
                <> · <span className="text-warning">Dropi cortó por exceso de consultas; esperá un minuto y seguí</span></>
              )}
              {progreso.restantes > 0 && <> · quedan {progreso.restantes}</>}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {puedeReparar && (
            <button
              type="button"
              onClick={onReparar}
              disabled={progreso.corriendo || loading}
              className="px-3 py-2 rounded-xl bg-card/60 border border-border text-foreground text-sm font-medium flex items-center gap-1.5 hover:border-border-strong transition-colors disabled:opacity-50"
              title={`Le pregunta a Dropi por cada pedido y actualiza el CRM (hasta ${MAX_POR_TANDA} por vez)`}
            >
              <Wrench size={13} aria-hidden="true" />
              {progreso.corriendo ? 'Trayendo…' : `Traer de Dropi (${Math.min(r.externalIdsAReparar.length, MAX_POR_TANDA)})`}
            </button>
          )}
          {hayProblema && (
            <button
              type="button"
              onClick={() => setMostrarDetalle((v) => !v)}
              className="px-3 py-2 rounded-xl bg-card/40 border border-border text-muted-foreground text-sm font-medium hover:text-foreground transition-colors"
            >
              {mostrarDetalle ? 'Ocultar' : 'Ver cuáles'}
            </button>
          )}
        </div>
      </div>

      {mostrarDetalle && hayProblema && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-muted-foreground border-b border-border/60">
                <th className="text-left font-medium py-1.5 px-2">Pedido</th>
                <th className="text-left font-medium py-1.5 px-2">Qué pasa</th>
                <th className="text-left font-medium py-1.5 px-2">Estado en Guardian</th>
                <th className="text-right font-medium py-1.5 px-2">Cobro</th>
              </tr>
            </thead>
            <tbody>
              {r.problemas.slice(0, 50).map((p, i) => (
                <tr key={`${p.movimiento_id ?? i}`} className="border-b border-border/40 last:border-0">
                  <td className="py-1.5 px-2 font-mono tabular-nums text-foreground">
                    {p.external_id || '—'}
                  </td>
                  <td className="py-1.5 px-2 text-muted-foreground">
                    {p.situacion === 'no_esta' && 'No está en el CRM'}
                    {p.situacion === 'no_marcado' && 'Figura en otro estado'}
                    {p.situacion === 'sin_referencia' && 'El cobro no dice de qué pedido es'}
                  </td>
                  <td className="py-1.5 px-2 text-foreground">{p.estado_guardian || '—'}</td>
                  <td className="py-1.5 px-2 text-right font-mono tabular-nums text-foreground">
                    {formatCOP(p.montoNum)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.problemas.length > 50 && (
            <p className="text-[10px] text-muted-foreground mt-1.5">
              Mostrando 50 de {r.problemas.length}.
            </p>
          )}
          <p className="text-[10px] text-muted-foreground mt-2 flex items-start gap-1.5">
            <Info size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
            El cobro se cuenta por la fecha en que Dropi lo debitó, no por la fecha del pedido:
            una devolución de fin de mes suele cobrarse el mes siguiente.
          </p>
        </div>
      )}
    </motion.div>
  );
});
