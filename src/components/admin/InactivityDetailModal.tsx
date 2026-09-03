import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { X, Loader2, AlertTriangle } from 'lucide-react';

// Popup que abre la celda "Advert. inact." de Productividad: detalle de CADA
// aviso de inactividad de una operadora en el período (número, minutos inactiva,
// hora). Lee admin_inactivity_details (store-scoped — CO/EC nunca se mezclan).

type Range = 'today' | '7d' | '30d';

interface InactivityDetail {
  numero: number;
  lost_seconds: number;
  warning_date: string; // YYYY-MM-DD
  hora: string | null;  // timestamptz ISO
}

const RANGE_LABEL: Record<Range, string> = {
  today: 'hoy',
  '7d': 'últimos 7 días',
  '30d': 'últimos 30 días',
};

function fmtHora(ts: string | null) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Bogota', // pin a hora Bogotá (CO/EC = UTC-5)
  });
}

export default function InactivityDetailModal({
  operadora,
  operatorId,
  range,
  onClose,
}: {
  /** Solo para el TÍTULO del modal — la búsqueda va por `operatorId`. */
  operadora: string;
  /** operator_id real: el MISMO id con el que la tabla contó los avisos.
   *
   *  ⛔ HOY NO SE USA PARA BUSCAR, y el motivo importa. La función desplegada
   *  `admin_inactivity_details` acepta `(p_operadora, p_range, p_store_id)` —
   *  confirmado en `types.ts`, que se genera de la base viva. El cliente venía
   *  intentando primero una firma con `p_operator_id` que NUNCA EXISTIÓ en
   *  ninguna migración: cada apertura del modal gastaba un viaje que siempre
   *  fallaba con PGRST202 antes de caer al camino por nombre.
   *
   *  Se sacó el intento muerto en vez de escribir la migración porque reescribir
   *  una función SQL desplegada es exactamente lo que prohíbe la REGLA #1. El
   *  arreglo de fondo —buscar por id— necesita una migración propia con el
   *  `pg_get_functiondef` de la versión que está corriendo delante.
   *
   *  Mientras tanto, la búsqueda por nombre no se deja mentir: sin nombre en el
   *  perfil, el modal lo dice en vez de traer los avisos de otra persona. */
  operatorId?: string | null;
  range: Range;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<InactivityDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const storeId = useActiveStoreId();

  useEffect(() => {
    let active = true;
    // El cast va INLINE sobre supabase.rpc (no extraído a variable): asignarlo
    // pierde el `this` del cliente (memoria rpc_supabase_binding_pattern).
    const call = (args: { p_operadora: string; p_range: string; p_store_id: string | null }) =>
      (supabase.rpc as unknown as (
        fn: 'admin_inactivity_details',
        a: typeof args,
      ) => Promise<{ data: InactivityDetail[] | null; error: { code?: string; message?: string } | null }>)(
        'admin_inactivity_details',
        args,
      );
    void (async () => {
      // ⛔ SIN NOMBRE NO SE BUSCA (3-sep-2026). La función desplegada solo acepta
      // `p_operadora` —el NOMBRE—, así que con el nombre vacío o el marcador
      // "Sin nombre" esta consulta traería los avisos de CUALQUIERA que también
      // esté sin nombre. Mostrarle al dueño los avisos de otra persona bajo este
      // título es peor que no mostrar nada: sobre esto se habla con alguien.
      const nombre = (operadora || '').trim();
      if (!nombre || /^sin nombre$/i.test(nombre)) {
        setError('Esta persona no tiene nombre en su perfil, y el detalle se busca por nombre: no puedo asegurar que estos avisos sean suyos. Ponele el nombre en su perfil y volvé a abrirlo.');
        setRows([]);
        return;
      }
      const resp = await call({ p_operadora: nombre, p_range: range, p_store_id: storeId });
      if (!active) return;
      if (resp.error) { setError(resp.error.message ?? 'Error'); setRows([]); }
      else { setRows(resp.data ?? []); }
    })();
    return () => { active = false; };
  }, [operadora, operatorId, range, storeId]);

  // Cerrar con Escape (estándar role="dialog").
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[2000] bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="inactivity-detail-title"
    >
      <div
        className="bg-card rounded-3xl border border-border w-full max-w-[480px] max-h-[80vh] flex flex-col shadow-card3d-lg hairline-top"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle size={16} className="text-warning shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <h3 id="inactivity-detail-title" className="text-sm font-bold text-foreground truncate">
                Avisos de inactividad · {operadora}
              </h3>
              <p className="text-xs text-muted-foreground">
                {RANGE_LABEL[range]}
                {rows ? ` · ${rows.length} ${rows.length === 1 ? 'aviso' : 'avisos'}` : ''}
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
            <div className="bg-danger/10 border border-danger/30 text-danger rounded-lg px-3 py-2 text-xs font-mono break-all">
              {error}
            </div>
          )}

          {rows && rows.length === 0 && !error && (
            <p className="text-center text-sm text-muted-foreground py-10">
              No hay avisos de inactividad para esta operadora en este período.
            </p>
          )}

          {rows && rows.length > 0 && (
            <ul className="space-y-2">
              {rows.map((r) => {
                const mins = Math.round(r.lost_seconds / 60);
                return (
                  <li
                    key={`${r.warning_date}-${r.numero}`}
                    className="rounded-xl border border-border bg-card/40 px-4 py-3 flex items-center justify-between gap-4"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className="shrink-0 h-7 w-7 rounded-full bg-warning/15 text-warning text-xs font-bold flex items-center justify-center tabular-nums"
                        aria-hidden="true"
                      >
                        {r.numero}
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-foreground">
                          Aviso {r.numero}
                          {range !== 'today' && (
                            <span className="ml-1.5 text-[11px] text-muted-foreground font-normal">· {r.warning_date}</span>
                          )}
                        </div>
                        <div className="text-xs text-danger font-mono font-bold">
                          {mins < 1 ? 'menos de 1 min' : `${mins} min`} inactiva
                        </div>
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground font-mono tabular-nums whitespace-nowrap">
                      {fmtHora(r.hora)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
