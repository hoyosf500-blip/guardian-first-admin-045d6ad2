import { useMemo, useState } from 'react';
import {
  CheckCircle2, AlertCircle, Loader2, CreditCard, Calendar,
  Calculator, TrendingDown, Zap, AlertTriangle,
} from 'lucide-react';
import {
  usePersonalPaymentsList, usePersonalResidualDebt,
} from '@/hooks/usePersonalCardMovements';
import { formatCOP } from '@/lib/utils';

// Calcula el interés total que pagarías si dejás la deuda en 36 cuotas
// al 25.5% EA. Aproximación: saldo promedio durante la vida del crédito
// es capital/2 (para n cuotas iguales). Interés ≈ capital × 0.5 × tiempo × tasa.
//
// Para 36 cuotas a 25.5% EA → tiempo promedio = 1.5 años → factor 0.5×1.5×0.255 = 0.191.
// Esto es conservador (no compone) pero da orden de magnitud realista.
const INTEREST_FACTOR_36_CUOTAS = 0.191;

// Cuadro grande de 2 columnas: a la izquierda historial cronológico
// de pagos hechos, a la derecha desglose de deuda pendiente. Es la vista
// más simple del bloque "tarjetas personales" — para responder
// "cuánto pagué y cuánto debo" sin tener que leer la tabla detallada.

