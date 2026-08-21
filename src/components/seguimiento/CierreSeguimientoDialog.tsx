import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, Moon } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { decidirCierre, motivoSuficiente, MOTIVO_MIN_CHARS } from '@/lib/cierreSeguimiento';
import { cn } from '@/lib/utils';

/**
 * "Cerrar el día" de Seguimiento — el final que esta pantalla no tenía.
 *
 * `ClosingReportDialog` existe solo en `/confirmar`: el trabajo de Confirmar se
 * declara terminado y el de Seguimiento no se declaraba nunca, así que tampoco
 * se declaraba incompleto. La regla del dueño es "Seguimiento se deja en 0";
 * esto la vuelve verificable — **o queda en cero, o queda escrito el motivo**.
 *
 * NO es un candado: nadie queda bloqueado por no cerrar. Convertirlo en
 * requisito repetiría el error de `OpeningReportGate`, que bloqueaba la
 * pantalla entera y terminó desmontado.
 *
 * La decisión (si se puede cerrar, si hace falta motivo) vive en
 * `cierreSeguimiento.ts`, puro y testeado. Acá solo se dibuja y se escribe.
 */

interface Props {
  open: boolean;
  onClose: () => void;
  storeId: string | null;
  /** Tamaño de la cola accionable de hoy. */
  cola: number;
  /** Gestionados hoy. `null` = la lectura falló — ver el guardián. */
  gestionados: number | null;
}

/** Postgres: función inexistente → la migración todavía no corrió. */
function faltaLaMigracion(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === 'PGRST202' || err.code === '42883' || err.code === '42P01') return true;
  const m = (err.message || '').toLowerCase();
  return m.includes('does not exist') || m.includes('schema cache');
}

export default function CierreSeguimientoDialog({ open, onClose, storeId, cola, gestionados }: Props) {
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);

  const d = decidirCierre({ cola, gestionados });
  const motivoOk = motivoSuficiente(motivo, d.exigeMotivo);
  const puedeEnviar = d.puedeCerrar && motivoOk && !enviando && Boolean(storeId);

  const enviar = async () => {
    if (!puedeEnviar || !storeId) return;
    setEnviando(true);
    try {
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ error: { code?: string; message?: string } | null }>;
      const { error } = await rpc('cerrar_seguimiento', {
        p_store_id: storeId,
        p_cola: cola,
        p_gestionados: gestionados ?? 0,
        p_motivo: motivo.trim() || null,
      });
      if (error) {
        if (faltaLaMigracion(error)) {
          toast.error('El cierre todavía no está habilitado en la base. Avisale al dueño.');
        } else {
          toast.error(error.message || 'No se pudo guardar el cierre');
        }
        return;
      }
      toast.success(
        d.faltan === 0 ? 'Día cerrado — Seguimiento quedó en cero.' : 'Día cerrado, con lo pendiente anotado.',
      );
      setMotivo('');
      onClose();
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Moon size={16} aria-hidden="true" /> Cerrar el día de Seguimiento
          </DialogTitle>
          <DialogDescription>
            Queda registrado cómo terminó la cola de hoy.
          </DialogDescription>
        </DialogHeader>

        <div
          className={cn(
            'rounded-xl border p-3.5',
            d.tipo === 'en_cero' ? 'border-success/30 bg-success/8'
              : d.tipo === 'no_medible' ? 'border-border bg-card/40'
              : 'border-warning/30 bg-warning/8',
          )}
        >
          <p className={cn(
            'text-sm font-semibold',
            d.tipo === 'en_cero' ? 'text-success' : d.tipo === 'no_medible' ? 'text-muted-foreground' : 'text-warning',
          )}>
            {d.tipo === 'en_cero' && <CheckCircle2 size={14} className="inline mr-1.5 -mt-0.5" aria-hidden="true" />}
            {d.titulo}
          </p>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{d.detalle}</p>

          {d.tipo !== 'no_medible' && (
            <p className="text-[11px] font-mono tabular-nums text-muted-foreground mt-2.5">
              cola de hoy {cola} · gestionados {gestionados ?? '—'} · faltan {d.faltan ?? '—'}
            </p>
          )}
        </div>

        {d.exigeMotivo && (
          <div className="space-y-1.5">
            <label htmlFor="motivo-cierre" className="text-xs font-semibold">
              ¿Qué pasó con los {d.faltan} que quedaron?
            </label>
            <Textarea
              id="motivo-cierre"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              rows={3}
              placeholder="Ej: la transportadora no contesta desde ayer y quedé esperando respuesta de 6 novedades."
              className="text-sm"
            />
            {!motivoOk && motivo.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Escribí un poco más — al menos {MOTIVO_MIN_CHARS} caracteres. Mañana alguien
                tiene que poder retomar leyendo esto.
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={enviando}>
            Todavía no
          </Button>
          <Button onClick={enviar} disabled={!puedeEnviar}>
            {enviando && <Loader2 size={14} className="animate-spin mr-1.5" aria-hidden="true" />}
            Cerrar el día
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
