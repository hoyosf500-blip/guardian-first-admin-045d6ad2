import { useMemo, useState } from 'react';
import {
  TrendingUp, TrendingDown, Wallet, AlertTriangle, Plus, Pencil, Trash2,
  CheckCircle2, Copy, Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCOP } from '@/lib/utils';
import { useStore } from '@/contexts/StoreContext';
import {
  useBalanceMensual, useRendiciones, useBorrarRendicion,
} from '@/hooks/useBalanceRendiciones';
import { construirBalance, cruzarRendiciones, type Rendicion } from '@/lib/balanceRendiciones';
import RendicionDialog from '@/components/logistics/RendicionDialog';

// "Balance" — reemplaza el Excel que había que armar a mano para saber cómo iba
// la operación y si la plata que salió de la billetera estaba explicada.
//
// Responde DOS preguntas que no hay que mezclar:
//   1. ¿Estamos ganando?          → utilidad = operativo − pauta − admin, por mes
//   2. ¿Está toda la plata?       → retirado (billetera) vs rendido (comprobantes)
// Un mes puede ser bueno Y tener plata sin explicar. Por eso van en bloques
// separados y no en una sola tabla.
//
// El operativo NO se recalcula acá: lo devuelve el mismo RPC que alimenta "Cómo
// voy". Dos pantallas con dos cifras del mismo mes es justo lo que este módulo
// viene a cerrar.

const mesLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1)
    .toLocaleDateString('es-CO', { month: 'short', year: '2-digit' })
    .replace('.', '');
};

interface Props {
  /** 'YYYY-MM-DD' del filtro global de /logistica. */
  fromDate: string;
  toDate: string;
}

