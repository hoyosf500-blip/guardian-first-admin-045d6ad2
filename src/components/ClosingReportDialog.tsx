import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Loader2, Moon, PhoneCall, PhoneOff, Package, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { confRateOficial, confRateBySample, CONF_TARGET_PCT } from '@/lib/confirmationRate';

interface Props { open: boolean; onClose: () => void }

interface PendingRow {
  phone: string;
  nombre: string;
  external_id: string;
  attempts: number;
}

interface TodayStats {
  confirmados: number;
  cancelados: number;
  noresp: number;
  total: number;
  tasa_conf: number;
  pending_tomorrow: number;
}

export default function ClosingReportDialog({ open, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [stats, setStats] = useState<TodayStats | null>(null);
  /** ¿Se pudo LEER el resumen del día? Ver el comentario de `load`. */
  const [statsError, setStatsError] = useState(false);
  /** ⛔ ¿Se pudo LEER la lista de pendientes? Mismo problema que `statsError`,
   *  en la otra mitad del diálogo: "no se pudo leer" y "no hay pendientes"
   *  compartían la misma rama y el mismo array vacío, así que la asesora leía
   *  «Resumen automático del día» sin ninguna advertencia y firmaba un cierre
   *  limpio sobre clientes con llamadas del día sin usar. La supervisora lo lee
   *  así en /admin → Reportes diarios. */
  const [pendingError, setPendingError] = useState(false);
  const [step, setStep] = useState(1);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [pendingRes, statsRes] = await Promise.all([
      (supabase.rpc as unknown as (fn: string) => Promise<{ data: PendingRow[] | null; error: unknown }>)('pending_retry_list'),
      (supabase.rpc as unknown as (fn: string) => Promise<{ data: TodayStats[] | null; error: unknown }>)('today_call_stats'),
    ]);
    if (!pendingRes.error && pendingRes.data) {
      setPending(pendingRes.data);
      setPendingError(false);
    } else {
      setPending([]);
      setPendingError(true);
    }
    // Fallar la lectura y no haber trabajado se veían IGUAL (auditoría
    // 4-ago-2026): con el error descartado, `stats` quedaba en null y la
    // pantalla imprimía `stats?.confirmados ?? 0` — o sea "Confirmados 0 ·
    // Total gestionados 0 · —% de confirmación" con toda la cara de dato
    // medido. La asesora cierra su turno leyendo que no hizo nada.
    // Ahora el error se distingue y la pantalla lo dice.
    if (statsRes.error || !statsRes.data || !statsRes.data[0]) {
      setStats(null);
      setStatsError(true);
    } else {
      const s = statsRes.data[0];
      setStatsError(false);
      setStats({
        confirmados: Number(s.confirmados) || 0,
        cancelados: Number(s.cancelados) || 0,
        noresp: Number(s.noresp) || 0,
        total: Number(s.total) || 0,
        tasa_conf: Number(s.tasa_conf) || 0,
        pending_tomorrow: Number(s.pending_tomorrow) || 0,
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) {
      setStep(1);
      setNotes('');
      void load();
    }
  }, [open, load]);

  const submit = useCallback(async (force = false) => {
    setSubmitting(true);
    const { error } = await (supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>
    ) => Promise<{ error: { message?: string; details?: string; hint?: string; code?: string } | null }>)('submit_closing_report', {
      p_notes: notes,
      p_force: force,
    });
    setSubmitting(false);
    if (error) {
      console.error('[ClosingReport] submit failed', { force, error });
      const msg = error.message || error.details || error.hint || 'No se pudo cerrar el turno';
      toast.error(msg);
      if (!force) void load();
      return;
    }
    toast.success(force ? 'Turno cerrado (con pendientes)' : 'Turno cerrado');
    onClose();
  }, [notes, load, onClose]);

  // 2026-05-28: el cierre NO bloquea por pendientes. La lista de "no llamados"
  // aparece como ADVERTENCIA dentro del flow normal y el submit se manda con
  // `p_force=true` cuando hay pendientes, para que el reporte de cierre quede
  // registrado server-side como "cerrado con N pendientes". La supervisora ve
  // el detalle en /admin → reportes diarios. Antes había un gate hard + una
  // exception window con fecha fija — ambos eliminados.
  const hasPending = pending.length > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Moon size={18} className="text-accent" />
            Cerrar turno {!loading && <span className="text-xs text-muted-foreground font-normal">— paso {step} de 2</span>}
          </DialogTitle>
          <DialogDescription>
            {pendingError
              ? 'No se pudo verificar si te quedaron llamadas pendientes. Cerrá igual — el cierre queda marcado como no verificado.'
              : hasPending
                ? `Tenés ${pending.length} cliente${pending.length > 1 ? 's' : ''} sin llamar. Podés cerrar igual, pero quedará registrado.`
                : 'Resumen automático del día. Solo agrega notas si lo necesitas.'}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="animate-spin text-accent" /></div>
        ) : (
          <div className="space-y-4">
            {step === 1 && (
              <div className="space-y-3">
                {/* Advertencia (NO bloqueo) si quedaron pendientes. La lista
                    muestra hasta 3 in-line + un "ver más" si hay más; el
                    submit del step 2 detecta hasPending y pasa p_force=true
                    para que el cierre quede etiquetado server-side. */}
                {/* Tono NEUTRO, no amarillo: no sabemos si quedaron pendientes,
                    no sabemos que los haya. Es lo mismo que ya hace `statsError`
                    justo abajo. */}
                {pendingError && (
                  <div className="rounded-lg border border-border bg-card/40 p-3">
                    <div className="flex items-start gap-2">
                      <AlertTriangle size={16} className="text-muted-foreground mt-0.5 flex-shrink-0" />
                      <div className="text-xs text-muted-foreground flex-1">
                        <div className="font-semibold text-foreground mb-0.5">No se pudo revisar tus llamadas pendientes</div>
                        <div>
                          No sabemos si te quedaron clientes sin llamar — esto no significa que no queden.
                          Cerrá igual: el cierre va marcado como no verificado.
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                {hasPending && (
                  <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 space-y-2">
                    <div className="flex items-start gap-2">
                      <AlertTriangle size={16} className="text-warning mt-0.5 flex-shrink-0" />
                      <div className="text-xs text-warning flex-1">
                        <div className="font-semibold mb-0.5">
                          Faltaron {pending.length} llamada{pending.length > 1 ? 's' : ''} pendiente{pending.length > 1 ? 's' : ''}
                        </div>
                        <div className="opacity-80">Podés cerrar igual — quedará registrado en el reporte.</div>
                      </div>
                    </div>
                    <div className="max-h-40 overflow-y-auto space-y-1">
                      {pending.map((p) => (
                        <div key={p.phone} className="flex items-center justify-between bg-surface/60 border border-warning/20 rounded px-2.5 py-1.5 text-[11px]">
                          <div className="min-w-0">
                            <div className="font-medium text-foreground truncate">{p.nombre}</div>
                            <div className="text-muted-foreground font-mono">{p.phone}</div>
                          </div>
                          <span className="font-mono text-warning ml-2 shrink-0">{p.attempts}/3</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {statsError ? (
                  <div
                    role="alert"
                    className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
                  >
                    No se pudo leer tu resumen del día. Los números de abajo están en cero
                    porque <strong>no se pudieron consultar</strong>, no porque no hayas
                    trabajado. Cerrá el turno igual —tu gestión ya quedó guardada— y avisá.
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Todos estos números los calcula el sistema automáticamente — no se editan.
                  </p>
                )}
                <div className="grid grid-cols-3 gap-2">
                  <StatCard
                    icon={<CheckCircle2 size={14} className="text-green" />}
                    label="Confirmados"
                    value={stats?.confirmados ?? 0}
                    tone="green"
                  />
                  <StatCard
                    icon={<XCircle size={14} className="text-red" />}
                    label="Cancelados"
                    value={stats?.cancelados ?? 0}
                    tone="red"
                  />
                  <StatCard
                    icon={<PhoneOff size={14} className="text-orange" />}
                    label="No respondió"
                    value={stats?.noresp ?? 0}
                    tone="orange"
                  />
                </div>
                {/* MATEMÁTICA OFICIAL (decisión del dueño 30-jul): el cierre
                    LIDERA con la Confirmación del día = conf ÷ GESTIONADOS
                    (conf+canc+noresp), meta 85% — la misma de todo el CRM. El
                    conf÷contestaron (~99%) queda como dato secundario rotulado
                    "cierre de llamada": mostrarlo como "% confirmación" fue la
                    causa de la disputa del "Tasa: 99%". */}
                {(() => {
                  const conf = stats?.confirmados ?? 0;
                  const canc = stats?.cancelados ?? 0;
                  const noresp = stats?.noresp ?? 0;
                  const atendidos = stats?.total ?? 0;
                  const oficial = confRateOficial(conf, canc, noresp).tasa;
                  const cierreLlamada = confRateBySample(conf, canc).tasa;
                  return (
                    <div className="flex items-center justify-between bg-surface border border-border rounded-lg px-3 py-2 text-xs">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <PhoneCall size={12} /> Total gestionados
                      </div>
                      <div className="flex items-center gap-3 font-mono font-semibold text-foreground">
                        <span>{atendidos}</span>
                        <span
                          title={`Confirmación del día: ${conf} confirmados ÷ ${conf + canc + noresp} gestionados (incluye los "no contestó"). Meta ${CONF_TARGET_PCT}%. Es la MISMA tasa del Dashboard y Productividad.`}
                        >
                          {oficial == null ? '—' : `${oficial}%`}
                          <span className="text-muted-foreground font-normal"> confirmación del día</span>
                        </span>
                        <span
                          className="text-muted-foreground font-normal"
                          title="Cierre de llamada: de los que CONTESTARON, cuántos confirmaron. Suele ser alto — no es la confirmación del día."
                        >
                          · {cierreLlamada == null ? '—' : `${cierreLlamada}%`} cierre de llamada
                        </span>
                      </div>
                    </div>
                  );
                })()}
                <div className="flex items-center justify-between bg-accent/10 border border-accent/30 rounded-lg px-3 py-2 text-xs">
                  <div className="flex items-center gap-2 text-accent">
                    <Package size={12} /> Pendientes para mañana
                  </div>
                  <div className="font-mono font-bold text-accent">
                    {stats?.pending_tomorrow ?? 0}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={onClose} className="flex-1">Cancelar</Button>
                  <Button onClick={() => setStep(2)} className="flex-1">
                    Siguiente <ArrowRight size={14} />
                  </Button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-3">
                <label className="text-xs font-medium text-foreground">Notas de cierre (opcional)</label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="¿Algo que reportar al cerrar el turno?"
                  rows={4}
                  className="resize-none"
                  autoFocus
                />
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setStep(1)} className="flex-1">
                    <ArrowLeft size={14} /> Atrás
                  </Button>
                  {/* `force = hasPending`: si quedaron llamadas sin hacer, el
                      RPC recibe p_force=true y registra el cierre con la marca
                      "cerrado con N pendientes" — el bloqueo server-side se
                      mantiene activo para auditoría pero ya no impide cerrar. */}
                  {/* `pendingError` fuerza igual que `hasPending`: un cierre
                      que no se pudo verificar NO puede quedar registrado como
                      limpio. */}
                  <Button onClick={() => submit(hasPending || pendingError)} disabled={submitting} className="flex-1">
                    {submitting ? <Loader2 className="animate-spin" size={16} /> : hasPending ? 'Cerrar con pendientes' : pendingError ? 'Cerrar sin verificar' : 'Enviar cierre'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatCard({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone: 'green' | 'red' | 'orange' }) {
  const toneCls = tone === 'green' ? 'text-green' : tone === 'red' ? 'text-red' : 'text-orange';
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5 flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={`text-2xl font-bold font-mono ${toneCls}`}>{value}</div>
    </div>
  );
}
