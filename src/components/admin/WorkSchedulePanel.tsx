import { useEffect, useState } from 'react';
import { Clock, Save, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useActiveStoreId } from '@/contexts/StoreContext';
import {
  useStoreSchedule,
  useUpdateStoreSchedule,
  DEFAULT_SCHEDULE_MINUTES,
  type StoreScheduleMinutes,
} from '@/hooks/useStoreSchedule';

/** minutos-del-día → "HH:MM" para <input type="time">. */
function toHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
/** "HH:MM" → minutos-del-día. Tolera vacío/malformado → 0. */
function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
  if (!Number.isFinite(h)) return 0;
  return h * 60 + (Number.isFinite(m) ? m : 0);
}

/**
 * Panel para configurar el HORARIO LABORAL de la tienda activa. Ese horario es
 * contra el que se miden las advertencias de inactividad y el "tiempo laboral
 * perdido" (antes fijo 9–17, que inflaba el número de operadoras que trabajan
 * de noche). Manager-only (la RPC valida membresía server-side igual).
 */
export default function WorkSchedulePanel() {
  const storeId = useActiveStoreId();
  const { data, isLoading } = useStoreSchedule(storeId);
  const update = useUpdateStoreSchedule();

  const [form, setForm] = useState<StoreScheduleMinutes>(DEFAULT_SCHEDULE_MINUTES);

  // Sincroniza el form cuando llega/cambia el dato del server.
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const set = (k: keyof StoreScheduleMinutes) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: toMin(e.target.value) }));

  const dirty = !!data && (
    form.work_start_min !== data.work_start_min ||
    form.work_end_min !== data.work_end_min ||
    form.lunch_start_min !== data.lunch_start_min ||
    form.lunch_end_min !== data.lunch_end_min
  );

  const invalidWork = form.work_start_min >= form.work_end_min;
  const invalidLunch = form.lunch_start_min > form.lunch_end_min;

  const onSave = async () => {
    if (!storeId) return;
    if (invalidWork) { toast.error('El inicio de la jornada debe ser antes del fin.'); return; }
    if (invalidLunch) { toast.error('El inicio del almuerzo debe ser antes del fin.'); return; }
    try {
      await update.mutateAsync({ storeId, ...form });
      toast.success('Horario guardado.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo guardar el horario.');
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-1">
        <Clock size={16} className="text-accent" aria-hidden="true" />
        <h3 className="text-sm font-bold text-foreground">Horario laboral de la tienda</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Contra este horario se miden las advertencias de inactividad y el tiempo laboral perdido.
        Poné el turno real de tus operadoras (ej. si trabajan de noche). Zona horaria Bogotá.
      </p>

      {isLoading ? (
        <div className="h-24 rounded-lg skeleton-shimmer" />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground mb-1.5">Jornada</div>
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  aria-label="Inicio de jornada"
                  value={toHHMM(form.work_start_min)}
                  onChange={set('work_start_min')}
                  className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm font-mono tabular-nums focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                />
                <span className="text-muted-foreground text-xs">a</span>
                <input
                  type="time"
                  aria-label="Fin de jornada"
                  value={toHHMM(form.work_end_min)}
                  onChange={set('work_end_min')}
                  className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm font-mono tabular-nums focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                />
              </div>
              {invalidWork && <p className="text-[11px] text-danger mt-1">El inicio debe ser antes del fin.</p>}
            </div>

            <div>
              <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground mb-1.5">Almuerzo (excluido)</div>
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  aria-label="Inicio de almuerzo"
                  value={toHHMM(form.lunch_start_min)}
                  onChange={set('lunch_start_min')}
                  className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm font-mono tabular-nums focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                />
                <span className="text-muted-foreground text-xs">a</span>
                <input
                  type="time"
                  aria-label="Fin de almuerzo"
                  value={toHHMM(form.lunch_end_min)}
                  onChange={set('lunch_end_min')}
                  className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm font-mono tabular-nums focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                />
              </div>
              {invalidLunch && <p className="text-[11px] text-danger mt-1">El inicio debe ser antes del fin.</p>}
              <p className="text-[11px] text-muted-foreground mt-1">Poné inicio = fin para no excluir almuerzo.</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button
              type="button"
              size="sm"
              onClick={onSave}
              disabled={!dirty || invalidWork || invalidLunch || update.isPending || !storeId}
            >
              {update.isPending ? <Loader2 size={14} className="animate-spin mr-1.5" /> : <Save size={14} className="mr-1.5" />}
              Guardar horario
            </Button>
            {dirty && !update.isPending && <span className="text-xs text-muted-foreground">Cambios sin guardar</span>}
          </div>
        </div>
      )}
    </div>
  );
}
