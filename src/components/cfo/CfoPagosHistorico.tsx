import { useMemo, useState } from 'react';
import {
  CheckCircle2, AlertCircle, Loader2, CreditCard, Calendar,
} from 'lucide-react';
import {
  usePersonalPaymentsList, usePersonalResidualDebt,
} from '@/hooks/usePersonalCardMovements';
import { formatCOP } from '@/lib/utils';

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

export default function CfoPagosHistorico() {
  const [trm, setTrm] = useState<number>(3800);

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

  if (paymentsQuery.isLoading || residualQuery.isLoading) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 flex items-center justify-center gap-2 text-muted-foreground">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-sm">Cargando histórico…</span>
      </div>
    );
  }

  if (pagos.length === 0 && residual.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
        Aún no hay datos. Subí los extractos PDF de las TC en el bloque de arriba.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2 flex-wrap">
        <h3 className="font-semibold text-sm">Cuánto pagué · Cuánto me falta</h3>
        <div className="flex items-center gap-2 text-xs">
          <label className="text-muted-foreground">TRM:</label>
          <input
            type="number"
            value={trm}
            onChange={e => setTrm(Number(e.target.value) || 3800)}
            min={1000} max={10000} step={10}
            className="w-20 bg-background border border-border rounded px-2 py-1 text-xs tabular-nums"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border">

        {/* ═══ COLUMNA IZQUIERDA: lo pagado ═══ */}
        <div className="bg-green/5">
          <div className="px-4 py-4 border-b border-border/50">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-green font-semibold mb-1">
              <CheckCircle2 size={14} /> YA PAGUÉ
            </div>
            <div className="text-2xl font-bold text-green tabular-nums">
              {formatCOP(totalPagadoCop)}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              en {pagos.length} pago{pagos.length === 1 ? '' : 's'} hecho{pagos.length === 1 ? '' : 's'}
            </div>
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {pagos.length === 0 ? (
              <div className="px-4 py-6 text-xs text-muted-foreground text-center">
                Sin pagos registrados
              </div>
            ) : (
              <ul className="divide-y divide-border/50">
                {pagos.map(p => (
                  <li key={p.id} className="px-4 py-2 flex items-start justify-between gap-2 text-xs hover:bg-green/5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <Calendar size={11} className="text-muted-foreground shrink-0" />
                        <span className="text-muted-foreground tabular-nums">{fmtFecha(p.fecha)}</span>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-muted-foreground">{p.tarjeta}</span>
                      </div>
                      <div className="text-foreground truncate mt-0.5" title={p.descripcion}>
                        {p.descripcion}
                      </div>
                    </div>
                    <div className="text-right tabular-nums shrink-0">
                      <div className="font-semibold text-green">
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
        <div className="bg-red/5">
          <div className="px-4 py-4 border-b border-border/50">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-red font-semibold mb-1">
              <AlertCircle size={14} /> ME FALTA
            </div>
            <div className="text-2xl font-bold text-red tabular-nums">
              {formatCOP(totalFaltaCop)}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              en cuotas diferidas pendientes
            </div>
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {residual.length === 0 ? (
              <div className="px-4 py-6 text-xs text-muted-foreground text-center">
                🎉 Sin deuda residual — estás al día
              </div>
            ) : (
              <ul className="divide-y divide-border/50">
                {residual.map(r => (
                  <li key={`${r.tarjeta}-${r.moneda}`} className="px-4 py-3 hover:bg-red/5">
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
                      <div className="text-right tabular-nums">
                        <div className="font-semibold text-red">
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
        </div>
      </div>
    </div>
  );
}
