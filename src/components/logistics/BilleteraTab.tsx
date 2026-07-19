import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Wallet, ArrowDown, ArrowUp, TrendingUp, ListOrdered } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, Legend,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import { formatCOP } from '@/lib/utils';
import { useWalletMovements, useWalletDailySeries, useWalletSaldoHoy } from '@/hooks/useWalletMovements';
import WalletSyncBadge from '@/components/wallet/WalletSyncBadge';
import WalletSyncButton from '@/components/wallet/WalletSyncButton';
import type { LogisticsFilters } from '@/lib/logistics.types';
import {
  CHART_TOOLTIP_STYLE, CHART_GRID_PROPS, CHART_BAR_CURSOR,
  fmtCompact, fmtDay,
} from './charts/chartTokens';

const PAGE_SIZE = 20;

// Delegado a formatCOP para que la tienda EC formatee USD con centavos
// (el formateador local fijo en COP borraba los decimales de los montos EC).
const COP = (n: number | null | undefined) => (n == null ? '—' : formatCOP(n));

function fmtFecha(s: string): string {
  const d = new Date(s);
  const date = d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
  const time = d.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
  return `${date} ${time}`;
}

// fmtDay y TOOLTIP_STYLE consolidados en chartTokens.ts (importados arriba).
// Mantenemos solo fmtFecha para timestamps con hora (lo usa la tabla).

interface KpiProps {
  label: string;
  value: string;
  icon: React.ElementType;
  tone: 'success' | 'danger' | 'info' | 'neutral';
}

const KPI_TONE_CARD: Record<KpiProps['tone'], string> = {
  success: 'border-success/30 bg-gradient-to-br from-success/8 via-success/3 to-transparent',
  danger:  'border-danger/30 bg-gradient-to-br from-danger/8 via-danger/3 to-transparent',
  info:    'border-info/30 bg-gradient-to-br from-info/8 via-info/3 to-transparent',
  neutral: 'border-border bg-card',
};

const KPI_TONE_ICON: Record<KpiProps['tone'], { bg: string; color: string }> = {
  success: { bg: 'bg-success/15 border-success/40', color: 'text-success' },
  danger:  { bg: 'bg-danger/15 border-danger/40',   color: 'text-danger' },
  info:    { bg: 'bg-info/15 border-info/40',       color: 'text-info' },
  neutral: { bg: 'bg-muted/40 border-border',       color: 'text-foreground' },
};

const KPI_TONE_VALUE: Record<KpiProps['tone'], string> = {
  success: 'text-success',
  danger:  'text-danger',
  info:    'text-info',
  neutral: 'text-foreground',
};

