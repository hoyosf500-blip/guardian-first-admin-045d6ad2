import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

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

/**
 * Calcula la GANANCIA NETA REAL desde la wallet de Dropi sumando solo
 * categorías OPERATIVAS (excluye retiros/depósitos/transferencias que
 * no afectan la ganancia, son movimientos de tesorería).
 *
 * El cálculo es client-side para no depender de migrations del RPC.
 * Hace una sola query a dropi_wallet_movements filtrando por fecha y
 * agrupa client-side por categoria.
 *
 * Formato de fecha alineado con useWalletMovements: la columna `fecha` es
 * timestamptz, así que filtramos `>= ${from}T00:00:00Z` y
 * `<= ${to}T23:59:59Z` para incluir todo el día final.
 */
export function useGananciaNetaDropi(from: string, to: string) {
  return useQuery<GananciaNetaResult>({
    queryKey: ['ganancia-neta-dropi', from, to],
    queryFn: async () => {
      const fromTs = `${from}T00:00:00Z`;
      const toTs = `${to}T23:59:59Z`;
      const { data, error } = await supabase
        .from('dropi_wallet_movements')
        .select('categoria,monto,tipo')
        .gte('fecha', fromTs)
        .lte('fecha', toTs);
      if (error) throw error;
      const desglose: DesgloseGanancia = { ...EMPTY_DESGLOSE };
      let totalEntradas = 0;
      let totalSalidas = 0;
      let count = 0;
      for (const m of data || []) {
        const monto = Math.abs(Number(m.monto) || 0);
        const cat = m.categoria as string;
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
    },
    staleTime: 60_000,
    enabled: Boolean(from && to),
  });
}
