import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AlertTriangle, Loader2, Moon } from 'lucide-react';
import { toast } from 'sonner';

interface Props { open: boolean; onClose: () => void }

interface PendingRow {
  phone: string;
  nombre: string;
  external_id: string;
  attempts: number;
}

export default function ClosingReportDialog({ open, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await (supabase.rpc as unknown as (
      fn: string
    ) => Promise<{ data: PendingRow[] | null; error: unknown }>)('pending_retry_list');
    if (!error && data) setPending(data);
    setLoading(false);
  }, []);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    const { error } = await (supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>
    ) => Promise<{ error: { message?: string } | null }>)('submit_closing_report', { p_notes: notes });
    setSubmitting(false);
    if (error) {
      toast.error(error.message || 'No se pudo cerrar el turno');
      void load();
      return;
    }
    toast.success('Turno cerrado');
    onClose();
  }, [notes, load, onClose]);

  const blocked = pending.length > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Moon size={18} className="text-accent" />
            Cerrar turno
          </DialogTitle>
          <DialogDescription>
            Resumen del día. Antes de cerrar, completa los reintentos pendientes.
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
            <Button variant="outline" onClick={onClose} className="w-full">Volver</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground font-medium">Notas de cierre (opcional)</label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="¿Algo que reportar al cerrar el turno?"
                rows={4}
                className="resize-none"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose} className="flex-1">Cancelar</Button>
              <Button onClick={submit} disabled={submitting} className="flex-1">
                {submitting ? <Loader2 className="animate-spin" size={16} /> : 'Cerrar turno'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