function Kpi({ label, value, icon: Icon, tone }: KpiProps) {
  return (
    <div className={`rounded-2xl border-2 p-4 shadow-card3d ${KPI_TONE_CARD[tone]}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] uppercase tracking-[0.12em] font-bold text-muted-foreground leading-tight">
          {label}
        </span>
        <div className={`h-8 w-8 shrink-0 rounded-lg border flex items-center justify-center ${KPI_TONE_ICON[tone].bg}`}>
          <Icon size={14} className={KPI_TONE_ICON[tone].color} aria-hidden="true" />
        </div>
      </div>
      <div className={`mt-3 text-2xl font-extrabold tabular-nums leading-none ${KPI_TONE_VALUE[tone]}`}>
        {value}
      </div>
    </div>
  );
}

export default function BilleteraTab({ filters }: { filters: LogisticsFilters }) {
  const [tipo, setTipo] = useState<'ALL' | 'ENTRADA' | 'SALIDA'>('ALL');
  const [categoria, setCategoria] = useState<string>('ALL');
  const [page, setPage] = useState(1);

  const { fromDate, toDate } = filters;

  const movQ = useWalletMovements({ fromDate, toDate, tipo, categoria, page, pageSize: PAGE_SIZE });
  const seriesQ = useWalletDailySeries(fromDate, toDate);
  // Saldo real de HOY (último movimiento, sin filtro de rango) — el ultimoSaldo
  // de movQ hereda el rango de la vista y mostraba el saldo al cierre del período.
  const saldoHoyQ = useWalletSaldoHoy();

  const totalPages = Math.max(1, Math.ceil((movQ.data?.total ?? 0) / PAGE_SIZE));
  const neto = (movQ.data?.totalEntradas ?? 0) - (movQ.data?.totalSalidas ?? 0);

  const series = useMemo(() => seriesQ.data ?? [], [seriesQ.data]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="rounded-2xl border border-border bg-card/40 p-5 shadow-card3d hairline-top flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-muted/40 flex items-center justify-center">
            <Wallet size={18} className="text-foreground" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <h2 className="text-base font-bold text-foreground tracking-tight">Billetera Dropi</h2>
            <p className="text-xs text-muted-foreground">
              Saldo actual:{' '}
              <span className="font-semibold tabular-nums text-foreground">
                {saldoHoyQ.isLoading ? '…' : COP(saldoHoyQ.data)}
              </span>
            </p>
            <WalletSyncBadge size="md" showLabel />
          </div>
        </div>

        <WalletSyncButton />
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {movQ.isLoading ? (
          <>
            <Skeleton className="h-[88px] rounded-2xl" />
            <Skeleton className="h-[88px] rounded-2xl" />
            <Skeleton className="h-[88px] rounded-2xl" />
            <Skeleton className="h-[88px] rounded-2xl" />
          </>
        ) : (
          <>
            <Kpi label="Total Entradas" value={COP(movQ.data?.totalEntradas ?? 0)} icon={ArrowDown} tone="success" />
            <Kpi label="Total Salidas"  value={COP(movQ.data?.totalSalidas ?? 0)}  icon={ArrowUp}   tone="danger" />
            <Kpi label="Neto"           value={COP(neto)}                          icon={TrendingUp} tone={neto >= 0 ? 'success' : 'danger'} />
            <Kpi label="Movimientos"    value={String(movQ.data?.countTotal ?? 0)} icon={ListOrdered} tone="neutral" />
          </>
        )}
      </div>

      {/* Gráfica diaria */}
      <div className="rounded-2xl border border-border bg-card/40 p-5 shadow-card3d hairline-top">
        <h3 className="text-sm font-bold text-foreground tracking-tight uppercase tracking-[0.06em] mb-3">
          Movimientos por día
        </h3>
        {seriesQ.isLoading ? (
          <Skeleton className="h-[280px] w-full" />
        ) : series.length === 0 ? (
          <div className="flex items-center justify-center h-[280px] text-muted-foreground text-sm">
            Sin movimientos en este rango
          </div>
        ) : (
          <div className="h-[280px]">
            <ResponsiveContainer>
              <BarChart data={series} margin={{ top: 8, right: 10, bottom: 5, left: -10 }}>
                <CartesianGrid {...CHART_GRID_PROPS} />
                <XAxis dataKey="fecha" tickFormatter={fmtDay} stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={{ stroke: 'hsl(var(--border))' }} />
                <YAxis
                  tickFormatter={fmtCompact}
                  stroke="hsl(var(--muted-foreground))" fontSize={10}
                  tickLine={false} axisLine={false} width={48}
                />
                <RTooltip
                  contentStyle={CHART_TOOLTIP_STYLE}
                  cursor={CHART_BAR_CURSOR}
                  formatter={(v: number) => COP(v)}
                  labelFormatter={(l) => fmtDay(String(l))}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} iconType="circle" iconSize={8} />
                <Bar dataKey="ENTRADA" stackId="a" fill="hsl(var(--success))" name="Entrada" />
                <Bar dataKey="SALIDA"  stackId="a" fill="hsl(var(--danger))"  name="Salida" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Filtros + tabla */}
      <div className="rounded-2xl border border-border bg-card/40 p-5 shadow-card3d hairline-top space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Tipo:</span>
            <Select value={tipo} onValueChange={(v) => { setTipo(v as 'ALL' | 'ENTRADA' | 'SALIDA'); setPage(1); }}>
              <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Todos</SelectItem>
                <SelectItem value="ENTRADA">Entrada</SelectItem>
                <SelectItem value="SALIDA">Salida</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Categoría:</span>
            <Select value={categoria} onValueChange={(v) => { setCategoria(v); setPage(1); }}>
              <SelectTrigger className="h-8 w-[200px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Todas</SelectItem>
                {(movQ.data?.categorias ?? []).map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="ml-auto text-xs text-muted-foreground tabular-nums">
            {movQ.data?.total ?? 0} movimientos
          </div>
        </div>

        {movQ.isLoading ? (
          <Skeleton className="h-[400px] w-full" />
        ) : (movQ.data?.rows.length ?? 0) === 0 ? (
          <div className="flex items-center justify-center h-[200px] text-muted-foreground text-sm">
            Sin movimientos para los filtros seleccionados
          </div>
        ) : (
          <TooltipProvider delayDuration={200}>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Categoría</TableHead>
                    <TableHead>Descripción</TableHead>
                    <TableHead className="text-right">Monto</TableHead>
                    <TableHead className="text-right">Saldo después</TableHead>
                    <TableHead>Pedido</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {movQ.data!.rows.map((m) => {
                    const isEntrada = m.tipo === 'ENTRADA';
                    const sign = isEntrada ? '+' : '−';
                    const colorClass = isEntrada ? 'text-success' : 'text-danger';
                    return (
                      <TableRow key={m.id}>
                        <TableCell className="tabular-nums text-xs whitespace-nowrap">
                          {fmtFecha(m.fecha)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={isEntrada ? 'border-success/40 text-success' : 'border-danger/40 text-danger'}>
                            {m.tipo}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {m.categoria ? (
                            <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                              {m.categoria}
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </TableCell>
                        <TableCell className="max-w-[200px]">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="block truncate text-xs text-foreground">
                                {m.descripcion ?? '—'}
                              </span>
                            </TooltipTrigger>
                            {m.descripcion && (
                              <TooltipContent className="max-w-[400px]">
                                <p className="text-xs">{m.descripcion}</p>
                              </TooltipContent>
                            )}
                          </Tooltip>
                        </TableCell>
                        <TableCell className={`text-right tabular-nums font-semibold ${colorClass}`}>
                          {sign}{COP(m.monto)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                          {COP(m.saldo_despues)}
                        </TableCell>
                        <TableCell>
                          {m.related_order_id ? (
                            <Link
                              to={`/pedido/${m.related_order_id}`}
                              className="inline-flex items-center gap-1 text-xs text-info hover:underline"
                            >
                              {m.related_order_id}
                              <ExternalLink size={11} />
                            </Link>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </TooltipProvider>
        )}

        {/* Paginación */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-2">
            <span className="text-xs text-muted-foreground">
              Página {page} de {totalPages}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Anterior
              </Button>
              <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Siguiente
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
