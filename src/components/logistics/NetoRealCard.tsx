import { useEffect, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  useLogisticaMonthlyCosts,
  useUpsertLogisticaMonthlyCosts,
} from '@/hooks/useLogisticaMonthlyCosts';

// Bloque "Neto Real" de "Cómo voy": resta pauta (Meta/TikTok) + costos admin al
// OPERATIVO del mes (hoy = ganancia neta del wallet — ver MesActualResumen, el
// comentario // OPERATIVO_BASE). Los inputs persisten por mes en
// logistica_monthly_costs vía RPC store-scoped. Si la tabla aún no está aplicada,
// el hook devuelve ceros y el bloque NO rompe — solo no recalcula con basura.

interface Props {
  /** Operativo del mes (base del neto). Hoy = ganancia neta wallet. */
  operativo: number;
  /** 'YYYY-MM' del mes mostrado. */
  yearMonth: string;
  /** Solo el dueño de la tienda edita/guarda los costos. */
  canEdit: boolean;
}

// COP son enteros — descartamos todo lo que no sea dígito o signo (acepta
// "1.000.000" tipeado con separadores de miles).
function parseInput(v: string): number {
  const n = Number(v.replace(/[^\d-]/g, ''));
  return isFinite(n) ? n : 0;
}

export default function NetoRealCard({ operativo, yearMonth, canEdit }: Props) {
  const { data: saved } = useLogisticaMonthlyCosts(yearMonth);
  const upsert = useUpsertLogisticaMonthlyCosts();

  // Estado local de los inputs, sembrado desde lo guardado. El neto recalcula en
  // vivo con estos valores; nunca con basura (arrancan en lo persistido o 0).
  const [pautaMeta, setPautaMeta] = useState(0);
  const [pautaTiktok, setPautaTiktok] = useState(0);
  const [costosAdmin, setCostosAdmin] = useState(0);

  // Re-sembrar cuando llega la fila guardada o cambia el mes.
  useEffect(() => {
    setPautaMeta(saved?.pauta_meta ?? 0);
    setPautaTiktok(saved?.pauta_tiktok ?? 0);
    setCostosAdmin(saved?.costos_admin ?? 0);
  }, [saved?.pauta_meta, saved?.pauta_tiktok, saved?.costos_admin, yearMonth]);

  const totalCostos = pautaMeta + pautaTiktok + costosAdmin;
  const neto = operativo - totalCostos;

  const dirty =
    pautaMeta !== (saved?.pauta_meta ?? 0) ||
    pautaTiktok !== (saved?.pauta_tiktok ?? 0) ||
    costosAdmin !== (saved?.costos_admin ?? 0);

  return (
    <div className="rounded-lg border border-border bg-card p-3.5 space-y-3">
      <div className="flex items-center gap-2">
        <TrendingUp size={13} className="text-accent" />
        <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
          Neto real del mes
        </span>
      </div>

      {canEdit ? (
        <div className="grid grid-cols-3 gap-2">
          <CostInput label="Pauta Meta" value={pautaMeta} onChange={setPautaMeta} />
          <CostInput label="Pauta TikTok" value={pautaTiktok} onChange={setPautaTiktok} />
          <CostInput label="Costos admin" value={costosAdmin} onChange={setCostosAdmin} />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <ReadOnly label="Pauta Meta" value={pautaMeta} />
          <ReadOnly label="Pauta TikTok" value={pautaTiktok} />
          <ReadOnly label="Costos admin" value={costosAdmin} />
        </div>
      )}

      {canEdit && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            disabled={!dirty || upsert.isPending}
            onClick={() =>
              upsert.mutate({
                yearMonth,
                pauta_meta: pautaMeta,
                pauta_tiktok: pautaTiktok,
                costos_admin: costosAdmin,
              })
            }
          >
            {upsert.isPending ? 'Guardando…' : dirty ? 'Guardar' : 'Guardado'}
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5">
        <span className="text-xs text-foreground font-medium">
          Neto real
          <span className="block text-[10px] text-muted-foreground/70">
            Operativo {formatCOP(operativo)} − costos {formatCOP(totalCostos)}
          </span>
        </span>
        <span className={`text-lg font-bold tabular-nums shrink-0 ${neto >= 0 ? 'text-green' : 'text-red'}`}>
          {formatCOP(neto)}
        </span>
      </div>

      <p className="text-[10px] text-muted-foreground">
        Realizado a hoy. Sube cuando se entreguen los pedidos en la calle. No incluye deudas personales.
      </p>
    </div>
  );
}

function CostInput({
  label, value, onChange,
}: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={value === 0 ? '' : String(value)}
        placeholder="0"
        onChange={(e) => onChange(parseInput(e.target.value))}
        className="w-full rounded border border-border bg-background px-2 py-1 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-accent"
      />
    </label>
  );
}

function ReadOnly({ label, value }: { label: string; value: number }) {
  return (
    <div className="space-y-1">
      <span className="block text-[10px] text-muted-foreground">{label}</span>
      <span className="block text-xs tabular-nums text-foreground">{formatCOP(value)}</span>
    </div>
  );
}
