import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, RefreshCw, TrendingUp, AlertTriangle, Trophy } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid } from 'recharts';

type Range = 'today' | '24h' | '7d' | '30d';

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
}

const RANGE_LABELS: Record<Range, string> = {
  'today': 'Hoy',
  '24h': 'Últimas 24h',
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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Antes solo console.error → la UI mostraba "Sin actividad" indistinguible
  // de un error silenciado vs cero filas reales. Ahora capturamos el mensaje
  // y lo renderizamos como banner visible para diagnóstico inmediato.
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    const { data, error: rpcErr } = await supabase.rpc('operator_productivity_stats' as never, { p_range: range } as never);
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
            {(['today', '24h', '7d', '30d'] as Range[]).map(r => (
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
                  {leader.confirmados} confirmados · {leader.tasa_confirmacion}% tasa
                </div>
              </div>
            </div>
          )}

          {/* Confirmar — el `note` ahora muestra la N de inflow del período
              (total_entrantes) porque es el denominador de "Tasa confirmación"
              desde la migration 20260505120000. Antes la tasa era sobre lo
              gestionado por cada operadora; ahora es sobre el inflow global,
              así que la operadora ve cuántos pedidos en total se ofrecieron
              al equipo en el período. */}
          <Section
            title="Confirmar"
            dotClass="bg-success"
            note={
              rows[0]?.total_entrantes && rows[0].total_entrantes > 0
                ? `${rows[0].total_entrantes} pedido${rows[0].total_entrantes === 1 ? '' : 's'} entró al período · tasa = confirmados ÷ entrantes`
                : 'Resultados del flujo de confirmación de pedidos'
            }
          >
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="w-10">#</th>
                    <th>Operadora</th>
                    <th className="text-right">Conf.</th>
                    <th className="text-right">Canc.</th>
                    <th className="text-right">N/R</th>
                    <th className="text-right">Atendidos</th>
                    <th className="text-right">Tasa contacto</th>
                    <th
                      className="text-right"
                      title={
                        rows[0]?.total_entrantes && rows[0].total_entrantes > 0
                          ? `Confirmados ÷ ${rows[0].total_entrantes} pedidos entrantes (sobre el inflow del período, no sobre los que la operadora gestionó)`
                          : 'Confirmados ÷ pedidos entrantes (sobre el inflow del período, no sobre los que la operadora gestionó)'
                      }
                    >
                      Tasa confirmación
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
                      <td className="text-right"><RateBar value={r.tasa_confirmacion} /></td>
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
              actionTone="info"
            />
          </Section>

          {/* Rescate */}
          <Section title="Rescate" dotClass="bg-danger" note="Touchpoints marcados sobre pedidos en rescate">
            <ResolutionTable
              rows={rows}
              acciones={r => r.rescate_acciones}
              resueltos={r => r.rescate_resueltos}
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
  rows, acciones, resueltos, actionTone,
}: {
  rows: Row[];
  acciones: (r: Row) => number;
  resueltos: (r: Row) => number;
  actionTone: 'info' | 'danger';
}) {
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th className="w-10">#</th>
            <th>Operadora</th>
            <th className="text-right">Acciones</th>
            <th className="text-right">Resueltos</th>
            <th className="text-right">Pendientes</th>
            <th className="text-right">Tasa de resolución</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => {
            const acc = acciones(r);
            const res = resueltos(r);
            const pendientes = Math.max(0, acc - res);
            const tasa = acc > 0 ? Math.round((res / acc) * 100) : 0;
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
