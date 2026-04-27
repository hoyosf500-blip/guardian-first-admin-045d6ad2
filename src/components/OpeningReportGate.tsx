import { ReactNode, useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Package, Tag, ClipboardList, StickyNote, ArrowLeft, ArrowRight, Send } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';

interface Props { children: ReactNode }

type RpcStatus = (
  fn: 'opening_report_status'
) => Promise<{ data: { has_opening: boolean; has_closing: boolean }[] | null; error: unknown }>;

type RpcSubmit = (
  fn: 'submit_opening_report',
  args: { p_new_orders: number; p_guides_yesterday: number; p_pending_yesterday: number; p_notes: string }
) => Promise<{ error: { message?: string } | null }>;

const isValidInt = (v: string) => /^\d+$/.test(v.trim());

export default function OpeningReportGate({ children }: Props) {
  const { isAdmin, user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [hasOpening, setHasOpening] = useState(false);
  const [step, setStep] = useState(0);
  const [newOrders, setNewOrders] = useState('');
  const [guidesYesterday, setGuidesYesterday] = useState('');
  const [pendingYesterday, setPendingYesterday] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    const { data, error } = await (supabase.rpc as unknown as RpcStatus)('opening_report_status');
    if (!error && data && data[0]) setHasOpening(!!data[0].has_opening);
    setLoading(false);
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    const { error } = await (supabase.rpc as unknown as RpcSubmit)('submit_opening_report', {
      p_new_orders: parseInt(newOrders, 10),
      p_guides_yesterday: parseInt(guidesYesterday, 10),
      p_pending_yesterday: parseInt(pendingYesterday, 10),
      p_notes: notes,
    });
    setSubmitting(false);
    if (error) {
      toast.error(error.message || 'No se pudo registrar la apertura');
      return;
    }
    setHasOpening(true);
    toast.success('Turno iniciado');
  }, [newOrders, guidesYesterday, pendingYesterday, notes]);

  if (isAdmin) return <>{children}</>;

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <Loader2 className="animate-spin text-accent" />
        <p className="text-xs text-muted-foreground">Verificando reporte de apertura…</p>
      </div>
    );
  }

  if (hasOpening) return <>{children}</>;

  const steps: { icon: LucideIcon; q: string; value: string; set: (v: string) => void }[] = [
    { icon: Package, q: '¿Cuántos pedidos nuevos hoy en Shopify?', value: newOrders, set: setNewOrders },
    { icon: Tag, q: '¿Cuántas guías generadas de ayer?', value: guidesYesterday, set: setGuidesYesterday },
    { icon: ClipboardList, q: '¿Cuántos pendientes de ayer?', value: pendingYesterday, set: setPendingYesterday },
  ];

  const isLastNumeric = step === 2;
  const onNotesStep = step === 3;
  const currentValid = onNotesStep ? true : isValidInt(steps[step].value);
  const StepIcon = onNotesStep ? StickyNote : steps[step].icon;
  const heading = onNotesStep ? 'Notas (opcional)' : steps[step].q;

  return (
    <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-2xl p-6 shadow-2xl space-y-5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold inline-flex items-center gap-1.5 text-foreground">
            <ClipboardList size={14} /> Reporte de Apertura
          </span>
          <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-accent/15 text-accent">
            Pendiente · {Math.min(step + 1, 4)}/4
          </span>
        </div>

        <div className="text-center py-4">
          <StepIcon size={42} className="mx-auto mb-3 text-muted-foreground" />
          <div className="text-base font-semibold mb-5 text-foreground">{heading}</div>

          {onNotesStep ? (
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="¿Algo que reportar antes de empezar?"
              rows={4}
              className="resize-none"
            />
          ) : (
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={steps[step].value}
              onChange={(e) => steps[step].set(e.target.value.replace(/[^\d]/g, ''))}
              placeholder="0"
              className="w-[140px] mx-auto h-14 text-3xl font-mono font-bold text-center"
            />
          )}
        </div>

        <div className="flex gap-2">
          {step > 0 && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setStep(step - 1)}
              disabled={submitting}
              className="flex-1"
            >
              <ArrowLeft size={14} /> Atrás
            </Button>
          )}
          {onNotesStep ? (
            <Button onClick={submit} disabled={submitting} className="flex-[2]">
              {submitting ? <Loader2 className="animate-spin" size={16} /> : (<><Send size={14} /> Enviar Apertura</>)}
            </Button>
          ) : (
            <Button
              onClick={() => setStep(step + 1)}
              disabled={!currentValid}
              className="flex-[2]"
            >
              {isLastNumeric ? 'Continuar' : 'Siguiente'} <ArrowRight size={14} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
