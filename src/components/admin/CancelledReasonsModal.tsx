import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { X, Loader2, XCircle } from 'lucide-react';

// Popup que abre la celda "Cancelados" de Reportes diarios: muestra el detalle
// (cliente, teléfono, MOTIVO, hora, ANTIGÜEDAD) de las cancelaciones de una
// operadora en una fecha. Lee la RPC admin_cancelled_details (store-scoped,
// admin/manager-only). La antigüedad distingue pedido NUEVO (fresco) vs ARRASTRE.

interface CancelledDetail {
  external_id: string | null;
  nombre: string | null;
  phone: string | null;
  reason: string;
  hora: string | null;
  module: string | null;
  order_fecha: string | null; // YYYY-MM-DD o null si la fecha del pedido es inválida
  dias: number | null;        // antigüedad en días calendario al cancelar, null si desconocida
}

// Traduce la antigüedad (días) a una etiqueta legible: NUEVO (fresco) vs ARRASTRE.
// fresh=true → cancelar esto es la señal que el dueño quiere ver (pedido reciente).
function ageBadge(d: number | null): { label: string; fresh: boolean | null } {
  if (d == null) return { label: 'antigüedad desconocida', fresh: null };
  if (d <= 0) return { label: 'nuevo · hoy', fresh: true };
  if (d === 1) return { label: 'nuevo · ayer', fresh: true };
  return { label: `arrastre · hace ${d} días`, fresh: false };
}

export default function CancelledReasonsModal({
  operadora,
  fecha,
  onClose,
}: {
  operadora: string;
  fecha: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<CancelledDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const storeId = useActiveStoreId();

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data, error: rpcErr } = await (supabase.rpc as unknown as (
        fn: 'admin_cancelled_details',
        args: { p_operadora: string; p_fecha: string; p_store_id: string | null },
      ) => Promise<{ data: CancelledDetail[] | null; error: { message?: string } | null }>)(
        'admin_cancelled_details',
        { p_operadora: operadora, p_fecha: fecha, p_store_id: storeId },
      );
      if (!active) return;
      if (rpcErr) { setError(rpcErr.message ?? 'Error'); setRows([]); }
      else { setRows(data ?? []); }
    })();
    return () => { active = false; };
  }, [operadora, fecha, storeId]);

  // Cerrar con Escape (estándar role="dialog").
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const fmtHora = (h: string | null) =>
    h
      ? new Date(h).toLocaleTimeString('es-CO', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
          timeZone: 'America/Bogota', // pin a hora Bogotá (CO/EC = UTC-5) sin importar el SO del cliente
        })
      : '';

  return (
    <div
      className="fixed inset-0 z-[2000] bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-reasons-title"
    >
      <div
        className="bg-card rounded-3xl border border-border w-full max-w-[560px] max-h-[80vh] flex flex-col shadow-card3d-lg hairline-top"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <XCircle size={16} className="text-red shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <h3 id="cancel-reasons-title" className="text-sm font-bold text-foreground truncate">Cancelaciones · {operadora}</h3>
              <p className="text-xs text-muted-foreground">
                {fecha}
                {rows ? ` · ${rows.length} ${rows.length === 1 ? 'cancelación' : 'cancelaciones'}` : ''}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 inline-flex items-center justify-center rounded-lg hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label="Cerrar"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {rows === null && !error && (
            <div className="flex items-center justify-center py-10">
              <Loader2 size={20} className="animate-spin text-muted-foreground" aria-hidden="true" />
            </div>
          )}

          {error && (
            <div className="bg-red/10 border border-red/30 text-red rounded-lg px-3 py-2 text-xs font-mono break-all">
              {error}
            </div>
          )}

          {rows && rows.length === 0 && !error && (
            <p className="text-center text-sm text-muted-foreground py-10">
              No hay cancelaciones con motivo registrado para esta operadora en esta fecha.
            </p>
          )}

          {rows && rows.length > 0 && (() => {
            // ageBadge una sola vez por fila (lo reusan el resumen y cada <li>).
            const ages = rows.map((r) => ageBadge(r.dias));
            const nuevos = ages.filter((a) => a.fresh === true).length;
            const arrastre = ages.filter((a) => a.fresh === false).length;
            const desconocidos = ages.length - nuevos - arrastre;
            return (
              <>
                {/* Resumen rápido: cuántos cancelados eran frescos vs cola vieja. */}
                <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
                  {nuevos > 0 && (
                    <span className="font-bold px-2 py-0.5 rounded-full bg-red/15 text-red">
                      {nuevos} {nuevos === 1 ? 'nuevo' : 'nuevos'}
                    </span>
                  )}
                  {arrastre > 0 && (
                    <span className="font-bold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                      {arrastre} arrastre
                    </span>
                  )}
                  {desconocidos > 0 && (
                    <span className="font-bold px-2 py-0.5 rounded-full bg-muted/50 text-muted-foreground">
                      {desconocidos} sin fecha
                    </span>
                  )}
                </div>
                <ul className="space-y-2">
                  {rows.map((r, i) => {
                    const age = ages[i];
                    return (
                      <li key={r.external_id ?? i} className="rounded-xl border border-border bg-card/40 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-foreground truncate">{r.nombre || '(sin nombre)'}</div>
                            <div className="text-xs text-muted-foreground font-mono truncate">
                              {r.phone || ''}{r.external_id ? ` · #${r.external_id}` : ''}
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-1 shrink-0">
                            <span className="text-[11px] text-muted-foreground whitespace-nowrap">{fmtHora(r.hora)}</span>
                            <span
                              className={
                                'text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap ' +
                                (age.fresh === true
                                  ? 'bg-red/15 text-red'              // pedido fresco cancelado → ojo
                                  : age.fresh === false
                                    ? 'bg-muted text-muted-foreground' // arrastre, menos preocupante
                                    : 'bg-muted/50 text-muted-foreground')
                              }
                              title={r.order_fecha ? `Creado: ${r.order_fecha}` : 'Sin fecha de creación confiable'}
                            >
                              {age.label}
                            </span>
                          </div>
                        </div>
                        <div className="mt-2 text-sm text-red font-medium">{r.reason}</div>
                      </li>
                    );
                  })}
                </ul>
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
