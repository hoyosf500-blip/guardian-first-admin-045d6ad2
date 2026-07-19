import { useState, useMemo } from 'react';
import { X, AlertTriangle, CheckCircle2, Loader2, RefreshCw, Search } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import {
  fetchGuardianNonTerminal,
  fetchDropiSnapshot,
  findDivergences,
  applyDivergences,
  GUARDIAN_SCAN_LIMIT,
  type Divergence,
} from '@/lib/dropiAudit';

interface Props {
  open: boolean;
  onClose: () => void;
  storeId: string;
}

type State = 'idle' | 'scanning' | 'results' | 'applying' | 'done';

// Ventana de auditoría: 14 días es el sweet-spot. Cubre la totalidad de
// pedidos no-terminales (los que llevan > 14d sin entregar son fantasmas o
// huérfanos de backfill viejo, no transit normal) y reduce N páginas a
// Dropi (menos chance de throttle).
// Vive a nivel de módulo para que la copy de pantalla interpole ESTA constante
// y no pueda volver a desincronizarse del rango que realmente se consulta.
const RANGE_DAYS = 14;

export default function DropiAuditModal({ open, onClose, storeId }: Props) {
  const { user } = useAuth();
  const [state, setState] = useState<State>('idle');
  const [divergences, setDivergences] = useState<Divergence[]>([]);
  const [filter, setFilter] = useState<'all' | 'update' | 'cancel_orphan'>('all');
  // guardianCount = pedidos efectivamente COMPARADOS. guardianTotal = cuántos
  // no-terminales hay de verdad en la DB (null si el servidor no lo devolvió —
  // null NO es 0). Si el escaneo se topó, guardianCount es una muestra y hay
  // que decirlo: si no, el modal declara "paridad perfecta" sobre pedidos que
  // nunca miró.
  const [guardianTotal, setGuardianTotal] = useState<number | null>(null);
  const [guardianTruncated, setGuardianTruncated] = useState(false);
  const [guardianCount, setGuardianCount] = useState(0);
  const [dropiCount, setDropiCount] = useState(0);
  const [applied, setApplied] = useState(0);
  const [failed, setFailed] = useState<Divergence[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [coverageMissing, setCoverageMissing] = useState<number>(0);

  const filtered = useMemo(
    () => filter === 'all' ? divergences : divergences.filter(d => d.action === filter),
    [divergences, filter],
  );

  if (!open) return null;

  const handleScan = async () => {
    setError(null);
    setWarning(null);
    setCoverageMissing(0);
    setGuardianTotal(null);
    setGuardianTruncated(false);
    setState('scanning');
    try {
      const today = new Date();
      const to = today.toISOString().split('T')[0];
      const fromD = new Date(today); fromD.setUTCDate(fromD.getUTCDate() - RANGE_DAYS);
      const from = fromD.toISOString().split('T')[0];

      const [guardian, dropi] = await Promise.all([
        fetchGuardianNonTerminal(supabase, storeId),
        fetchDropiSnapshot(supabase, storeId, from, to),
      ]);
      setGuardianCount(guardian.orders.length);
      setGuardianTotal(guardian.total);
      setGuardianTruncated(guardian.truncated);
      setDropiCount(dropi.snapshot.size);

      // Coverage real: ¿cuántos no-terminales de Guardian NO aparecieron en
      // el snapshot? Si la respuesta fue parcial, esos pueden ser huérfanos
      // o pueden ser falsos positivos (estaban en una página que no trajimos).
      // Solo marcamos divergencias para los que SÍ vimos en Dropi (matched)
      // — los faltantes los contamos aparte como "coverage incompleta".
      let missingCount = 0;
      if (dropi.partial) {
        for (const g of guardian.orders) {
          if (!dropi.snapshot.has(String(g.external_id))) missingCount++;
        }
        setCoverageMissing(missingCount);
      }
      if (dropi.partial && dropi.message) {
        setWarning(`${dropi.message}. ${missingCount > 0 ? `${missingCount} de ${guardian.orders.length} pedidos Guardian no se pudieron verificar.` : ''}`);
      }

      // Si fue parcial, filtramos las divergencias tipo "cancel_orphan" para
      // pedidos que NO vimos en Dropi — no sabemos si son realmente huérfanos
      // o solo quedaron en una página no traída. Las "update" sí son confiables
      // (el pedido apareció en Dropi pero con estado distinto).
      let divs = findDivergences(guardian.orders, dropi.snapshot);
      if (dropi.partial) {
        divs = divs.filter(d => d.action === 'update');
      }
      setDivergences(divs);
      setState('results');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setState('idle');
      toast.error(`Auditoría falló: ${msg}`);
    }
  };

  const handleApply = async () => {
    if (filtered.length === 0) return;
    if (!window.confirm(`¿Aplicar ${filtered.length} cambios en Guardian? Esta acción NO modifica Dropi.`)) return;
    setState('applying');
    try {
      const r = await applyDivergences(supabase, storeId, filtered);
      setApplied(r.applied);
      setFailed(r.failed);
      // Audit row
      if (user) {
        await supabase.from('audit_runs').insert({
          store_id: storeId,
          run_by: user.id,
          guardian_count: guardianCount,
          dropi_count: dropiCount,
          divergences_found: divergences.length,
          missing_in_dropi: divergences.filter(d => d.action === 'cancel_orphan').length,
          divergences_applied: r.applied,
          notes: r.failed.length > 0 ? `${r.failed.length} fallidos` : null,
        });
      }
      setState('done');
      toast.success(`${r.applied} aplicados${r.failed.length ? ` · ${r.failed.length} fallidos` : ''}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setState('results');
      toast.error(msg);
    }
  };

  const handleReset = () => {
    setState('idle');
    setDivergences([]);
    setApplied(0);
    setFailed([]);
    setError(null);
  };

  const updates = divergences.filter(d => d.action === 'update').length;
  const orphans = divergences.filter(d => d.action === 'cancel_orphan').length;

  // Aviso de muestra truncada. Sin conteo exacto no inventamos el faltante:
  // decimos que hay más sin revisar, sin poner un número que no medimos.
  const truncationNote = guardianTotal !== null
    ? `Datos parciales: Guardian tiene ${guardianTotal} pedidos no-terminales y el escaneo lee hasta ${GUARDIAN_SCAN_LIMIT} por corrida. Se compararon ${guardianCount} contra Dropi — los ${guardianTotal - guardianCount} restantes no se revisaron.`
    : `Datos parciales: se compararon ${guardianCount} pedidos no-terminales (tope del escaneo) y puede haber más sin revisar contra Dropi.`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" role="dialog">
      <div className="bg-card border border-border rounded-3xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden shadow-card3d-lg hairline-top">
        <header className="px-5 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <Search size={16} className="text-accent" />
            <h2 className="text-sm font-bold text-foreground">Auditar paridad Guardian ↔ Dropi</h2>
          </div>
          <button onClick={onClose} aria-label="Cerrar" className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {state === 'idle' && (
            <div className="text-center py-10 space-y-4">
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                Lee tus pedidos no-terminales y los compara con lo que Dropi reporta en vivo de los
                últimos {RANGE_DAYS} días. Reporta divergencias de estado / guía / transportadora.
              </p>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <button onClick={handleScan}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-semibold hover:opacity-90 cursor-pointer">
                <Search size={14} /> Escanear ahora
              </button>
            </div>
          )}

          {state === 'scanning' && (
            <div className="text-center py-10 space-y-3" aria-live="polite">
              <Loader2 size={28} className="text-accent animate-spin mx-auto" />
              <p className="text-sm text-foreground font-semibold">Comparando…</p>
              <p className="text-xs text-muted-foreground">Esto puede tomar 10–30 segundos.</p>
            </div>
          )}

          {(state === 'results' || state === 'applying') && (
            <>
              <div className={`grid gap-3 ${coverageMissing > 0 ? 'grid-cols-5' : 'grid-cols-4'}`}>
                <Stat
                  label="Guardian"
                  value={guardianCount}
                  accent={guardianTruncated ? 'warning' : undefined}
                  note={guardianTruncated
                    ? (guardianTotal !== null ? `de ${guardianTotal} · parcial` : 'parcial · hay más')
                    : undefined}
                />
                <Stat label="Dropi" value={dropiCount} />
                <Stat label="Updates" value={updates} accent={updates > 0 ? 'warning' : undefined} />
                <Stat label="Huérfanos" value={orphans} accent={orphans > 0 ? 'danger' : undefined} />
                {coverageMissing > 0 && (
                  <Stat label="Sin verificar" value={coverageMissing} accent="warning" />
                )}
              </div>

              {guardianTruncated && (
                <div className="flex items-start gap-2 p-3 rounded-2xl bg-warning/10 border border-warning/30 shadow-card3d">
                  <AlertTriangle size={14} className="text-warning flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-warning">{truncationNote}</p>
                </div>
              )}

              {warning && (
                <div className="flex items-start gap-2 p-3 rounded-2xl bg-warning/10 border border-warning/30 shadow-card3d">
                  <AlertTriangle size={14} className="text-warning flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-warning">{warning}</p>
                </div>
              )}

              {divergences.length === 0 ? (
                coverageMissing > 0 ? (
                  // Cobertura incompleta: no podemos afirmar paridad perfecta.
                  // Mostramos un mensaje neutro con el número de no verificados
                  // y CTA para reintentar (en 1–2 min, throttle Dropi suele liberar).
                  <div className="flex items-start gap-3 p-4 rounded-2xl bg-warning/10 border border-warning/30 shadow-card3d">
                    <AlertTriangle size={20} className="text-warning flex-shrink-0 mt-0.5" />
                    <div className="flex-1 space-y-1">
                      <p className="text-sm font-semibold text-warning">
                        Análisis incompleto — Dropi limitó la cobertura.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Verificamos {guardianCount - coverageMissing} de {guardianCount} pedidos Guardian. Los
                        {' '}{coverageMissing} restantes podrían estar OK o ser huérfanos — esperá 1–2 min y
                        reintentá.
                      </p>
                    </div>
                  </div>
                ) : guardianTruncated ? (
                  // Muestra truncada: cero divergencias ACÁ no es paridad. Los
                  // pedidos que nunca leímos no pueden declararse alineados.
                  <div className="flex items-start gap-3 p-4 rounded-2xl bg-warning/10 border border-warning/30 shadow-card3d">
                    <AlertTriangle size={20} className="text-warning flex-shrink-0 mt-0.5" />
                    <div className="flex-1 space-y-1">
                      <p className="text-sm font-semibold text-warning">
                        Sin divergencias en lo comparado — no alcanza para afirmar paridad.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Quedaron pedidos no-terminales fuera del escaneo (ver el aviso de arriba).
                        Hasta revisarlos no se puede descartar que haya fantasmas.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 p-4 rounded-2xl bg-success/10 border border-success/30 shadow-card3d">
                    <CheckCircle2 size={20} className="text-success" />
                    <p className="text-sm font-semibold text-success">Paridad perfecta — sin divergencias.</p>
                  </div>
                )
              ) : (
                <>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Filtrar:</span>
                    {(['all', 'update', 'cancel_orphan'] as const).map(f => (
                      <button key={f} onClick={() => setFilter(f)}
                        className={`px-2 py-1 rounded-md ${filter === f ? 'bg-accent text-accent-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'} cursor-pointer`}>
                        {f === 'all' ? `Todos (${divergences.length})` : f === 'update' ? `Updates (${updates})` : `Huérfanos (${orphans})`}
                      </button>
                    ))}
                  </div>

                  <div className="border border-border rounded-2xl overflow-hidden shadow-card3d">
                    <table className="w-full text-xs">
                      <thead className="bg-secondary text-muted-foreground">
                        <tr>
                          <th className="text-left px-3 py-2">Ext ID</th>
                          <th className="text-left px-3 py-2">Cliente</th>
                          <th className="text-left px-3 py-2">Antes</th>
                          <th className="text-left px-3 py-2">Después</th>
                          <th className="text-left px-3 py-2">Acción</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {filtered.slice(0, 100).map(d => (
                          <tr key={d.guardianId} className="hover:bg-secondary/50">
                            <td className="px-3 py-2 font-mono">{d.externalId}</td>
                            <td className="px-3 py-2 truncate max-w-[140px]">{d.nombre}</td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {d.before.estado}{d.before.guia ? ` · ${d.before.guia}` : ''}
                            </td>
                            <td className="px-3 py-2 font-semibold">
                              {d.after.estado}{d.after.guia ? ` · ${d.after.guia}` : ''}
                            </td>
                            <td className="px-3 py-2">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${d.action === 'cancel_orphan' ? 'bg-destructive/15 text-destructive' : 'bg-warning/15 text-warning'}`}>
                                {d.action === 'cancel_orphan' ? 'CANCELAR' : 'ACTUALIZAR'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {filtered.length > 100 && (
                      <div className="px-3 py-2 text-[11px] text-muted-foreground text-center bg-secondary/50">
                        Mostrando primeras 100 de {filtered.length}. Aplicar procesa todas.
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {state === 'done' && (
            <div className="text-center py-10 space-y-3">
              <CheckCircle2 size={32} className="text-success mx-auto" />
              <p className="text-sm font-bold text-foreground">
                {applied} cambios aplicados{failed.length > 0 ? ` · ${failed.length} fallidos` : ''}
              </p>
              <p className="text-xs text-muted-foreground">Quedó registrado en el historial.</p>
              <button onClick={handleReset}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary text-foreground text-xs font-semibold hover:bg-secondary/80 cursor-pointer">
                <RefreshCw size={12} /> Escanear de nuevo
              </button>
            </div>
          )}
        </div>

        {(state === 'results' && divergences.length > 0) && (
          <footer className="px-5 py-3 border-t border-border flex items-center justify-between flex-shrink-0">
            <p className="text-[11px] text-muted-foreground flex items-center gap-1">
              <AlertTriangle size={11} /> Modifica solo Guardian — Dropi no se toca.
            </p>
            <button onClick={handleApply} disabled={filtered.length === 0}
              className="px-4 py-2 rounded-lg bg-warning text-warning-foreground text-xs font-bold hover:opacity-90 cursor-pointer disabled:opacity-50">
              Aplicar {filtered.length} cambios
            </button>
          </footer>
        )}
        {state === 'applying' && (
          <footer className="px-5 py-3 border-t border-border flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin text-accent" />
            <span className="text-xs text-muted-foreground">Aplicando…</span>
          </footer>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent, note }: { label: string; value: number; accent?: 'warning' | 'danger'; note?: string }) {
  const color = accent === 'danger' ? 'text-destructive' : accent === 'warning' ? 'text-warning' : 'text-foreground';
  return (
    <div className="rounded-2xl border border-border bg-card/40 px-3 py-2 shadow-card3d hairline-top">
      <div className="hud-label">{label}</div>
      <div className={`text-lg font-bold ${color}`}>{value}</div>
      {/* `note` califica el número (ej. "de 3400 · parcial") para que una muestra
          nunca se lea como si fuera el total. */}
      {note && (
        <div className={`text-[10px] font-medium leading-tight ${accent ? color : 'text-muted-foreground'}`}>{note}</div>
      )}
    </div>
  );
}