function fmtFecha(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

interface Props {
  /** Saldo actual del wallet de Dropi (COP). null = no disponible aún. */
  walletDisponible?: number | null;
}

export default function CfoPagosHistorico({ walletDisponible = null }: Props) {
  const [trm, setTrm] = useState<number>(3800);
  // La TRM arranca en un valor SUPUESTO (3800): nadie la midió, no viene de
  // ninguna fuente, es el valor inicial del useState. Mientras el usuario no la
  // fije a mano, todo total que mezcle dólares es una CONVERSIÓN estimada y no
  // un saldo verificado — se marca con "≈" + nota en vez de mostrarse como
  // cifra dura. Si todo está en COP la TRM no toca nada y la cifra sí es dura.
  const [trmFijada, setTrmFijada] = useState<boolean>(false);
  const [pagoSimulado, setPagoSimulado] = useState<number>(0);

  const paymentsQuery = usePersonalPaymentsList();
  const residualQuery = usePersonalResidualDebt();

  const pagos = paymentsQuery.data ?? [];
  const residual = residualQuery.data ?? [];

  const totalPagadoCop = useMemo(
    () => pagos.reduce((acc, p) => acc + (p.moneda === 'USD' ? p.monto * trm : p.monto), 0),
    [pagos, trm],
  );

  const totalFaltaCop = useMemo(
    () => residual.reduce((acc, r) => acc + (r.moneda === 'USD' ? r.saldo_pendiente * trm : r.saldo_pendiente), 0),
    [residual, trm],
  );

  // Porción en dólares de cada lado: es la que depende de la TRM.
  const usdPagado = useMemo(
    () => pagos.reduce((acc, p) => acc + (p.moneda === 'USD' ? p.monto : 0), 0),
    [pagos],
  );
  const usdFalta = useMemo(
    () => residual.reduce((acc, r) => acc + (r.moneda === 'USD' ? r.saldo_pendiente : 0), 0),
    [residual],
  );
  const pagadoEsEstimado = usdPagado > 0 && !trmFijada;
  const faltaEsEstimado = usdFalta > 0 && !trmFijada;

  const notaTrm = (usd: number) =>
    `Incluye USD ${usd.toFixed(2)} convertido a TRM ${trm.toLocaleString('es-CO')}`
    + (trmFijada ? ' (fijada a mano).' : ' — tasa supuesta, nadie la verificó.');

  // ─── Calculadora de pago ────────────────────────────────────────
  // El user pidió saber: si pago $X de un golpe, cuánto baja la deuda
  // y cuánto interés ahorro (vs dejar las 36 cuotas a 25.5% EA).
  const pagoCapped = Math.min(Math.max(pagoSimulado, 0), totalFaltaCop);
  const deudaRestante = Math.max(totalFaltaCop - pagoCapped, 0);
  const interesAhorrado = pagoCapped * INTEREST_FACTOR_36_CUOTAS;
  const pctLiquidado = totalFaltaCop > 0 ? (pagoCapped / totalFaltaCop) * 100 : 0;
  const interesTotalSiDejara = totalFaltaCop * INTEREST_FACTOR_36_CUOTAS;
  const faltaParaLiquidar = walletDisponible != null
    ? Math.max(totalFaltaCop - walletDisponible, 0)
    : null;

  if (paymentsQuery.isLoading || residualQuery.isLoading) {
    return (
      <div className="rounded-2xl border border-border bg-card/40 shadow-card3d p-6 flex items-center justify-center gap-2 text-muted-foreground">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-sm">Cargando histórico…</span>
      </div>
    );
  }

  // Si la consulta FALLA los hooks caen a [] y el bloque mostraría "$0 pagado /
  // $0 pendiente" o el cartel "Aún no hay datos, subí los extractos" — o sea,
  // un error de lectura disfrazado de "no debés nada" / "no cargaste nada".
  // Basta que UNA de las dos falle: media pantalla en $0 miente igual.
  if (paymentsQuery.isError || residualQuery.isError) {
    const err = (paymentsQuery.error ?? residualQuery.error) as Error | null;
    return (
      <div className="rounded-2xl border border-danger/40 bg-danger/5 p-6 shadow-card3d">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="text-danger shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-danger">
              No pudimos cargar el histórico de pagos
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              {err?.message ?? 'Error desconocido'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              No mostramos totales para no dar una cifra que nadie pudo leer.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // React Query v5: si la consulta quedó PAUSADA (sin conexión — networkMode
  // 'online' por defecto) el estado es status='pending' + fetchStatus='paused',
  // o sea isLoading FALSE e isError FALSE, pero `data` sigue undefined y el
  // `?? []` la vuelve lista vacía. Sin este corte se caía al empty state y la
  // pantalla afirmaba "Aún no hay datos, subí los extractos" encima de una deuda
  // real que sólo no se pudo leer.
  // OJO: `data === undefined` es "nunca resolvió"; `data === []` es un cero
  // MEDIDO (la consulta respondió y no hay filas) y sigue su curso normal.
  if (paymentsQuery.data === undefined || residualQuery.data === undefined) {
    return (
      <div className="rounded-2xl border border-border bg-card/40 p-6 shadow-card3d">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="text-muted-foreground shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Histórico de pagos sin cargar
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              La consulta quedó pendiente, normalmente por falta de conexión. No es que no haya datos: no los pudimos leer.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              No mostramos totales para no dar una cifra que nadie pudo leer.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (pagos.length === 0 && residual.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card/40 p-8 text-center text-sm text-muted-foreground">
        Aún no hay datos. Subí los extractos PDF de las TC en el bloque de arriba.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card/40 shadow-card3d overflow-hidden">
      <div className="px-4 py-3.5 border-b border-border flex items-center justify-between gap-2 flex-wrap">
        <h3 className="font-semibold text-sm">Cuánto pagué · Cuánto me falta</h3>
        <div className="flex items-center gap-2 text-xs">
          <label className="text-muted-foreground">TRM:</label>
          <input
            type="number"
            value={trm}
            onChange={e => {
              const v = Number(e.target.value);
              setTrm(v || 3800);
              // Solo cuenta como "fijada" si quedó un número usable; si borra el
              // campo volvemos al supuesto 3800 y a marcar los totales como ≈.
              setTrmFijada(Number.isFinite(v) && v > 0);
            }}
            min={1000} max={10000} step={10}
            className="w-20 bg-card/40 border border-border rounded-lg px-2 py-1 text-xs font-mono tabular-nums hover:border-border-strong transition-colors"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border">

        {/* ═══ COLUMNA IZQUIERDA: lo pagado ═══ */}
        <div className="bg-success/[0.06]">
          <div className="px-4 py-4 border-b border-border/50">
            <div className="flex items-center gap-2 hud-label text-success mb-1.5">
              <CheckCircle2 size={14} /> YA PAGUÉ
            </div>
            <div className="text-3xl font-bold text-success font-mono tabular-nums">
              {pagadoEsEstimado ? '≈ ' : ''}{formatCOP(totalPagadoCop)}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              en {pagos.length} pago{pagos.length === 1 ? '' : 's'} hecho{pagos.length === 1 ? '' : 's'}
            </div>
            {usdPagado > 0 && (
              <div className="text-[11px] text-muted-foreground mt-1">
                {notaTrm(usdPagado)}
              </div>
            )}
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {pagos.length === 0 ? (
              <div className="px-4 py-6 text-xs text-muted-foreground text-center">
                Sin pagos registrados
              </div>
            ) : (
              <ul className="divide-y divide-border/50">
                {pagos.map(p => (
                  <li key={p.id} className="px-4 py-2.5 flex items-start justify-between gap-2 text-xs hover:bg-success/10 transition-colors">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <Calendar size={11} className="text-muted-foreground shrink-0" />
                        <span className="text-muted-foreground font-mono tabular-nums">{fmtFecha(p.fecha)}</span>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-muted-foreground">{p.tarjeta}</span>
                      </div>
                      <div className="text-foreground truncate mt-0.5" title={p.descripcion}>
                        {p.descripcion}
                      </div>
                    </div>
                    <div className="text-right font-mono tabular-nums shrink-0">
                      <div className="font-semibold text-success">
                        {p.moneda === 'USD' ? `USD ${p.monto.toFixed(2)}` : formatCOP(p.monto)}
                      </div>
                      {p.moneda === 'USD' && (
                        <div className="text-[10px] text-muted-foreground">
                          ≈ {formatCOP(p.monto * trm)}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* ═══ COLUMNA DERECHA: lo que falta ═══ */}
        <div className="bg-danger/[0.06]">
          <div className="px-4 py-4 border-b border-border/50">
            <div className="flex items-center gap-2 hud-label text-danger mb-1.5">
              <AlertCircle size={14} /> ME FALTA
            </div>
            <div className="text-3xl font-bold text-danger font-mono tabular-nums">
              {faltaEsEstimado ? '≈ ' : ''}{formatCOP(totalFaltaCop)}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              en cuotas diferidas pendientes
            </div>
            {usdFalta > 0 && (
              <div className="text-[11px] text-muted-foreground mt-1">
                {notaTrm(usdFalta)}
              </div>
            )}
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {residual.length === 0 ? (
              <div className="px-4 py-6 text-xs text-muted-foreground text-center">
                🎉 Sin deuda residual — estás al día
              </div>
            ) : (
              <ul className="divide-y divide-border/50">
                {residual.map(r => (
                  <li key={`${r.tarjeta}-${r.moneda}`} className="px-4 py-3 hover:bg-danger/10 transition-colors">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="flex items-center gap-1.5 text-xs">
                        <CreditCard size={11} className="text-muted-foreground" />
                        <span className="font-medium">{r.tarjeta}</span>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-muted-foreground capitalize">{r.marca}</span>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-muted-foreground">{r.moneda}</span>
                      </div>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">
                        {r.num_compras} compra{r.num_compras === 1 ? '' : 's'} a cuotas
                      </span>
                      <div className="text-right font-mono tabular-nums">
                        <div className="font-semibold text-danger">
                          {r.moneda === 'USD' ? `USD ${r.saldo_pendiente.toFixed(2)}` : formatCOP(r.saldo_pendiente)}
                        </div>
                        {r.moneda === 'USD' && (
                          <div className="text-[10px] text-muted-foreground">
                            ≈ {formatCOP(r.saldo_pendiente * trm)}
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ─── Calculadora de pago ─────────────────────────────── */}
          {totalFaltaCop > 0 && (
            <div className="border-t border-border/50 bg-background/50 px-4 py-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <Calculator size={13} className="text-accent" />
                <span>Calculadora de pago</span>
              </div>

              <div className="text-[11px] text-muted-foreground -mt-1">
                Si dejás todo en 36 cuotas al 25.5% EA pagás{' '}
                <strong className="text-warning font-mono tabular-nums">+{formatCOP(interesTotalSiDejara)}</strong> de interés.
                <span className="block mt-0.5">
                  Proyección propia (interés simple sobre saldo promedio), no una cotización del banco.
                </span>
              </div>

              {walletDisponible != null && (
                <div className="flex items-center justify-between text-xs bg-foreground/[0.04] border border-border rounded-lg px-2.5 py-2">
                  <span className="text-muted-foreground">Wallet Dropi disponible:</span>
                  <span className="font-mono tabular-nums font-medium">{formatCOP(walletDisponible)}</span>
                </div>
              )}

              {faltaParaLiquidar != null && faltaParaLiquidar > 0 && (
                <div className="flex items-center justify-between text-xs bg-warning/[0.1] border border-warning/30 rounded-lg px-2.5 py-2">
                  <span className="text-warning">Falta acumular:</span>
                  <span className="font-mono tabular-nums font-semibold text-warning">
                    {faltaEsEstimado ? '≈ ' : ''}{formatCOP(faltaParaLiquidar)}
                  </span>
                </div>
              )}
              {/* El veredicto compara el wallet REAL contra una deuda que, si hay
                  dólares y nadie fijó la TRM, está convertida a una tasa supuesta.
                  En ese caso se muestra en tono neutro: no es un "estás cubierto"
                  verificado, es una comparación contra un número estimado. */}
              {faltaParaLiquidar === 0 && (
                <div className={faltaEsEstimado
                  ? 'text-xs bg-foreground/[0.04] border border-border rounded-lg px-2.5 py-2 text-muted-foreground font-medium'
                  : 'text-xs bg-success/[0.1] border border-success/30 rounded-lg px-2.5 py-2 text-success font-semibold'}>
                  ✓ Tenés cash en wallet para liquidar todo
                  {faltaEsEstimado && (
                    <span className="block font-normal mt-0.5">
                      Estimado: la deuda en dólares se comparó a una TRM supuesta. Fijá la TRM para confirmarlo.
                    </span>
                  )}
                </div>
              )}

              {/* Input de pago simulado */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label className="text-muted-foreground">Voy a pagar:</label>
                  <input
                    type="number"
                    value={pagoSimulado || ''}
                    onChange={e => setPagoSimulado(Number(e.target.value) || 0)}
                    placeholder="0"
                    min={0} max={totalFaltaCop} step={100000}
                    className="w-32 bg-card/40 border border-border rounded-lg px-2 py-1 text-xs font-mono tabular-nums text-right hover:border-border-strong transition-colors"
                  />
                </div>
                <input
                  type="range"
                  value={pagoCapped}
                  onChange={e => setPagoSimulado(Number(e.target.value))}
                  min={0} max={Math.ceil(totalFaltaCop)} step={100000}
                  className="w-full accent-success"
                />
                <div className="flex justify-end gap-1">
                  <button
                    onClick={() => setPagoSimulado(totalFaltaCop)}
                    className="text-[11px] text-accent hover:underline"
                  >
                    Pagar TODO
                  </button>
                  {walletDisponible != null && walletDisponible > 0 && (
                    <>
                      <span className="text-[11px] text-muted-foreground">·</span>
                      <button
                        onClick={() => setPagoSimulado(Math.min(walletDisponible, totalFaltaCop))}
                        className="text-[11px] text-accent hover:underline"
                      >
                        Usar wallet
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Resultados */}
              {pagoCapped > 0 && (
                <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                  <div className="rounded-2xl border border-danger/30 bg-danger/[0.07] p-2.5 shadow-card3d">
                    <div className="hud-label text-muted-foreground">Deuda restante</div>
                    <div className="font-mono tabular-nums font-semibold text-danger mt-1">
                      {faltaEsEstimado ? '≈ ' : ''}{formatCOP(deudaRestante)}
                    </div>
                    <div className="text-[10px] font-mono tabular-nums text-muted-foreground mt-0.5">
                      {pctLiquidado.toFixed(0)}% liquidado
                    </div>
                  </div>
                  <div className="rounded-2xl border border-success/30 bg-success/[0.07] p-2.5 shadow-card3d">
                    <div className="hud-label text-muted-foreground">Interés ahorrado</div>
                    <div className="font-mono tabular-nums font-semibold text-success mt-1">
                      {formatCOP(interesAhorrado)}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      vs dejar 36 cuotas · estimado
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