export default function BalanceTab({ fromDate, toDate }: Props) {
  const { isOwnerOfActive } = useStore();
  const desde = fromDate.slice(0, 7);
  const hasta = toDate.slice(0, 7);

  const balanceQ = useBalanceMensual(desde, hasta);
  const rendQ = useRendiciones(fromDate, toDate);
  const borrar = useBorrarRendicion();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editando, setEditando] = useState<Rendicion | null>(null);

  const { meses, totales } = useMemo(
    () => construirBalance(balanceQ.data ?? []),
    [balanceQ.data],
  );
  const cruce = useMemo(() => cruzarRendiciones(rendQ.data ?? []), [rendQ.data]);

  // La migration todavía no está aplicada. NO se muestra un balance en ceros:
  // "no ganaste nada" y "todavía no está la tabla" son cosas muy distintas.
  if (balanceQ.data === null && !balanceQ.isLoading) {
    return (
      <div className="rounded-2xl border border-warning/30 bg-warning/8 p-6 text-sm">
        <p className="font-semibold text-warning flex items-center gap-2">
          <AlertTriangle size={15} /> Falta aplicar la migración del módulo Balance
        </p>
        <p className="mt-1.5 text-muted-foreground text-[13px]">
          El código está publicado pero las tablas todavía no existen en la base. Aplicá{' '}
          <code className="font-mono text-[11px]">20260806140000_rendiciones_control_socios.sql</code>{' '}
          y esta pantalla se enciende sola.
        </p>
      </div>
    );
  }

  if (balanceQ.isError) {
    return (
      <div className="rounded-2xl border border-danger/30 bg-danger/10 p-6 text-sm">
        <p className="font-semibold text-danger">No se pudo cargar el balance.</p>
        <p className="mt-1 text-[11px] text-muted-foreground font-mono">
          {(balanceQ.error as Error)?.message} · los datos NO se perdieron, recargá.
        </p>
      </div>
    );
  }

  if (balanceQ.isLoading) {
    return <div className="h-64 rounded-2xl bg-muted/30 animate-pulse" />;
  }

  const gano = totales.utilidad >= 0;

  return (
    <div className="space-y-5">
      {/* ── Titular ─────────────────────────────────────────────── */}
      <section className="rounded-3xl border border-border bg-card/40 p-5 shadow-card3d-lg hairline-top">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h3 className="hud-label mb-2">
              {gano ? 'Ganamos en el período' : 'Perdimos en el período'}
            </h3>
            <div className={`text-[40px] leading-none font-mono font-bold tabular-nums ${gano ? 'text-success' : 'text-danger'}`}>
              {formatCOP(totales.utilidad)}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {formatCOP(totales.operativo)} de operación − {formatCOP(totales.invertido)} invertidos
              {totales.roi != null && (
                <> · <strong className="text-foreground">{totales.roi.toFixed(1)}% de retorno</strong></>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {gano
              ? <TrendingUp size={22} className="text-success" />
              : <TrendingDown size={22} className="text-danger" />}
          </div>
        </div>
      </section>

      {/* ── Mes a mes ───────────────────────────────────────────── */}
      <section className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top overflow-hidden">
        <header className="px-5 py-3 border-b border-border">
          <h4 className="hud-label">Mes a mes</h4>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="hud-label border-b border-border">
                <th className="text-left px-5 py-2.5 font-semibold">Mes</th>
                <th className="text-right px-3 py-2.5 font-semibold">Operativo</th>
                <th className="text-right px-3 py-2.5 font-semibold">Pauta</th>
                <th className="text-right px-3 py-2.5 font-semibold">Admin</th>
                <th className="text-right px-3 py-2.5 font-semibold">Utilidad</th>
                <th className="text-right px-3 py-2.5 font-semibold">Retorno</th>
                <th className="text-right px-3 py-2.5 font-semibold">Pedidos</th>
                <th
                  className="text-right px-3 py-2.5 font-semibold"
                  title="Entregados ÷ concluidos (entregados + devueltos). No cuenta los que siguen en la calle."
                >
                  Entrega
                </th>
              </tr>
            </thead>
            <tbody>
              {meses.map((m) => (
                <tr key={m.year_month} className="border-b border-border/40 hover:bg-foreground/[0.03] transition-colors">
                  <td className="text-left px-5 py-2.5 font-medium capitalize">{mesLabel(m.year_month)}</td>
                  <td className="text-right px-3 py-2.5 font-mono">{formatCOP(m.operativo)}</td>
                  <td className="text-right px-3 py-2.5 font-mono text-muted-foreground">−{formatCOP(m.pauta)}</td>
                  <td className="text-right px-3 py-2.5 font-mono text-muted-foreground">−{formatCOP(m.admin)}</td>
                  <td className={`text-right px-3 py-2.5 font-mono font-bold ${m.utilidad >= 0 ? 'text-success' : 'text-danger'}`}>
                    {m.utilidad >= 0 ? '+' : ''}{formatCOP(m.utilidad)}
                  </td>
                  <td className={`text-right px-3 py-2.5 font-mono ${
                    m.roi == null ? 'text-muted-foreground' : m.roi >= 0 ? 'text-success' : 'text-danger'}`}>
                    {m.roi == null ? '—' : `${m.roi.toFixed(1)}%`}
                  </td>
                  <td className="text-right px-3 py-2.5 font-mono text-muted-foreground">{m.pedidos.toLocaleString('es-CO')}</td>
                  <td className="text-right px-3 py-2.5 font-mono text-muted-foreground">
                    {m.tasaEntrega == null ? '—' : `${m.tasaEntrega.toFixed(0)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-bold">
                <td className="text-left px-5 py-2.5">Total</td>
                <td className="text-right px-3 py-2.5 font-mono">{formatCOP(totales.operativo)}</td>
                <td className="text-right px-3 py-2.5 font-mono">−{formatCOP(totales.pauta)}</td>
                <td className="text-right px-3 py-2.5 font-mono">−{formatCOP(totales.admin)}</td>
                <td className={`text-right px-3 py-2.5 font-mono ${gano ? 'text-success' : 'text-danger'}`}>
                  {gano ? '+' : ''}{formatCOP(totales.utilidad)}
                </td>
                <td className={`text-right px-3 py-2.5 font-mono ${gano ? 'text-success' : 'text-danger'}`}>
                  {totales.roi == null ? '—' : `${totales.roi.toFixed(1)}%`}
                </td>
                <td className="text-right px-3 py-2.5 font-mono">{totales.pedidos.toLocaleString('es-CO')}</td>
                <td className="text-right px-3 py-2.5 font-mono">
                  {totales.tasaEntrega == null ? '—' : `${totales.tasaEntrega.toFixed(0)}%`}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* ── Conciliación de caja ────────────────────────────────── */}
      <section className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top overflow-hidden">
        <header className="px-5 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
          <h4 className="hud-label flex items-center gap-2">
            <Wallet size={13} className="text-accent" /> Conciliación de caja
          </h4>
          {isOwnerOfActive && (
            <Button size="sm" variant="outline" onClick={() => { setEditando(null); setDialogOpen(true); }}>
              <Plus size={13} className="mr-1.5" /> Nueva rendición
            </Button>
          )}
        </header>

        <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-border">
          <Cifra label="Salió de la billetera" valor={cruce.totalRetirado} tono="neutral" />
          <Cifra label="Rendido con comprobante" valor={cruce.totalRendido} tono="neutral" />
          <Cifra
            label="Sin explicar"
            valor={cruce.totalRetirado - cruce.totalRendido}
            tono={Math.abs(cruce.totalRetirado - cruce.totalRendido) < 0.01 ? 'ok' : 'alerta'}
          />
        </div>

        {/* Cobros repetidos — el motivo del módulo. */}
        {cruce.cantidadDuplicados > 0 && (
          <div className="mx-5 mb-4 rounded-xl border border-danger/40 bg-danger/8 p-3.5">
            <p className="text-[13px] font-semibold text-danger flex items-center gap-2">
              <Copy size={14} />
              {cruce.cantidadDuplicados === 1
                ? 'Hay 1 cargo cobrado dos veces'
                : `Hay ${cruce.cantidadDuplicados} cargos cobrados dos veces`}
              {' '}· {formatCOP(cruce.totalDuplicado)}
            </p>
            <ul className="mt-2 space-y-1">
              {cruce.cruzadas.flatMap((r) =>
                r.duplicados.map((d) => (
                  <li key={d.item.id} className="text-[11px] text-muted-foreground">
                    <strong className="text-foreground">{d.item.concepto}</strong>{' '}
                    ({formatCOP(d.item.monto)}) — cobrado el {r.fecha} y antes el {d.yaCobradoEn}
                  </li>
                )),
              )}
            </ul>
          </div>
        )}

        {/* Listado de rendiciones */}
        {rendQ.data === null ? null : cruce.cruzadas.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            Todavía no cargaste ninguna rendición en este período.
            {isOwnerOfActive && ' Cargá la primera con el botón de arriba.'}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {cruce.cruzadas.map((r) => {
              const cuadra = Math.abs(r.diferencia) < 0.01;
              return (
                <div key={r.id} className="px-5 py-3">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-mono tabular-nums font-semibold">{r.fecha}</span>
                        {r.responsable && (
                          <span className="text-muted-foreground text-xs">· {r.responsable}</span>
                        )}
                        {cuadra && r.duplicados.length === 0 ? (
                          <span className="inline-flex items-center gap-1 text-[10px] text-success">
                            <CheckCircle2 size={11} /> cuadra
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] text-warning">
                            <AlertTriangle size={11} />
                            {r.duplicados.length > 0 ? 'cargo repetido' : 'no cuadra'}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground font-mono tabular-nums">
                        Retiró {formatCOP(r.monto_retirado)} · rindió {formatCOP(r.totalRendido)}
                        {!cuadra && (
                          <span className="text-warning">
                            {' '}· {r.diferencia > 0 ? 'falta' : 'de más'} {formatCOP(Math.abs(r.diferencia))}
                          </span>
                        )}
                      </div>
                      {r.items.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {r.items.map((i) => {
                            const dup = r.duplicados.some((d) => d.item.id === i.id);
                            return (
                              <span
                                key={i.id}
                                className={`text-[10px] px-2 py-0.5 rounded-md border font-mono tabular-nums ${
                                  dup
                                    ? 'border-danger/40 bg-danger/10 text-danger'
                                    : 'border-border bg-card/60 text-muted-foreground'
                                }`}
                                title={dup ? 'Este cargo ya se había pagado en una rendición anterior' : undefined}
                              >
                                {i.concepto} {formatCOP(i.monto)}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    {isOwnerOfActive && (
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          size="icon" variant="ghost" className="h-8 w-8"
                          aria-label={`Editar la rendición del ${r.fecha}`}
                          onClick={() => { setEditando(r); setDialogOpen(true); }}
                        >
                          <Pencil size={13} />
                        </Button>
                        <Button
                          size="icon" variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-danger"
                          aria-label={`Borrar la rendición del ${r.fecha}`}
                          onClick={() => {
                            if (confirm(`¿Borrar la rendición del ${r.fecha}? No se puede deshacer.`)) {
                              borrar.mutate(r.id);
                            }
                          }}
                        >
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="px-5 py-3 border-t border-border flex items-start gap-2 text-[11px] text-muted-foreground">
          <Info size={13} className="text-info shrink-0 mt-0.5" />
          <p>
            <strong className="text-foreground">Salió de la billetera</strong> lo trae solo el sync de Dropi
            (movimientos de tipo retiro). <strong className="text-foreground">Rendido</strong> es lo que cargaste
            acá con comprobante. La diferencia es plata que salió y todavía nadie justificó — no
            necesariamente falta, pero hay que poder explicarla.
          </p>
        </div>
      </section>

      <RendicionDialog open={dialogOpen} onOpenChange={setDialogOpen} editando={editando} />
    </div>
  );
}

function Cifra({ label, valor, tono }: { label: string; valor: number; tono: 'neutral' | 'ok' | 'alerta' }) {
  const color =
    tono === 'alerta' ? 'text-warning' : tono === 'ok' ? 'text-success' : 'text-foreground';
  return (
    <div className="p-5">
      <div className="hud-label mb-1.5">{label}</div>
      <div className={`text-2xl font-mono font-bold tabular-nums ${color}`}>
        {formatCOP(valor)}
      </div>
    </div>
  );
}
