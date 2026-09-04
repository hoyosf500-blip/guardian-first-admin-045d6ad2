import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Wallet, ArrowDown, ArrowUp, TrendingUp, ListOrdered, AlertTriangle } from 'lucide-react';
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
import { useWalletMovements, useWalletSaldoHoy } from '@/hooks/useWalletMovements';
import WalletSyncButton from '@/components/wallet/WalletSyncButton';
import type { LogisticsFilters } from '@/lib/logistics.types';
import { motion } from 'framer-motion';
import { TiltCard } from '@/components/ui3d';
import KpiCard from './finanzas/KpiCard';

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

// Solo fmtFecha para timestamps con hora (lo usa la tabla); el chart diario y
// sus helpers se podaron el 24-ago-2026 (CashFlowChart ya dibuja esa serie).

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

  // ⛔ VOLVER A LA PÁGINA 1 AL CAMBIAR UN FILTRO (4-sep-2026). `page` era estado
  // local y nada lo reseteaba: si el dueño estaba en la página 5 y acotaba el
  // rango a un período corto, la consulta pedía una página que ya no existe →
  // la tabla decía "Sin movimientos", `totalPages` caía a 1 y el paginador
  // desaparecía. Quedaba encerrado en una página vacía, sin forma de volver, y
  // pareciendo que en ese período no hubo plata.
  //
  // Se resetea acá y no "acotando page a totalPages": eso sería circular
  // (`totalPages` sale de la respuesta que la propia página condiciona).
  useEffect(() => { setPage(1); }, [fromDate, toDate, tipo, categoria]);

  const movQ = useWalletMovements({ fromDate, toDate, tipo, categoria, page, pageSize: PAGE_SIZE });
  // Saldo real de HOY (último movimiento, sin filtro de rango) — el ultimoSaldo
  // de movQ hereda el rango de la vista y mostraba el saldo al cierre del período.
  const saldoHoyQ = useWalletSaldoHoy();

  const totalPages = Math.max(1, Math.ceil((movQ.data?.total ?? 0) / PAGE_SIZE));
  const neto = (movQ.data?.totalEntradas ?? 0) - (movQ.data?.totalSalidas ?? 0);

  // ⛔ LOS KPIs NO RESPONDEN A TIPO NI A CATEGORÍA (medido 4-sep-2026, Ecuador,
  // agosto). `useWalletMovements` aplica los dos filtros a la TABLA (líneas
  // 67-68) pero llama a `wallet_summary(p_from, p_to)` SIN ellos: la función
  // desplegada ni siquiera los acepta (probada con p_tipo → PGRST202). Así que
  // con "Tipo: Salida" puesto, la tabla muestra 276 movimientos y las tarjetas
  // siguen diciendo $12.607 de entradas y 943 movimientos del rango entero.
  //
  // Hasta que exista la función filtrada, las tarjetas de plata DICEN que son
  // del rango completo en vez de fingir que miden lo filtrado. Y "Movimientos"
  // pasa a `total` —el conteo que ya viene filtrado de la propia consulta de la
  // tabla— porque decía 943 justo encima de una línea que decía 276: la misma
  // pantalla dando dos respuestas al mismo número.
  const filtroActivo = tipo !== 'ALL' || categoria !== 'ALL';
  const notaRango = filtroActivo ? 'del rango completo — el filtro de abajo no llega a este número' : undefined;

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
              {/* El WalletSyncBadge se PODÓ de acá (24-ago-2026): Billetera es
                  una sección dentro de la tab Finanzas y el mismo badge ya
                  está en el header de la sección 1 — dos en el mismo scroll. */}
            </div>
          </div>

          <WalletSyncButton />
        </TiltCard>
      </motion.div>

      {/* Error REAL de lectura — principio de honestidad: un fallo de la query
          NO puede pintarse como "$0 · Sin movimientos" (se lee como billetera
          vacía medida). Mismo banner que FinanzasTab usa para su isError. */}
      {movQ.isError && (
        <motion.div
          {...fadeUp(0.03)}
          className="relative flex flex-col sm:flex-row sm:items-center gap-3 rounded-2xl border border-danger/30 bg-danger/10 px-4 pl-5 py-3 shadow-card3d"
        >
          <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-danger" aria-hidden="true" />
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-danger/20 glow-danger">
            <AlertTriangle size={18} className="text-danger" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-xs font-semibold text-danger">
              No se pudo leer la billetera — los totales NO son $0
            </h3>
            <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
              {(movQ.error as Error)?.message ?? 'Error desconocido'} · recargá o tocá Refrescar
            </p>
          </div>
        </motion.div>
      )}

      {/* KPIs — ahora el MISMO KpiCard de Finanzas, no una variante local */}
      <motion.div {...fadeUp(0.05)} className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {movQ.isLoading ? (
          <>
            <Skeleton className="h-[132px] rounded-2xl" />
            <Skeleton className="h-[132px] rounded-2xl" />
            <Skeleton className="h-[132px] rounded-2xl" />
            <Skeleton className="h-[132px] rounded-2xl" />
          </>
        ) : movQ.isError ? (
          <>
            {/* "—", no COP(0): el dato no se leyó, no es un cero medido. */}
            <KpiCard label="Total Entradas" value="—" icon={ArrowDown}   tone="neutral" hint="no se pudo leer" />
            <KpiCard label="Total Salidas"  value="—" icon={ArrowUp}     tone="neutral" hint="no se pudo leer" />
            <KpiCard label="Neto"           value="—" icon={TrendingUp}  tone="neutral" hint="no se pudo leer" />
            <KpiCard label="Movimientos"    value="—" icon={ListOrdered} tone="neutral" hint="no se pudo leer" />
          </>
        ) : (
          <>
            <KpiCard label="Total Entradas" value={COP(movQ.data?.totalEntradas ?? 0)} icon={ArrowDown} tone="success" hint={notaRango} />
            <KpiCard label="Total Salidas"  value={COP(movQ.data?.totalSalidas ?? 0)}  icon={ArrowUp}   tone="danger"  hint={notaRango} />
            {/* Hint obligatorio: arriba en la misma pantalla hay OTRO "neto"
                (Wallet neto del período, SOLO operativo) con otra definición.
                Este suma TODO — retiros y depósitos incluidos. Sin la
                aclaración, dos "neto" distintos del mismo rango parecían
                contradecirse (auditoría 24-ago-2026). */}
            <KpiCard label="Movimiento neto" value={COP(neto)} icon={TrendingUp} tone={neto >= 0 ? 'success' : 'danger'}
              hint={`entradas − salidas de TODO el wallet · incluye retiros y depósitos — no es ganancia${filtroActivo ? ' · del rango completo, sin el filtro de abajo' : ''}`} />
            {/* `total` (conteo de la consulta de la tabla, YA filtrado), no
                `countTotal` (del RPC, sin filtrar): son el mismo número y la
                pantalla los mostraba distintos con un filtro puesto. */}
            <KpiCard label="Movimientos"    value={String(movQ.data?.total ?? 0)} icon={ListOrdered} tone="neutral"
              hint={filtroActivo ? 'con el filtro puesto' : undefined} />
          </>
        )}
      </motion.div>

      {/* El chart "Movimientos por día" se PODÓ (24-ago-2026): Billetera vive
          DENTRO de la tab Finanzas y CashFlowChart ya dibuja la MISMA serie
          (useWalletDailySeries) dos scrolls arriba — el mismo dato dos veces,
          la lección de "En tránsito 72" del chip y la columna. */}

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
            {/* '—' en error: "0 movimientos" afirmaría un conteo que no se leyó. */}
            {movQ.isError ? '—' : (movQ.data?.total ?? 0)} movimientos
          </div>
        </div>

        {movQ.isLoading ? (
          <Skeleton className="h-[400px] w-full" />
        ) : movQ.isError ? (
          /* La query FALLÓ: no mostrar "Sin movimientos" (eso significa que se
             leyó y hay cero, que es otra cosa). El banner de arriba tiene el
             detalle del error. */
          <div className="flex items-center justify-center gap-2 h-[200px] text-danger text-sm">
            <AlertTriangle size={15} aria-hidden="true" />
            No se pudieron leer los movimientos — recargá o tocá Refrescar.
          </div>
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
