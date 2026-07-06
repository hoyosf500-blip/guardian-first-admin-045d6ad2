import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { isRpcMissing } from '@/lib/rpcError';

// Categorías OPERATIVAS de la wallet de Dropi — son las que sí mueven la
// ganancia real del cliente. El resto (retiros, depósitos, transferencias)
// son tesorería: plata ya ganada que se mueve, no ingresa ni egresa de la
// operación. NO se cuentan acá.
const ENTRADAS_OPERATIVAS = [
  'ganancia_dropshipper',
  'ganancia_proveedor',
  'reembolso_flete',
  'indemnizacion',
] as const;

const SALIDAS_OPERATIVAS = [
  'flete_inicial',
  'costo_devolucion',
  'comision_referidos',
  'mantenimiento_tarjeta',
  'orden_sin_recaudo',
] as const;

export interface DesgloseGanancia {
  ganancia_dropshipper: number;
  ganancia_proveedor: number;
  reembolso_flete: number;
  indemnizacion: number;
  flete_inicial: number;
  costo_devolucion: number;
  comision_referidos: number;
  mantenimiento_tarjeta: number;
  orden_sin_recaudo: number;
}

export interface GananciaNetaResult {
  /** Total de plata que Dropi abonó al wallet en el rango (operativo) */
  total_entradas: number;
  /** Total de plata que Dropi debitó del wallet en el rango (operativo) */
  total_salidas: number;
  /** Ganancia neta = entradas - salidas. Lo que el cliente realmente ganó. */
  ganancia_neta: number;
  /** Cantidad de movimientos operativos contados */
  movimientos_count: number;
  /** Desglose por categoría — útil para el detalle de la card */
  desglose: DesgloseGanancia;
}

const EMPTY_DESGLOSE: DesgloseGanancia = {
  ganancia_dropshipper: 0,
  ganancia_proveedor: 0,
  reembolso_flete: 0,
  indemnizacion: 0,
  flete_inicial: 0,
  costo_devolucion: 0,
  comision_referidos: 0,
  mantenimiento_tarjeta: 0,
  orden_sin_recaudo: 0,
};

function num(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

/**
 * Agrega movimientos crudos del wallet en la ganancia neta operativa.
 * Función PURA — la usa el fallback (select directo, solo admin por RLS).
 * Toma valor absoluto del monto porque las salidas pueden venir negativas.
 */
export function aggregateMovements(
  data: Array<{ categoria?: string | null; monto?: number | string | null }>,
): GananciaNetaResult {
  const desglose: DesgloseGanancia = { ...EMPTY_DESGLOSE };
  let totalEntradas = 0;
  let totalSalidas = 0;
  let count = 0;
  for (const m of data || []) {
    const monto = Math.abs(num(m.monto));
    const cat = (m.categoria ?? '') as string;
    if ((ENTRADAS_OPERATIVAS as readonly string[]).includes(cat)) {
      (desglose as unknown as Record<string, number>)[cat] += monto;
      totalEntradas += monto;
      count++;
    } else if ((SALIDAS_OPERATIVAS as readonly string[]).includes(cat)) {
      (desglose as unknown as Record<string, number>)[cat] += monto;
      totalSalidas += monto;
      count++;
    }
  }
  return {
    total_entradas: totalEntradas,
    total_salidas: totalSalidas,
    ganancia_neta: totalEntradas - totalSalidas,
    movimientos_count: count,
    desglose,
  };
}

/** Mapea la fila del RPC `wallet_ganancia_neta` al shape del hook. */
function mapRpcRow(row: Record<string, unknown>): GananciaNetaResult {
  return {
    total_entradas: num(row.total_entradas),
    total_salidas: num(row.total_salidas),
    ganancia_neta: num(row.ganancia_neta),
    movimientos_count: num(row.movimientos_count),
    desglose: {
      ganancia_dropshipper: num(row.ganancia_dropshipper),
      ganancia_proveedor: num(row.ganancia_proveedor),
      reembolso_flete: num(row.reembolso_flete),
      indemnizacion: num(row.indemnizacion),
      flete_inicial: num(row.flete_inicial),
      costo_devolucion: num(row.costo_devolucion),
      comision_referidos: num(row.comision_referidos),
      mantenimiento_tarjeta: num(row.mantenimiento_tarjeta),
      orden_sin_recaudo: num(row.orden_sin_recaudo),
    },
  };
}

/**
 * GANANCIA NETA REAL desde la wallet de Dropi (entradas − salidas operativas,
 * excluye retiros/depósitos/transferencias de tesorería).
 *
 * RPC-first: `wallet_ganancia_neta` es SECURITY DEFINER scopeado por tienda
 * (_resolve_scope_store), así un SOCIO (owner/supervisor, no admin) ve la
 * ganancia de SU tienda. Si el RPC no está desplegado todavía (pre-`db push`),
 * cae al SELECT directo — que por RLS admin-only le sirve al admin y devuelve
 * 0 a un socio (estado previo, sin romper nada).
 */
export function useGananciaNetaDropi(from: string, to: string) {
  const storeId = useActiveStoreId();
  return useQuery<GananciaNetaResult>({
    queryKey: ['ganancia-neta-dropi', storeId, from, to],
    queryFn: async () => {
      const fromTs = `${from}T00:00:00Z`;
      const toTs = `${to}T23:59:59Z`;

      // 1. RPC store-scoped (camino principal — funciona para socios).
      const { data, error } = await supabase.rpc('wallet_ganancia_neta', {
        p_from: fromTs, p_to: toTs,
      });
      if (!error) {
        // RPC corrió OK. Data con filas → resultado real. Data vacía (sin error)
        // = no hubo movimientos en el rango = $0 REAL → devolver ceros, NO caer
        // al fallback (que para un socio también daría 0, pero sin la certeza).
        if (Array.isArray(data) && data.length > 0) {
          return mapRpcRow(data[0] as Record<string, unknown>);
        }
        return aggregateMovements([]);
      }

      // El RPC dio error. SOLO si es "función no desplegada" (pre-db push) caemos
      // al fallback. Un error TRANSITORIO (throttle/timeout/permiso) NO debe
      // mostrar $0 falso — se propaga para que React Query marque isError y la
      // card avise en vez de inventar un cero (un socio creería que no ganó nada).
      if (!isRpcMissing(error)) {
        throw error;
      }

      // 2. Fallback: select directo (RPC no desplegado aún). Admin OK; socio → 0.
      const { data: movs, error: selErr } = await supabase
        .from('dropi_wallet_movements')
        .select('categoria,monto,tipo')
        .eq('store_id', storeId as string)
        .gte('fecha', fromTs)
        .lte('fecha', toTs);
      if (selErr) throw selErr;
      return aggregateMovements(movs || []);
    },
    staleTime: 60_000,
    enabled: Boolean(from && to && storeId),
  });
}
