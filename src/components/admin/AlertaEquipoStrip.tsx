import { AlertTriangle } from 'lucide-react';
import type { AdvisorVM } from '@/lib/advisorCardVM';

/**
 * Lo que hay que mirar HOY del equipo, en una sola franja.
 *
 * ── Por qué existe (3-sep-2026) ─────────────────────────────────────────────
 * El dueño dijo *"las alertas de inactividad no las he vuelto a ver"*. La
 * auditoría encontró por qué, y no era que no existieran:
 *
 *  · **A él no le salen, por diseño.** El modal de inactividad exige
 *    `seLeBloqueaLaPantalla` y el aviso suave exige `trabajaLaCola`
 *    (`rolesTrabajo.ts`): siendo dueño, ninguno de los dos le aparece nunca. Si
 *    esperaba verlas en su propia pantalla, no las iba a ver jamás.
 *  · **El único número que le llegaba estaba COLAPSADO** dentro de "Ver detalle"
 *    de cada tarjeta (`AdvisorCard`), una por una, entre otros veinte datos.
 *
 * Esta franja no calcula nada nuevo: saca a la superficie lo que `advisorCardVM`
 * ya venía computando y nadie miraba — `motivos` ("entró 32 min tarde", "sin
 * marcar hace 40 min", "presente pero sin marcar") y `detalle.avisos`.
 *
 * El *"trabajan un par de horas y no vuelven"* que él describe es exactamente el
 * **"sin marcar hace 2 h 40"**.
 *
 * ⛔ **Si no hay nada, no dibuja nada.** Una franja siempre presente se vuelve
 * parte del fondo y dejaría de leerse justo el día que dice algo. Y ⛔ **solo
 * habla del día de hoy**: en un rango de 7 o 30 días "sin marcar hace 40 min" no
 * significa nada.
 */
export default function AlertaEquipoStrip({ vms, isToday }: {
  vms: AdvisorVM[];
  /** El rango seleccionado es HOY. En rangos largos la franja no sale. */
  isToday: boolean;
}) {
  if (!isToday) return null;

  const filas = vms
    .map((vm) => {
      const partes = [...vm.motivos];
      const avisos = vm.detalle?.avisos ?? 0;
      if (avisos > 0) {
        const min = vm.detalle?.avisosMin ?? 0;
        partes.unshift(
          `${avisos} aviso${avisos === 1 ? '' : 's'} sin trabajar${min > 0 ? ` (${min} min)` : ''}`,
        );
      }
      return { id: vm.operatorId, name: vm.name, partes };
    })
    .filter((f) => f.partes.length > 0);

  if (filas.length === 0) return null;

  return (
    <div
      className="mb-4 rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3"
      role="status"
    >
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle size={14} className="text-warning shrink-0" aria-hidden="true" />
        <span className="text-[11px] font-bold uppercase tracking-wide text-warning">
          Hoy hay que mirar esto
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {filas.map((f) => (
          <div key={f.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs min-w-0">
            <span className="font-bold text-foreground">{f.name}</span>
            <span className="text-warning">{f.partes.join(' · ')}</span>
          </div>
        ))}
      </div>
      {/* ⛔ El límite, dicho. Los avisos solo existen si la asesora tenía el CRM
          abierto: nada corre del lado del servidor. Sin esta línea, una franja
          vacía se leería como "todos trabajando", que es justo la buena noticia
          falsa que este proyecto ya pagó. */}
      <p className="text-[10px] text-muted-foreground mt-2 leading-snug">
        Esto se mide solo mientras tienen el CRM abierto. Que alguien no aparezca acá no
        prueba que estuvo trabajando — puede no haber entrado.
      </p>
    </div>
  );
}
