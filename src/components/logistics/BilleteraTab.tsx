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
import { motion } from 'framer-motion';
import { TiltCard } from '@/components/ui3d';
import KpiCard from './finanzas/KpiCard';
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

// El <Kpi> local que vivía acá (la QUINTA variante de tarjeta KPI del módulo)
// se borró: era duplicación pura del KpiCard de finanzas/ — mismo layout, otro
// archivo, y por eso Billetera y Finanzas se veían como dos productos.

/** Entrada escalonada, misma cascada que Finanzas y el Dashboard. */
const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

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
    <div className="space-y-5">
      {/* Header */}
      <motion.div {...fadeUp(0)}>
        <TiltCard className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3 tilt-layer-1">
            <span className="w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 bg-accent/14 border-accent/30 text-accent glow-accent">
              <Wallet size={17} aria-hidden="true" />
            </span>
            <div className="space-y-1">
              <h2 className="text-base font-bold text-foreground tracking-tight">Billetera Dropi</h2>
              <p className="text-xs text-muted-foreground">
                Saldo actual:{' '}
                {/* COP() distingue null de 0 — el '…' del loading tampoco es un
                    cero: mientras carga no se afirma un saldo. */}
                <span className="font-mono tabular-nums font-semibold text-foreground">
                  {saldoHoyQ.isLoading ? '…' : COP(saldoHoyQ.data)}
                </span>
              </p>
              <WalletSyncBadge size="md" showLabel />
            </div>
          </div>

          <WalletSyncButton />
        </TiltCard>
      </motion.div>

      {/* KPIs — ahora el MISMO KpiCard de Finanzas, no una variante local */}
      <motion.div {...fadeUp(0.05)} className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {movQ.isLoading ? (
          <>
            <Skeleton className="h-[132px] rounded-2xl" />
            <Skeleton className="h-[132px] rounded-2xl" />
            <Skeleton className="h-[132px] rounded-2xl" />
            <Skeleton className="h-[132px] rounded-2xl" />
          </>
        ) : (
          <>
            <KpiCard label="Total Entradas" value={COP(movQ.data?.totalEntradas ?? 0)} icon={ArrowDown} tone="success" />
            <KpiCard label="Total Salidas"  value={COP(movQ.data?.totalSalidas ?? 0)}  icon={ArrowUp}   tone="danger" />
            <KpiCard label="Neto"           value={COP(neto)}                          icon={TrendingUp} tone={neto >= 0 ? 'success' : 'danger'} />
            <KpiCard label="Movimientos"    value={String(movQ.data?.countTotal ?? 0)} icon={ListOrdered} tone="neutral" />
          </>
        )}
      </motion.div>

      {/* Gráfica diaria */}
      <motion.div {...fadeUp(0.12)}>
        <TiltCard className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d transition-colors duration-200 hover:border-border-strong">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-4 tilt-layer-1">
            <TrendingUp size={14} className="text-success" aria-hidden="true" /> Movimientos por día
          </h3>
          {seriesQ.isLoading ? (
            <Skeleton className="h-[280px] w-full" />
          ) : series.length === 0 ? (
            <div className="flex items-center justify-center h-[280px] text-muted-foreground text-sm">
              Sin movimientos en este rango
            </div>
          ) : (
            <div className="h-[280px] tilt-layer-2">
              <ResponsiveContainer>
                <BarChart data={series} margin={{ top: 5, right: 10, bottom: 0, left: -15 }}>
                  <defs>
                    {/* Ids propios de este chart: los de <linearGradient> son
                        globales al documento y CashFlowChart dibuja la MISMA
                        serie con los suyos (finCash*). */}
                    <linearGradient id="walletInGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--success))" stopOpacity={0.95} />
                      <stop offset="100%" stopColor="hsl(var(--success))" stopOpacity={0.35} />
                    </linearGradient>
                    <linearGradient id="walletOutGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--danger))" stopOpacity={0.95} />
                      <stop offset="100%" stopColor="hsl(var(--danger))" stopOpacity={0.35} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...CHART_GRID_PROPS} />
                  <XAxis
                    dataKey="fecha" tickFormatter={fmtDay}
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    tickLine={false} axisLine={false}
                  />
                  <YAxis
                    tickFormatter={fmtCompact}
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    tickLine={false} axisLine={false} width={48}
                  />
                  <RTooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    cursor={CHART_BAR_CURSOR}
                    formatter={(v: number) => COP(v)}
                    labelFormatter={(l) => fmtDay(String(l))}
                  />
                  <Legend wrapperStyle={{ fontSize: 10, paddingTop: 6 }} iconType="circle" iconSize={8} />
                  {/* Solo el segmento de ARRIBA lleva radio, si no quedan muescas
                      entre segmentos de la pila. */}
                  <Bar
                    dataKey="ENTRADA" stackId="a" name="Entrada"
                    fill="url(#walletInGrad)" radius={[0, 0, 0, 0]}
                    style={{ filter: 'drop-shadow(0 0 6px hsl(var(--success)))' }}
                  />
                  <Bar
                    dataKey="SALIDA" stackId="a" name="Salida"
                    fill="url(#walletOutGrad)" radius={[6, 6, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </TiltCard>
      </motion.div>

      {/* Filtros + tabla */}
      <motion.div
        {...fadeUp(0.15)}
        className="rounded-2xl border border-border bg-card/40 p-5 shadow-card3d hairline-top space-y-4"
      >
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

          <div className="ml-auto font-mono tabular-nums text-[10px] text-muted-foreground">
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
                  {/* hud-label MAYUSCULIZA — va solo sobre estos rótulos fijos
                      escritos por nosotros. Las celdas de abajo llevan datos de
                      Dropi (tipo, categoría, descripción) y NO se tocan. */}
                  <TableRow>
                    <TableHead className="hud-label font-normal">Fecha</TableHead>
                    <TableHead className="hud-label font-normal">Tipo</TableHead>
                    <TableHead className="hud-label font-normal">Categoría</TableHead>
                    <TableHead className="hud-label font-normal">Descripción</TableHead>
                    <TableHead className="hud-label font-normal text-right">Monto</TableHead>
                    <TableHead className="hud-label font-normal text-right">Saldo después</TableHead>
                    <TableHead className="hud-label font-normal">Pedido</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {movQ.data!.rows.map((m) => {
                    const isEntrada = m.tipo === 'ENTRADA';
                    const sign = isEntrada ? '+' : '−';
                    const colorClass = isEntrada ? 'text-success' : 'text-danger';
                    return (
                      <TableRow key={m.id} className="transition-colors duration-200">
                        <TableCell className="font-mono tabular-nums text-xs whitespace-nowrap">
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
                        <TableCell className={`text-right font-mono tabular-nums font-semibold ${colorClass}`}>
                          {sign}{COP(m.monto)}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums text-xs text-muted-foreground">
                          {COP(m.saldo_despues)}
                        </TableCell>
                        <TableCell>
                          {m.related_order_id ? (
                            <Link
                              to={`/pedido/${m.related_order_id}`}
                              className="inline-flex items-center gap-1 font-mono tabular-nums text-xs text-info hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none rounded"
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
            <span className="font-mono tabular-nums text-[10px] text-muted-foreground">
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
      </motion.div>
    </div>
  );
}
