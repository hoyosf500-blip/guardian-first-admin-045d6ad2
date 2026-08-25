import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { UserCheck, UserX } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useOperatorNames } from '@/hooks/useOperatorNames';
import { useDevolucionSeguimiento } from '@/hooks/useDevolucionSeguimiento';
import type { RootCauseRange } from '@/hooks/useNovedadRootCause';
import { NovCard, MetricBar } from '@/components/novedades/NovedadesChrome';
import { fadeUp } from '@/components/novedades/chromeTokens';
import { formatCOP } from '@/lib/utils';
import { SEMANTIC_COLORS } from '@/components/logistics/charts/chartTokens';

/**
 * "Quién le hizo seguimiento a las devoluciones" — el lado de Seguimiento de la
 * responsabilidad, complemento de "Quién confirmó las devoluciones".
 *
 * Honesto por diseño: el seguimiento NO causa la devolución, la rescata. Por eso
 * el ranking dice "gestionó", y el bloque grande es cuántas NO tocó NADIE (hueco
 * de cobertura del equipo, no culpa de una persona). Match por teléfono → es una
 * señal direccional, va advertido al pie.
 */
export default function DevolucionesPorSeguidor({ range }: { range: RootCauseRange }) {
  const { nameOf } = useOperatorNames();
  const [adminIds, setAdminIds] = useState<string[]>([]);

  useEffect(() => {
    let on = true;
    void supabase.from('user_roles').select('user_id').eq('role', 'admin').then(({ data }) => {
      if (!on) return;
      setAdminIds((data ?? []).map((r: { user_id: string }) => r.user_id).filter(Boolean));
    });
    return () => { on = false; };
  }, []);

  const { loading, status, resumen, partial } = useDevolucionSeguimiento(range, adminIds);
  const maxGestor = useMemo(
    () => Math.max(1, ...resumen.porGestor.map((g) => g.devueltos)),
    [resumen.porGestor],
  );

  if (status === 'error') return null;

  const pctSinGestion = resumen.total > 0 ? Math.round((resumen.sinGestionSeg / resumen.total) * 100) : 0;

  return (
    <motion.div {...fadeUp(0.24)} className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      {/* Ranking: quién gestionó devueltos */}
      <NovCard title="Quién le hizo seguimiento a los devueltos" icon={UserCheck} iconClass="text-info">
        <div className="px-3 pb-2 flex items-center gap-2 hud-label border-b border-border/50">
          <span className="w-2.5 shrink-0" aria-hidden="true" />
          <span className="flex-1">Operadora</span>
          <span className="w-12 text-right">Devol.</span>
          <span className="w-20 text-right">$ en juego</span>
        </div>
        {loading ? (
          <p className="text-xs text-muted-foreground px-3 py-4 text-center">leyendo…</p>
        ) : resumen.porGestor.length === 0 ? (
          <p className="text-xs text-muted-foreground px-3 py-4 text-center">
            Ninguna devolución del período pasó por gestión de Seguimiento.
          </p>
        ) : (
          <ul className="space-y-1 mt-2">
            {resumen.porGestor.slice(0, 10).map((g) => (
              <MetricBar
                key={g.operatorId}
                label={nameOf(g.operatorId)}
                color={SEMANTIC_COLORS.info}
                pct={(g.devueltos / maxGestor) * 100}
                right={
                  <span className="flex items-baseline gap-2">
                    <span className="w-12 text-right font-bold text-muted-foreground">{g.devueltos}</span>
                    <span className="w-20 text-right text-muted-foreground tabular-nums">{formatCOP(g.valor)}</span>
                  </span>
                }
              />
            ))}
          </ul>
        )}
      </NovCard>

      {/* Hueco de cobertura: devueltos que nadie tocó */}
      <NovCard title="Devueltos que NADIE gestionó en Seguimiento" icon={UserX} iconClass="text-danger">
        <div className="flex flex-col items-center justify-center gap-1 py-6 text-center">
          {loading ? (
            <span className="text-3xl font-black text-muted-foreground">—</span>
          ) : (
            <>
              <span className={`text-4xl font-black tabular-nums ${resumen.sinGestionSeg > 0 ? 'text-danger' : 'text-foreground'}`}>
                {resumen.sinGestionSeg}
              </span>
              <span className="text-xs text-muted-foreground">
                de {resumen.total} devueltos · {pctSinGestion}% · {formatCOP(resumen.valorSinGestion)} sin rescatar
              </span>
              <p className="text-[11px] text-muted-foreground max-w-xs mt-2">
                Nadie los llamó ni les avisó mientras estaban en tránsito u oficina. Es cobertura
                del equipo, no falla de una persona.
              </p>
            </>
          )}
        </div>
      </NovCard>

      <p className="lg:col-span-2 text-[10px] text-muted-foreground text-center">
        Seguimiento = operadora que registró una gestión «SEG:» sobre el teléfono del pedido (match por teléfono,
        no por número de pedido: un cliente con dos pedidos devueltos cuenta las dos veces). Si dos operadoras lo
        tocaron, cuenta para ambas. Devueltos por fecha de creación en el período.
        {partial && ' · Resultado parcial: se alcanzó el tope de gestiones leídas — acortá el rango.'}
      </p>
    </motion.div>
  );
}
