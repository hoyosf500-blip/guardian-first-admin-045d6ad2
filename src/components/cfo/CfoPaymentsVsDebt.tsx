import { useMemo, useState } from 'react';
import {
  Receipt, ArrowDownRight, ArrowUpRight, AlertTriangle, Loader2,
  CreditCard,
} from 'lucide-react';
import {
  usePersonalPaymentsSummary, usePersonalResidualDebt,
} from '@/hooks/usePersonalCardMovements';
import { formatCOP } from '@/lib/utils';

// "Pagado vs Pendiente" — vista cash-flow del bloque de tarjetas
// personales en /cfo. Muestra mes a mes:
//   compras nuevas - pagos = Δ deuda
// Y abajo, el snapshot actual de deuda residual por (tarjeta, moneda).
//
// La TRM es editable porque cambia día a día — afecta solo la conversión
// USD→COP en pantalla, no toca los datos.

interface MonthRow {
  year_month: string;
  compras_total_cop: number;     // todo lo que SUMASTE a la deuda este mes
  pagos_total_cop: number;       // todo lo que RESTASTE a la deuda
  delta: number;                 // compras_total - pagos_total
  saldo_acumulado: number;       // running balance
}

function fmtMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
}

export default function CfoPaymentsVsDebt() {
  const [trm, setTrm] = useState<number>(3800);

  const summaryQuery = usePersonalPaymentsSummary();
  const residualQuery = usePersonalResidualDebt();

  // Pivot ascendente para calcular running balance, después invierto
  const rows: MonthRow[] = useMemo(() => {
    const data = (summaryQuery.data ?? []).slice().sort((a, b) => a.year_month.localeCompare(b.year_month));
    const out: MonthRow[] = [];
    let running = 0;
    for (const r of data) {
      const compras_total =
        r.compras_cop + r.compras_usd * trm
        + r.avances_cop + r.avances_usd * trm
        + r.intereses_cop + r.intereses_usd * trm
        + r.comisiones_cop;
      const pagos_total = r.pagos_cop + r.pagos_usd * trm;
      const delta = compras_total - pagos_total;
      running += delta;
      out.push({
        year_month: r.year_month,
        compras_total_cop: compras_total,
        pagos_total_cop: pagos_total,
        delta,
        saldo_acumulado: running,
      });
    }
    return out.reverse();
  }, [summaryQuery.data, trm]);

  const totales = useMemo(() => {
    const data = summaryQuery.data ?? [];
    return {
      compras_cop:    data.reduce((acc, r) => acc + r.compras_cop, 0),
      compras_usd:    data.reduce((acc, r) => acc + r.compras_usd, 0),
      pagos_cop:      data.reduce((acc, r) => acc + r.pagos_cop, 0),
      pagos_usd:      data.reduce((acc, r) => acc + r.pagos_usd, 0),
      intereses_cop:  data.reduce((acc, r) => acc + r.intereses_cop, 0),
      intereses_usd:  data.reduce((acc, r) => acc + r.intereses_usd, 0),
      avances_cop:    data.reduce((acc, r) => acc + r.avances_cop, 0),
      comisiones_cop: data.reduce((acc, r) => acc + r.comisiones_cop, 0),
    };
  }, [summaryQuery.data]);

  const residualByCard = residualQuery.data ?? [];
  const residual_total_cop = residualByCard.reduce(
    (acc, r) => acc + (r.moneda === 'USD' ? r.saldo_pendiente * trm : r.saldo_pendiente),
    0,
  );

  const total_pagado_cop = totales.pagos_cop + totales.pagos_usd * trm;
  const total_cargado_cop =
    totales.compras_cop + totales.compras_usd * trm
    + totales.avances_cop + totales.intereses_cop + totales.intereses_usd * trm
    + totales.comisiones_cop;

  if (summaryQuery.isLoading || residualQuery.isLoading) {
    return (
      <div className="rounded-2xl border border-border bg-card/40 shadow-card3d p-6 flex items-center justify-center gap-2 text-muted-foreground">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-sm">Cargando flujo de pagos…</span>
      </div>
    );
  }

  if ((summaryQuery.data ?? []).length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card/40 p-8 text-center text-sm text-muted-foreground">
        Aún no hay datos. Subí los extractos de las TC en el bloque de arriba para verlo.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card/40 shadow-card3d p-5 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2.5">
          <span className="w-8 h-8 shrink-0 rounded-xl bg-accent/14 border border-accent/30 text-accent flex items-center justify-center">
            <Receipt size={15} />
          </span>
          <h3 className="font-semibold text-sm">Pagado vs Pendiente</h3>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="text-muted-foreground">TRM USD→COP:</label>
          <input
            type="number"
            value={trm}
            onChange={e => setTrm(Number(e.target.value) || 3800)}
            min={1000}
            max={10000}
            step={10}
            className="w-20 bg-card/40 border border-border rounded-lg px-2 py-1 text-xs font-mono tabular-nums hover:border-border-strong transition-colors"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <KpiCard
          icon={<ArrowUpRight size={14} className="text-success" />}
          label="Total pagado"
          value={formatCOP(total_pagado_cop)}
          subValue={`${formatCOP(totales.pagos_cop)} COP + USD ${totales.pagos_usd.toFixed(2)}`}
          tone="success"
        />
        <KpiCard
          icon={<ArrowDownRight size={14} className="text-danger" />}
          label="Total cargado"
          value={formatCOP(total_cargado_cop)}
          subValue={`${formatCOP(totales.compras_cop)} COP + USD ${totales.compras_usd.toFixed(2)}`}
          tone="warning"
        />
        <KpiCard
          icon={<CreditCard size={14} className="text-warning" />}
          label="Deuda residual actual"
          value={formatCOP(residual_total_cop)}
          subValue={residualByCard.length > 0
            ? residualByCard.map(r => `${r.tarjeta}: ${r.moneda === 'USD' ? `USD ${r.saldo_pendiente.toFixed(2)}` : formatCOP(r.saldo_pendiente)}`).join(' · ')
            : 'Sin deuda residual'}
          tone="danger"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left font-medium px-2 py-2">Mes</th>
              <th className="text-right font-medium px-2 py-2">
                <span className="inline-flex items-center gap-1">
                  <ArrowDownRight size={11} className="text-danger" /> Cargado
                </span>
              </th>
              <th className="text-right font-medium px-2 py-2">
                <span className="inline-flex items-center gap-1">
                  <ArrowUpRight size={11} className="text-success" /> Pagado
                </span>
              </th>
              <th className="text-right font-medium px-2 py-2">Δ deuda</th>
              <th className="text-right font-medium px-2 py-2">Acumulado</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const isAhorro = r.delta < 0;
              return (
                <tr key={r.year_month} className="border-t border-border hover:bg-foreground/[0.035] transition-colors">
                  <td className="px-2 py-2 capitalize">{fmtMonth(r.year_month)}</td>
                  <td className="text-right px-2 py-2 font-mono tabular-nums">{formatCOP(r.compras_total_cop)}</td>
                  <td className="text-right px-2 py-2 font-mono tabular-nums text-success">{formatCOP(r.pagos_total_cop)}</td>
                  <td className={`text-right px-2 py-2 font-mono tabular-nums font-medium ${isAhorro ? 'text-success' : 'text-danger'}`}>
                    {isAhorro ? '' : '+'}{formatCOP(r.delta)}
                  </td>
                  <td className="text-right px-2 py-2 font-mono tabular-nums font-semibold">
                    {formatCOP(r.saldo_acumulado)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {residualByCard.length > 0 && (
        <div className="rounded-2xl border border-border bg-foreground/[0.03] p-3 space-y-2 shadow-card3d hairline-top">
          <h4 className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
            <CreditCard size={12} /> Deuda residual actual por tarjeta
          </h4>
          <div className="space-y-1">
            {residualByCard.map(r => (
              <div key={`${r.tarjeta}-${r.moneda}`} className="flex justify-between text-xs">
                <span>
                  {r.tarjeta} <span className="text-muted-foreground">· {r.marca} · {r.num_compras} compras a cuotas</span>
                </span>
                <span className="font-mono tabular-nums font-medium">
                  {r.moneda === 'USD'
                    ? `USD ${r.saldo_pendiente.toFixed(2)} ≈ ${formatCOP(r.saldo_pendiente * trm)}`
                    : formatCOP(r.saldo_pendiente)
                  }
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <AlertTriangle size={12} className="mt-0.5 text-warning shrink-0" />
        <span>
          <strong>Acumulado</strong> es lo que vas debiendo después de cada mes (compras − pagos sumado mes a mes).
          <strong className="ml-1">Δ deuda en rojo</strong> = creció la deuda; <strong className="text-success">en verde</strong> = pagaste más de lo que cargaste.
          <strong className="ml-1">Deuda residual</strong> = lo que el banco dice que te falta hoy en cuotas diferidas.
        </span>
      </div>
    </div>
  );
}

interface KpiCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  subValue: string;
  tone: 'success' | 'warning' | 'danger' | 'muted';
}

function KpiCard({ icon, label, value, subValue, tone }: KpiCardProps) {
  const toneClass = {
    success: 'border-success/28 bg-success/[0.07]',
    warning: 'border-warning/28 bg-warning/[0.07]',
    danger:  'border-danger/28 bg-danger/[0.07]',
    muted:   'border-border bg-card/40',
  }[tone];
  return (
    <div className={`rounded-2xl border shadow-card3d p-4 ${toneClass}`}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-xl font-semibold font-mono tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground font-mono tabular-nums truncate" title={subValue}>{subValue}</div>
    </div>
  );
}
