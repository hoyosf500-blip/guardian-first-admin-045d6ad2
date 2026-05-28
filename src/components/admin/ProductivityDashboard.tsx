import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, RefreshCw, TrendingUp, AlertTriangle, Trophy, Clock } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid } from 'recharts';
import { confRateBySample } from '@/lib/confirmationRate';
import { formatTimeBogota, formatDurationHM } from '@/lib/timeFormat';

interface ActivityRow {
  operator_id: string;
  display_name: string;
  first_action_at: string | null;
  last_active_at: string | null;
  active_seconds: number;
  idle_seconds: number;
}

// Sin '24h' rodante: las ventanas se alinean a día-calendario Bogotá (igual que
// el cohorte de Reportes Diarios) para que "entrantes" reconcilie entre vistas.
type Range = 'today' | '7d' | '30d';

interface Row {
  operator_id: string;
  display_name: string;
  confirmados: number;
  cancelados: number;
  noresp: number;
  novedades_resueltas: number;
  seg_acciones: number;
  seg_resueltos: number;
  rescate_acciones: number;
  rescate_resueltos: number;
  total_atendidos: number;
  /** Total de pedidos que entraron al período (inflow global). Mismo valor
   *  para todas las filas — UI lo lee de rows[0]. Denominador de
   *  tasa_confirmacion desde la migration 20260505120000. */
  total_entrantes: number;
  tasa_contacto: number;
  /** % confirmados sobre total_entrantes (NO sobre gestionados). Refleja
   *  productividad real: penaliza dejar pedidos sin gestionar. */
  tasa_confirmacion: number;
  /** Conteos por PEDIDO DISTINTO (phone), no por acción. Base correcta de la
   *  tasa de resolución. Opcionales: si la migración 20260526140000 aún no se
   *  aplicó, vienen undefined y la UI cae al cálculo viejo sobre acciones. */
  seg_pedidos?: number;
  seg_resueltos_dist?: number;
  rescate_pedidos?: number;
  rescate_resueltos_dist?: number;
}

const RANGE_LABELS: Record<Range, string> = {
  'today': 'Hoy',
  '7d': 'Últimos 7 días',
  '30d': 'Últimos 30 días',
};

/** Bullet-style data bar para tasas. Tono semántico vs benchmark
 *  (70% target estándar COD Colombia). */
function RateBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const tone = pct >= 70 ? 'success' : pct >= 60 ? 'warning' : 'danger';
  return (
    <div className={`data-bar tone-${tone}`}>
      <div className="data-bar-fill" style={{ width: `${pct}%` }} aria-hidden="true" />
      <span className="data-bar-value">{pct.toFixed(0)}%</span>
    </div>
  );
}

