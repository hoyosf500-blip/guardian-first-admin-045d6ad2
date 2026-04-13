import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { CheckCircle2, Package, Tag, ClipboardList, ArrowLeft, ArrowRight, Send } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface Props {
  onComplete: () => void;
}

export default function AperturaWizard({ onComplete }: Props) {
  const { user } = useAuth();
  const [step, setStep] = useState(0);
  const [nuevos, setNuevos] = useState('');
  const [guias, setGuias] = useState('');
  const [pendientes, setPendientes] = useState('');
  const [sent, setSent] = useState(false);

  const enviar = async () => {
    if (!user) return;
    const today = new Date().toISOString().split('T')[0];
    const { error } = await supabase.from('daily_reports').insert({
      operator_id: user.id,
      report_date: today,
      report_type: 'apertura',
      data: { nuevos: parseInt(nuevos) || 0, guias: parseInt(guias) || 0, pendientes: parseInt(pendientes) || 0 }
    });
    if (error) {
      if (error.code === '23505') { toast.info('Apertura ya enviada hoy'); setSent(true); setStep(3); onComplete(); return; }
      toast.error('Error enviando apertura');
    } else {
      toast.success('Apertura enviada');
      setSent(true);
      setStep(3);
      onComplete();
    }
  };

  if (sent) {
    return (
      <div className="bg-card border border-border rounded-lg p-4 mb-4 border-l-[3px] border-l-cyan">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-bold inline-flex items-center gap-1.5"><ClipboardList size={14} /> Reporte de Apertura</span>
          <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-green/10 text-green inline-flex items-center gap-1">
            <CheckCircle2 size={10} /> Enviada
          </span>
        </div>
        <div className="text-center py-4">
          <CheckCircle2 size={48} className="mx-auto mb-3 text-green" />
          <p className="text-base font-semibold">¡Apertura enviada!</p>
          <p className="text-sm text-muted-foreground mt-2">Ahora sube el Excel de Dropi para empezar</p>
        </div>
      </div>
    );
  }

  const steps: { icon: LucideIcon; q: string; value: string; set: (v: string) => void }[] = [
    { icon: Package, q: '¿Cuántos pedidos nuevos hoy?', value: nuevos, set: setNuevos },
    { icon: Tag, q: '¿Cuántas guías generadas?', value: guias, set: setGuias },
    { icon: ClipboardList, q: '¿Cuántos pendientes de ayer?', value: pendientes, set: setPendientes },
  ];

  const StepIcon = steps[step].icon;

  return (
    <div className="bg-card border border-border rounded-lg p-4 mb-4 border-l-[3px] border-l-cyan">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-bold inline-flex items-center gap-1.5"><ClipboardList size={14} /> Reporte de Apertura</span>
        <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-blue/10 text-blue">Pendiente</span>
      </div>
      {step < 3 && (
        <div className="text-center py-5">
          <StepIcon size={48} className="mx-auto mb-3 text-muted-foreground" />
          <div className="text-base font-semibold mb-5">{steps[step].q}</div>
          <input
            type="number"
            inputMode="numeric"
            value={steps[step].value}
            onChange={e => steps[step].set(e.target.value)}
            placeholder="0"
            className="w-[120px] p-4 text-3xl font-mono font-bold text-center bg-card border-2 border-input rounded-lg text-foreground"
          />
          <div className="flex gap-2 mt-4 justify-center">
            {step > 0 && (
              <button onClick={() => setStep(step - 1)} className="flex-1 max-w-[140px] py-3 rounded-lg bg-muted text-muted-foreground font-semibold text-sm inline-flex items-center justify-center gap-1.5">
                <ArrowLeft size={14} /> Atrás
              </button>
            )}
            {step < 2 ? (
              <button onClick={() => setStep(step + 1)} className="flex-[2] max-w-[200px] py-3 rounded-lg bg-gradient-to-r from-cyan to-blue font-semibold text-primary-foreground text-sm inline-flex items-center justify-center gap-1.5">
                Siguiente <ArrowRight size={14} />
              </button>
            ) : (
              <button onClick={enviar} className="flex-[2] max-w-[200px] py-3 rounded-lg bg-green/15 text-green border border-green/25 font-bold text-sm inline-flex items-center justify-center gap-1.5">
                <Send size={14} /> Enviar Apertura
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
