import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Loader2, Moon, PhoneCall, PhoneOff, Package, XCircle } from 'lucide-react';
import { toast } from 'sonner';

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
  const [step, setStep] = useState(1);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [pendingRes, statsRes] = await Promise.all([
      (supabase.rpc as unknown as (fn: string) => Promise<{ data: PendingRow[] | null; error: unknown }>)('pending_retry_list'),
      (supabase.rpc as unknown as (fn: string) => Promise<{ data: TodayStats[] | null; error: unknown }>)('today_call_stats'),
    ]);
    if (!pendingRes.error && pendingRes.data) setPending(pendingRes.data);
    if (!statsRes.error && statsRes.data && statsRes.data[0]) {
      const s = statsRes.data[0];
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

  // Excepción pedida 2026-05-27 (operadora EC, tarde para cerrar).
  // El botón "Cerrar de todas maneras" expira automáticamente al día siguiente.
  // Se usa un timestamp absoluto (no comparación de strings de fecha) para evitar
  // problemas de huso horario entre el reloj del cliente y Bogotá.
  const FORCE_CLOSE_EXPIRES_AT = new Date('2026-05-28T05:00:00-05:00').getTime();
  const forceCloseAllowed = Date.now() < FORCE_CLOSE_EXPIRES_AT;

  const blocked = pending.length > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Moon size={18} className="text-accent" />
            Cerrar turno {!blocked && !loading && <span className="text-xs text-muted-foreground font-normal">— paso {step} de 2</span>}
          </DialogTitle>
          <DialogDescription>
            {blocked
              ? 'Antes de cerrar, completa los reintentos pendientes.'
              : 'Resumen automático del día. Solo agrega notas si lo necesitas.'}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="animate-spin text-accent" /></div>
        ) : blocked ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/30 p-3">
              <AlertTriangle size={16} className="text-destructive mt-0.5 flex-shrink-0" />
              <div className="text-xs text-destructive">
                No puedes cerrar — faltan {pending.length} cliente{pending.length > 1 ? 's' : ''} con llamadas pendientes.
              </div>
            </div>
            <div className="max-h-64 overflow-y-auto space-y-1.5">
              {pending.map((p) => (
                <div key={p.phone} className="flex items-center justify-between bg-surface border border-border rounded-lg px-3 py-2 text-xs">
                  <div>
                    <div className="font-medium text-foreground">{p.nombre}</div>
                    <div className="text-muted-foreground">{p.phone}</div>
                  </div>
                  <span className="font-mono text-muted-foreground">{p.attempts}/3</span>
                </div>
              ))}
            </div>
            {forceCloseAllowed && (
              <div className="rounded-lg border border-orange/40 bg-orange/10 p-3 space-y-2">
                <div className="text-xs text-orange">
                  Excepción de hoy: podés cerrar de todas maneras. Mañana este botón ya no estará disponible — completá los reintentos antes del cierre.
                </div>
                <Button
                  variant="outline"
                  className="w-full border-orange/60 text-orange hover:bg-orange/20"
                  disabled={submitting}
                  onClick={() => submit(true)}
                >
                  {submitting ? <Loader2 className="animate-spin" size={16} /> : 'Cerrar de todas maneras (solo hoy)'}
                </Button>
              </div>
            )}
            <Button variant="outline" onClick={onClose} className="w-full">Volver</Button>
          </div>
        ) : (
          <div className="space-y-4">
            {step === 1 && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Todos estos números los calcula el sistema automáticamente — no se editan.
                </p>
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
                <div className="flex items-center justify-between bg-surface border border-border rounded-lg px-3 py-2 text-xs">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <PhoneCall size={12} /> Total gestionados
                  </div>
                  <div
                    className="font-mono font-semibold text-foreground"
                    title="Tasa personal: confirmados / lo gestionado por vos. NO incluye pedidos del inflow del día que no tocaste."
                  >
                    {stats?.total ?? 0} <span className="text-muted-foreground font-normal">· {stats?.tasa_conf ?? 0}% personal</span>
                  </div>
                </div>
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
                  <Button onClick={() => submit(false)} disabled={submitting} className="flex-1">
                    {submitting ? <Loader2 className="animate-spin" size={16} /> : 'Enviar cierre'}
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