export default function ProductivityDashboard() {
  const [range, setRange] = useState<Range>('today');
  const [rows, setRows] = useState<Row[]>([]);
  const [activityRows, setActivityRows] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Antes solo console.error → la UI mostraba "Sin actividad" indistinguible
  // de un error silenciado vs cero filas reales. Ahora capturamos el mensaje
  // y lo renderizamos como banner visible para diagnóstico inmediato.
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    // El scope por tienda lo resuelve la RPC server-side vía
    // _resolve_scope_store() (admin → su tienda activa, profiles.active_store_id).
    // No pasamos p_store_id: así NO dependemos de que la migration del parámetro
    // esté aplicada (evita el PGRST202 "function ... does not exist").
    const [productivity, activity] = await Promise.all([
      supabase.rpc('operator_productivity_stats' as never, { p_range: range } as never),
      // Jornada — RPC separada (migration 20260528200000). Si aún no se aplicó,
      // capturamos el PGRST202 silencioso y mostramos la sección vacía: el
      // dashboard principal sigue funcionando aunque jornada no exista.
      supabase.rpc('operator_activity_stats' as never, { p_range: range } as never),
    ]);
    const { data, error: rpcErr } = productivity;
    if (rpcErr) {
      console.error('[productivity] rpc error', rpcErr);
      const e = rpcErr as { code?: string; message?: string; hint?: string; details?: string };
      setError(`${e.code || 'ERR'}: ${e.message || 'Error desconocido'}${e.hint ? ` — ${e.hint}` : ''}${e.details ? ` (${e.details})` : ''}`);
      setRows([]);
    } else {
      const arr = (data as Row[] | null) ?? [];
      setRows(arr);
      setError(null);
    }
    // Jornada: ignoramos error silenciosamente (la migration puede no estar).
    if (!activity.error) {
      setActivityRows((activity.data as ActivityRow[] | null) ?? []);
    } else if (process.env.NODE_ENV !== 'production') {
      console.warn('[productivity] activity rpc error', activity.error);
    }
    setLoading(false);
    setRefreshing(false);
  }, [range]);

  useEffect(() => { load(); }, [load]);

  // Realtime debounced 1s: cualquier cambio en orders/order_results/touchpoints
  // dispara un refetch silencioso. Sin polling.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => load(true), 1000);
    };
    const channel = supabase
      .channel('admin-productivity')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, debounced)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'order_results' }, debounced)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'touchpoints' }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'operator_activity_daily' }, debounced)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [load]);

  const chartData = rows.map(r => ({
    name: r.display_name,
    Confirmados: r.confirmados,
    Cancelados: r.cancelados,
  }));

  // Líder del día — para el callout de "Top operadora"
  const leader = rows.length > 0
    ? [...rows].sort((a, b) => b.confirmados - a.confirmados)[0]
    : null;

  // Cobertura del EQUIPO: cuánto del inflow del período alcanzó a resolver el
  // equipo. `entrantes` es global (no por operadora) → va en el header de la
  // sección, NO en la columna por-operadora (eso confundía: numerador por-op /
  // denominador de equipo daba el viejo 83%).
  const entrantes = rows[0]?.total_entrantes ?? 0;
  const teamResueltos = rows.reduce((a, r) => a + r.confirmados + r.cancelados, 0);
  const teamCobertura = entrantes > 0 ? Math.round((teamResueltos / entrantes) * 100) : 0;

  return (
    <div className="space-y-5">
      {/* Page sub-header — eyebrow + título + meta + actions */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted-foreground">
            Productividad · Equipo
          </div>
          <h2 className="text-xl font-bold tracking-tight text-foreground leading-none flex items-center gap-2">
            <TrendingUp size={18} className="text-accent" aria-hidden="true" strokeWidth={2.25} />
            Por operadora
          </h2>
          <p className="text-sm text-muted-foreground">
            {RANGE_LABELS[range]} · auto-refresh activo
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="flex rounded-lg border border-border bg-card p-0.5">
            {(['today', '7d', '30d'] as Range[]).map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  range === r ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card transition-colors hover:border-border-strong hover:bg-muted/40 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label="Refrescar"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-danger/30 bg-danger/5 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="text-danger mt-0.5 shrink-0" aria-hidden="true" strokeWidth={2.25} />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-bold text-danger">Error cargando productividad</p>
              <p className="text-xs text-foreground/80 font-mono break-all">{error}</p>
              <p className="text-[11px] text-muted-foreground">
                Si dice <code className="px-1 rounded bg-muted/40">function … does not exist</code>: la migration de la RPC no se aplicó.
                Si dice <code className="px-1 rounded bg-muted/40">42501</code> o <code className="px-1 rounded bg-muted/40">Solo administradores</code>: tu usuario no tiene rol admin en <code className="px-1 rounded bg-muted/40">user_roles</code>.
              </p>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-border bg-card p-10 flex items-center justify-center">
          <Loader2 className="animate-spin text-accent" size={20} aria-hidden="true" />
        </div>
      ) : !error && rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/40 p-10 text-center">
          <p className="text-sm font-semibold text-foreground mb-1">Sin actividad</p>
          <p className="text-xs text-muted-foreground">Nadie ha registrado acciones en {RANGE_LABELS[range].toLowerCase()}.</p>
        </div>
      ) : !error ? (
        <>
          {/* Jornada — hora de inicio + tiempo activo/idle por operadora.
              Section separada porque es métrica de presencia, no de outcome.
              Si activityRows está vacía (migración aún sin aplicar o no hubo
              pings hoy) la sección directamente no renderiza para no agregar
              ruido. */}
          {activityRows.length > 0 && (
            <Section
              title="Jornada"
              dotClass="bg-info"
              note="Cuándo empezó cada operadora y cuánto tiempo estuvo activa (mouse/teclado idle > 5 min cuenta como muerto)"
            >
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="w-10">#</th>
                      <th>Operadora</th>
                      <th className="text-right" title="Primer movimiento de mouse o teclado del día (zona Bogotá)">Empezó</th>
                      <th className="text-right" title="Último movimiento detectado">Última act.</th>
                      <th className="text-right" title="Tiempo total con actividad en los últimos 5 min">Activo</th>
                      <th className="text-right" title="Tiempo sin actividad > 5 min">Inactivo</th>
                      <th className="text-right" title="Activo ÷ (Activo + Inactivo)">% Activa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activityRows.map((r, idx) => {
                      const total = r.active_seconds + r.idle_seconds;
                      const pct = total > 0 ? Math.round((r.active_seconds / total) * 100) : 0;
                      const pctTone = pct >= 70 ? 'success' : pct >= 50 ? 'warning' : 'danger';
                      return (
                        <tr key={r.operator_id}>
                          <td>
                            <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                              {String(idx + 1).padStart(2, '0')}
                            </span>
                          </td>
                          <td className="font-semibold text-foreground">{r.display_name}</td>
                          <td className="text-right font-mono tabular-nums text-foreground">
                            <span className="inline-flex items-center gap-1 justify-end">
                              <Clock size={11} className="text-muted-foreground" aria-hidden="true" />
                              {formatTimeBogota(r.first_action_at)}
                            </span>
                          </td>
                          <td className="text-right font-mono tabular-nums text-muted-foreground">
                            {formatTimeBogota(r.last_active_at)}
                          </td>
                          <td className="text-right font-mono tabular-nums text-success font-semibold">
                            {formatDurationHM(r.active_seconds)}
                          </td>
                          <td className="text-right font-mono tabular-nums text-danger font-semibold">
                            {formatDurationHM(r.idle_seconds)}
                          </td>
                          <td className="text-right">
                            <span className={`font-mono tabular-nums font-bold text-${pctTone}`}>
                              {total > 0 ? `${pct}%` : '—'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {/* Top performer callout */}
          {leader && leader.confirmados > 0 && (
            <div className="rounded-xl border border-accent/25 bg-card p-3.5 flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent/12">
                <Trophy size={16} className="text-accent" aria-hidden="true" strokeWidth={2.25} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
                  Top operadora — {RANGE_LABELS[range].toLowerCase()}
                </div>
                <div className="text-sm font-bold text-foreground truncate">{leader.display_name}</div>
                <div className="text-xs text-accent font-mono font-semibold tabular-nums">
                  {leader.confirmados} confirmados · {(() => {
                    const t = confRateBySample(leader.confirmados, leader.cancelados).tasa;
                    return t == null ? '—' : `${t}%`;
                  })()} confirmación
                </div>
              </div>
            </div>
          )}

          {/* Confirmar — el `note` muestra la COBERTURA DEL EQUIPO (cuánto del
              inflow del período alcanzó a resolver el equipo). La tasa POR
              OPERADORA de la tabla es la MADURA (conf ÷ resueltos), separada del
              volumen del equipo — antes se mezclaba (conf ÷ entrantes = 83%) y
              confundía. Ver src/lib/confirmationRate.ts. */}
          <Section
            title="Confirmar"
            dotClass="bg-success"
            note={
              entrantes > 0
                ? `${entrantes} entrante${entrantes === 1 ? '' : 's'} al período · el equipo resolvió ${teamResueltos} (${teamCobertura}% cobertura)`
                : 'Resultados del flujo de confirmación de pedidos'
            }
          >
            {/* Mini-glosario: que se entienda cada KPI de un vistazo */}
            <div className="px-4 py-2.5 border-b border-border/60 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
              <span><strong className="text-foreground">Atendidos</strong>: pedidos distintos que gestionó</span>
              <span><strong className="text-foreground">Contacto</strong>: % de lo atendido que contestó</span>
              <span><strong className="text-foreground">% Confirmación</strong>: confirmados ÷ (confirmados + cancelados)</span>
              <span className="opacity-70">gris* = pocos datos, preliminar</span>
            </div>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="w-10">#</th>
                    <th>Operadora</th>
                    <th className="text-right">Conf.</th>
                    <th className="text-right">Canc.</th>
                    <th
                      className="text-right"
                      title="Pedidos distintos que no contestaron al final del período (un pedido reintentado 3 veces cuenta como 1)"
                    >
                      N/R
                    </th>
                    <th className="text-right">Atendidos</th>
                    <th
                      className="text-right"
                      title="De los pedidos que atendió, % que contestó (confirmó o canceló). Los pendientes que aún no tocó NO cuentan."
                    >
                      Contacto
                    </th>
                    <th
                      className="text-right"
                      title="Confirmados ÷ (confirmados + cancelados) — tasa MADURA, solo sobre pedidos ya resueltos. Gris* = pocos datos, preliminar."
                    >
                      % Confirmación
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, idx) => (
                    <tr key={r.operator_id}>
                      <td>
                        <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                          {String(idx + 1).padStart(2, '0')}
                        </span>
                      </td>
                      <td className="font-semibold text-foreground">{r.display_name}</td>
                      <td className="text-right font-mono tabular-nums text-success font-semibold">{r.confirmados}</td>
                      <td className="text-right font-mono tabular-nums text-danger font-semibold">{r.cancelados}</td>
                      <td className="text-right font-mono tabular-nums text-muted-foreground">{r.noresp}</td>
                      <td className="text-right font-mono tabular-nums">{r.total_atendidos}</td>
                      <td className="text-right">
                        <span className="font-mono tabular-nums text-xs text-muted-foreground">{r.tasa_contacto}%</span>
                      </td>
                      <td className="text-right">{(() => {
                        const cr = confRateBySample(r.confirmados, r.cancelados);
                        if (cr.tasa == null) return <span className="font-mono tabular-nums text-xs text-muted-foreground">—</span>;
                        if (cr.inmaduro) return (
                          <span className="font-mono tabular-nums text-xs text-muted-foreground" title="Pocos resueltos — preliminar">
                            {cr.tasa}% *
                          </span>
                        );
                        return <RateBar value={cr.tasa} />;
                      })()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* Seguimiento */}
          <Section title="Seguimiento" dotClass="bg-info" note="Touchpoints marcados sobre pedidos en seguimiento">
            <ResolutionTable
              rows={rows}
              acciones={r => r.seg_acciones}
              resueltos={r => r.seg_resueltos}
              pedidos={r => r.seg_pedidos}
              resueltosDist={r => r.seg_resueltos_dist}
              actionTone="info"
            />
          </Section>

          {/* Rescate */}
          <Section title="Rescate" dotClass="bg-danger" note="Touchpoints marcados sobre pedidos en rescate">
            <ResolutionTable
              rows={rows}
              acciones={r => r.rescate_acciones}
              resueltos={r => r.rescate_resueltos}
              pedidos={r => r.rescate_pedidos}
              resueltosDist={r => r.rescate_resueltos_dist}
              actionTone="danger"
            />
          </Section>

          {/* Novedades */}
          {rows.some(r => r.novedades_resueltas > 0) && (
            <Section title="Novedades" dotClass="bg-warning" note="Novedades de transportadora resueltas">
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="w-10">#</th>
                      <th>Operadora</th>
                      <th className="text-right">Resueltas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.filter(r => r.novedades_resueltas > 0).map((r, idx) => (
                      <tr key={r.operator_id}>
                        <td>
                          <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                            {String(idx + 1).padStart(2, '0')}
                          </span>
                        </td>
                        <td className="font-semibold text-foreground">{r.display_name}</td>
                        <td className="text-right font-mono tabular-nums text-warning font-semibold">{r.novedades_resueltas}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
        </>
      ) : null}

      {/* Bar chart comparativo — recharts con HSL vars del DS */}
      {!loading && rows.length > 0 && (
        <Section title="Comparativo Confirmados vs Cancelados" dotClass="bg-accent">
          <div className="p-4">
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 12, left: -16, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'hsl(var(--popover))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" iconSize={9} />
                  <Bar dataKey="Confirmados" fill="hsl(var(--success))" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Cancelados" fill="hsl(var(--danger))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────

function Section({ title, dotClass, note, children }: { title: string; dotClass: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <header className="px-4 py-3 border-b border-border/60 flex items-center justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`h-2 w-2 rounded-full shrink-0 ${dotClass}`} aria-hidden="true" />
          <h3 className="text-sm font-bold text-foreground tracking-tight">{title}</h3>
          {note && <span className="text-[11px] text-muted-foreground hidden md:inline truncate">· {note}</span>}
        </div>
      </header>
      {children}
    </section>
  );
}

function ResolutionTable({
  rows, acciones, resueltos, pedidos, resueltosDist, actionTone,
}: {
  rows: Row[];
  acciones: (r: Row) => number;
  resueltos: (r: Row) => number;
  /** Pedidos distintos tocados (base correcta de la tasa). Si no viene → fallback. */
  pedidos?: (r: Row) => number | undefined;
  /** Pedidos distintos resueltos. Si no viene → fallback. */
  resueltosDist?: (r: Row) => number | undefined;
  actionTone: 'info' | 'danger';
}) {
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th className="w-10">#</th>
            <th>Operadora</th>
            <th className="text-right" title="Touchpoints totales (esfuerzo). Un pedido gestionado varios días suma varias acciones.">Acciones</th>
            <th className="text-right">Resueltos</th>
            <th className="text-right" title="Pedidos distintos tocados que aún no se cierran (Resuelto/Devolución).">Pendientes</th>
            <th className="text-right" title="Resueltos ÷ pedidos distintos tocados (NO sobre acciones — los reintentos no inflan el denominador).">Tasa de resolución</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => {
            const acc = acciones(r);
            // Base de la tasa = pedidos DISTINTOS si la RPC los devuelve; si no
            // (migración sin aplicar), fallback al conteo de acciones (comportamiento viejo).
            const pedDist = pedidos?.(r);
            const resDist = resueltosDist?.(r);
            const hasDistinct = pedDist != null && resDist != null;
            const denom = hasDistinct ? (pedDist as number) : acc;
            const res = hasDistinct ? (resDist as number) : resueltos(r);
            const pendientes = Math.max(0, denom - res);
            const tasa = denom > 0 ? Math.round((res / denom) * 100) : 0;
            return (
              <tr key={r.operator_id}>
                <td>
                  <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                    {String(idx + 1).padStart(2, '0')}
                  </span>
                </td>
                <td className="font-semibold text-foreground">{r.display_name}</td>
                <td className={`text-right font-mono tabular-nums font-semibold ${actionTone === 'info' ? 'text-info' : 'text-danger'}`}>
                  {acc}
                </td>
                <td className="text-right font-mono tabular-nums text-success font-semibold">{res}</td>
                <td className="text-right font-mono tabular-nums text-muted-foreground">{pendientes}</td>
                <td className="text-right"><RateBar value={tasa} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
