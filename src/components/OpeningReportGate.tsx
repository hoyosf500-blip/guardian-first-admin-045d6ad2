import { ReactNode, useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Sunrise } from 'lucide-react';
import { toast } from 'sonner';

interface Props { children: ReactNode }

export default function OpeningReportGate({ children }: Props) {
  const { isAdmin, user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [hasOpening, setHasOpening] = useState(false);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    const { data, error } = await (supabase.rpc as unknown as (
      fn: string
    ) => Promise<{ data: { has_opening: boolean; has_closing: boolean }[] | null; error: unknown }>)('opening_report_status');
    if (!error && data && data[0]) setHasOpening(!!data[0].has_opening);
    setLoading(false);
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    const { error } = await (supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>
    ) => Promise<{ error: { message?: string } | null }>)('submit_opening_report', { p_notes: notes });
    setSubmitting(false);
    if (error) {
      toast.error(error.message || 'No se pudo registrar la apertura');
      return;
    }
    setHasOpening(true);
    toast.success('Turno iniciado');
  }, [notes]);

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

  return (
    <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-2xl p-6 shadow-2xl space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-accent/15 border border-accent/20 flex items-center justify-center">
            <Sunrise size={22} className="text-accent" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">Reporte de apertura</h2>
            <p className="text-xs text-muted-foreground">Necesario para iniciar tu turno</p>
          </div>
        </div>
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground font-medium">Notas (opcional)</label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="¿Algo que reportar antes de empezar?"
            rows={4}
            className="resize-none"
          />
        </div>
        <Button onClick={submit} disabled={submitting} className="w-full">
          {submitting ? <Loader2 className="animate-spin" size={16} /> : 'Iniciar turno'}
        </Button>
      </div>
    </div>
  );
}
