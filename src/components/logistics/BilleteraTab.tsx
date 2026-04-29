import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, ExternalLink, Wallet, ArrowDown, ArrowUp, TrendingUp, ListOrdered } from 'lucide-react';
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
import { useWalletMovements, useWalletDailySeries } from '@/hooks/useWalletMovements';
import { useWalletSync } from '@/hooks/useWalletSync';
import type { LogisticsFilters } from '@/lib/logistics.types';

const PAGE_SIZE = 20;

const COP = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);

function fmtFecha(s: string): string {
  const d = new Date(s);
  const date = d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
  const time = d.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
  return `${date} ${time}`;
}

function fmtDay(s: string): string {
  const d = new Date(s + 'T00:00:00Z');
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
}

const TOOLTIP_STYLE = {
  background: 'hsl(var(--card) / 0.95)',
  border: '1px solid hsl(var(--border))',
  borderRadius: 8,
  color: 'hsl(var(--foreground))',
  fontSize: 12,
};

interface KpiProps {
  label: string;
  value: string;
  icon: React.ElementType;
  tone: 'success' | 'danger' | 'info' | 'neutral';
}

function Kpi({ label, value, icon: Icon, tone }: KpiProps) {
  const toneClass = {
    success: 'text-success',
    danger: 'text-danger',
    info: 'text-info',
    neutral: 'text-foreground',
  }[tone];
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
          {label}
        </span>
        <Icon size={14} className={toneClass} aria-hidden="true" />
      </div>
      <div className={`mt-2 text-xl font-bold tabular-nums ${toneClass}`}>{value}</div>
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
  const sync = useWalletSync();

  const totalPages = Math.max(1, Math.ceil((movQ.data?.total ?? 0) / PAGE_SIZE));
  const neto = (movQ.data?.totalEntradas ?? 0) - (movQ.data?.totalSalidas ?? 0);

  const handleSync = () => {
    const today = new Date();
    const past = new Date();
    past.setDate(past.getDate() - 30);
    sync.mutate({
      from: past.toISOString().split('T')[0],
      untill: today.toISOString().split('T')[0],
    });
  };

  const series = useMemo(() => seriesQ.data ?? [], [seriesQ.data]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="rounded-xl border border-border bg-card p-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-muted/40 flex items-center justify-center">
            <Wallet size={18} className="text-foreground" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-base font-bold text-foreground tracking-tight">Billetera Dropi</h2>
            <p className="text-xs text-muted-foreground">
              Saldo actual:{' '}
              <span className="font-semibold tabular-nums text-foreground">
                {movQ.isLoading ? '…' : COP(movQ.data?.ultimoSaldo)}
              </span>
            </p>
          </div>
        </div>

        <Button onClick={handleSync} disabled={sync.isPending} size="sm" variant="outline">
          <RefreshCw size={14} className={`mr-1.5 ${sync.isPending ? 'animate-spin' : ''}`} />
          {sync.isPending ? 'Sincronizando…' : 'Sincronizar últimos 30 días'}
        </Button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {movQ.isLoading ? (
          <>
            <Skeleton className="h-[88px] rounded-xl" />
            <Skeleton className="h-[88px] rounded-xl" />
            <Skeleton className="h-[88px] rounded-xl" />
            <Skeleton className="h-[88px] rounded-xl" />
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
      <div className="rounded-xl border border-border bg-card p-5">
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
              <BarChart data={series}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="fecha" tickFormatter={fmtDay} stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <YAxis
                  tickFormatter={(v) => new Intl.NumberFormat('es-CO', { notation: 'compact' }).format(v)}
                  stroke="hsl(var(--muted-foreground))" fontSize={11}
                />
                <RTooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number) => COP(v)}
                  labelFormatter={(l) => fmtDay(String(l))}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="ENTRADA" stackId="a" fill="hsl(var(--success))" name="Entrada" />
                <Bar dataKey="SALIDA"  stackId="a" fill="hsl(var(--danger))"  name="Salida" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Filtros + tabla */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
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
