import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, Legend,
} from 'recharts';
import { formatCOP } from '@/lib/utils';

export interface CashFlowSeriesPoint {
  fecha: string;       // YYYY-MM-DD
  ENTRADA: number;     // monto positivo abonado al wallet ese día
  SALIDA: number;      // monto positivo debitado del wallet ese día
}

interface CashFlowChartProps {
  series: CashFlowSeriesPoint[];
  isLoading?: boolean;
}

const TOOLTIP_STYLE = {
  background: 'hsl(var(--card) / 0.96)',
  border: '1px solid hsl(var(--border-strong))',
  borderRadius: 8,
  color: 'hsl(var(--foreground))',
  fontSize: 12,
  padding: '8px 10px',
  boxShadow: 'var(--shadow-md)',
};

function fmtDay(s: string): string {
  const d = new Date(s + 'T00:00:00Z');
  // timeZone UTC obligatorio: el string se parsea como UTC; sin esto el render
  // en Bogotá (UTC-5) rotula el bucket del 1 de junio como "31 may.".
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

function fmtCompact(v: number): string {
  return new Intl.NumberFormat('es-CO', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

export default function CashFlowChart({ series, isLoading = false }: CashFlowChartProps) {
  if (isLoading) {
    return <div className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top animate-pulse h-[340px]" />;
  }

  const totalIn = series.reduce((acc, s) => acc + s.ENTRADA, 0);
  const totalOut = series.reduce((acc, s) => acc + s.SALIDA, 0);
  const neto = totalIn - totalOut;

  return (
    <div className="rounded-2xl border border-border bg-card/40 p-5 shadow-card3d hairline-top transition-colors hover:border-border-strong">
      <div className="flex items-end justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-bold text-foreground tracking-tight uppercase tracking-[0.06em]">
            Cash flow diario
          </h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Entradas vs salidas por día (wallet Dropi)
          </p>
        </div>
        <div className="text-right">
          <div className={`text-base font-bold tabular-nums leading-none ${
            neto >= 0 ? 'text-success' : 'text-danger'
          }`}>
            {neto >= 0 ? '+' : ''}{formatCOP(neto)}
          </div>
          <div className="text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground mt-1">
            neto
          </div>
        </div>
      </div>

      {series.length === 0 ? (
        <div className="flex items-center justify-center h-[260px] text-xs text-muted-foreground">
          Sin movimientos en este rango
        </div>
      ) : (
        <div className="h-[260px]">
          <ResponsiveContainer>
            <BarChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.6)" vertical={false} />
              <XAxis
                dataKey="fecha"
                tickFormatter={fmtDay}
                stroke="hsl(var(--muted-foreground))"
                fontSize={10}
                tickLine={false}
                axisLine={{ stroke: 'hsl(var(--border))' }}
              />
              <YAxis
                tickFormatter={fmtCompact}
                stroke="hsl(var(--muted-foreground))"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                width={50}
              />
              <RTooltip
                contentStyle={TOOLTIP_STYLE}
                cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
                formatter={(v: number, name) => [formatCOP(v), name as string]}
                labelFormatter={(l) => fmtDay(String(l))}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                iconType="circle"
                iconSize={8}
              />
              <Bar dataKey="ENTRADA" stackId="a" fill="hsl(var(--success))" name="Entrada" radius={[3, 3, 0, 0]} />
              <Bar dataKey="SALIDA"  stackId="a" fill="hsl(var(--danger))"  name="Salida"  radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
