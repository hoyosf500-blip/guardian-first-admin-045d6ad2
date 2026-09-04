import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { bogotaDayBounds } from '@/lib/bogotaDayBounds';

export interface WalletMovement {
  id: number;
  dropi_transaction_id: number;
  fecha: string;
  tipo: 'ENTRADA' | 'SALIDA' | string;
  codigo: string | null;
  categoria: string | null;
  monto: number;
  monto_previo: number | null;
  saldo_despues: number | null;
  descripcion: string | null;
  cuenta: string | null;
  concepto_retiro: string | null;
  related_order_id: string | null;
}

export interface UseWalletMovementsParams {
  fromDate: string; // YYYY-MM-DD
  toDate: string;   // YYYY-MM-DD
  tipo?: 'ENTRADA' | 'SALIDA' | 'ALL';
  categoria?: string | 'ALL';
  page?: number;
  pageSize?: number;
}

export interface WalletMovementsResult {
  rows: WalletMovement[];
  total: number;
  ultimoSaldo: number | null;
  totalEntradas: number;
  totalSalidas: number;
  countTotal: number;
  categorias: string[];
  /** true = los agregados SÍ respetan Tipo y Categoría. false = la función
   *  filtrada todavía no está aplicada y las cifras son del rango completo.
   *  La pantalla tiene que decirlo: una tarjeta que dice $12.607 con "Salida"
   *  puesto no es un número aproximado, es un número de otra pregunta. */
  agregadosFiltrados: boolean;
}

// COST-2 (2026-04-29): los agregados se calculan server-side vía RPC
// `wallet_summary` en vez de traer hasta 10.000 filas al navegador.
// staleTime alto: los movimientos solo cambian al pulsar "Sincronizar".

export function useWalletMovements(params: UseWalletMovementsParams) {
  const { fromDate, toDate, tipo = 'ALL', categoria = 'ALL', page = 1, pageSize = 20 } = params;
  // La billetera es por tienda (cada tienda = cuenta Dropi distinta). Filtramos
  // la query directa por store_id; los agregados (wallet_summary RPC) ya se
  // scopean server-side vía _resolve_scope_store().
  const storeId = useActiveStoreId();

  return useQuery<WalletMovementsResult>({
    queryKey: ['wallet_movements', storeId, fromDate, toDate, tipo, categoria, page, pageSize],
    queryFn: async () => {
      // Corte de día en hora Bogotá (antes 'Z' = UTC corría el corte 5h).
      const { fromTs, toTs } = bogotaDayBounds(fromDate, toDate);

      // 1. Página filtrada (con count exacto) — solo trae las N filas visibles
      let q = supabase
        .from('dropi_wallet_movements')
        .select('*', { count: 'exact' })
        .eq('store_id', storeId as string)
        .gte('fecha', fromTs)
        .lte('fecha', toTs)
        .order('fecha', { ascending: false });

      if (tipo !== 'ALL') q = q.eq('tipo', tipo);
      if (categoria !== 'ALL') q = q.eq('categoria', categoria);

      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      q = q.range(from, to);

      const { data, error, count } = await q;
      if (error) throw error;

      // 2. Agregados via RPC (Postgres devuelve 1 fila, no 10.000)
      //
      // ⛔ 4-sep-2026: acá se llamaba a `wallet_summary(p_from, p_to)` SIN los
      // filtros, mientras la consulta de arriba SÍ los aplicaba. Con "Tipo:
      // Salida" puesto la tabla mostraba 276 movimientos de agosto en Ecuador y
      // las tarjetas seguían diciendo $12.607,01 de entradas y 943 movimientos.
      // La función vieja ni acepta los parámetros (`p_tipo` → PGRST202), así que
      // el arreglo es una función NUEVA (20260904190000) — la vieja no se toca.
      type Agg = {
        total_entradas?: number; total_salidas?: number; count_total?: number;
        ultimo_saldo?: number | null; categorias?: string[] | null;
      };
      let agg: Agg = {};
      let agregadosFiltrados = true;

      // `types.ts` se autogenera del esquema y todavía no conoce la función
      // nueva. Mismo molde EXACTO que useInboxEsperando: el cast se aplica en
      // la llamada, dentro de una flecha. Guardar `supabase.rpc` en una variable
      // pierde el `this` (memoria rpc_supabase_binding_pattern, y el guardián
      // rpcBinding.test.ts lo atrapa); llamarlo inline lo conserva.
      const rpc = (fn: string, args: Record<string, unknown>) =>
        (supabase.rpc as unknown as (f: string, a: Record<string, unknown>) =>
          Promise<{ data: Agg[] | null; error: { code?: string; message?: string } | null }>)(fn, args);

      const filtrada = await rpc('wallet_summary_filtrado', {
        p_from: fromTs,
        p_to: toTs,
        p_tipo: tipo === 'ALL' ? null : tipo,
        p_categoria: categoria === 'ALL' ? null : categoria,
      });

      if (filtrada.error) {
        // La función todavía no está aplicada: se sigue con la vieja para no
        // dejar la pantalla en negro, pero se AVISA que no respeta el filtro.
        // Mismo respaldo que useEstadoBreakdown, así el orden de publicación
        // (frontend antes que SQL) deja de importar.
        const noExiste = filtrada.error.code === 'PGRST202'
          || /does not exist|schema cache/i.test(filtrada.error.message ?? '');
        if (!noExiste) throw filtrada.error;
        agregadosFiltrados = false;
        const { data: viejo, error: aggError } = await supabase.rpc('wallet_summary', {
          p_from: fromTs,
          p_to: toTs,
        });
        if (aggError) throw aggError;
        agg = (viejo?.[0] ?? {}) as Agg;
      } else {
        agg = (filtrada.data?.[0] ?? {}) as Agg;
      }

      return {
        rows: (data as WalletMovement[]) ?? [],
        total: count ?? 0,
        ultimoSaldo: agg.ultimo_saldo ?? null,
        totalEntradas: Number(agg.total_entradas ?? 0),
        totalSalidas: Number(agg.total_salidas ?? 0),
        countTotal: Number(agg.count_total ?? 0),
        categorias: (agg.categorias ?? []).slice().sort(),
        agregadosFiltrados,
      };
    },
    enabled: Boolean(storeId),      // espera a conocer la tienda activa
    staleTime: 5 * 60 * 1000,       // 5 min — datos solo cambian al sincronizar
    refetchOnWindowFocus: false,    // no re-fetchear al volver a la pestaña
  });
}

/** Saldo REAL del wallet HOY = saldo_despues del último movimiento registrado,
 *  SIN filtro de rango. Existe porque `ultimoSaldo` de useWalletMovements hereda
 *  el rango de fechas de la vista: mirando mayo devolvía el saldo al 31/mayo bajo
 *  el label "Saldo disponible hoy" (bug detectado 2026-07-02: $7.568 vs $4.734
 *  reales). Va por el RPC wallet_summary (SECURITY DEFINER, store-scoped) y no
 *  por select directo porque la RLS de dropi_wallet_movements es admin-only —
 *  con select directo los socios verían saldo vacío. */
export function useWalletSaldoHoy() {
  const storeId = useActiveStoreId();
  return useQuery<number | null>({
    queryKey: ['wallet_saldo_hoy', storeId],
    queryFn: async () => {
      const manana = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const { data, error } = await supabase.rpc('wallet_summary', {
        p_from: '2020-01-01T00:00:00Z',
        p_to: `${manana}T23:59:59Z`,
      });
      if (error) throw error;
      const agg = (data?.[0] ?? {}) as { ultimo_saldo?: number | null };
      return agg.ultimo_saldo ?? null;
    },
    enabled: Boolean(storeId),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

/** Series por día para la gráfica de barras apiladas — agregada server-side.
 *  wallet_daily_series se scopea por tienda server-side; storeId en la queryKey
 *  hace que al cambiar de tienda la gráfica refetchee sola (antes era el único
 *  hook de wallet sin storeId → mostraba la caja de la tienda anterior). */
export function useWalletDailySeries(fromDate: string, toDate: string) {
  const storeId = useActiveStoreId();
  return useQuery({
    queryKey: ['wallet_daily_series', storeId ?? 'all', fromDate, toDate],
    enabled: Boolean(storeId),
    queryFn: async () => {
      // Corte de día en hora Bogotá (antes 'Z' = UTC corría el corte 5h).
      const { fromTs, toTs } = bogotaDayBounds(fromDate, toDate);
      const { data, error } = await supabase.rpc('wallet_daily_series', {
        p_from: fromTs,
        p_to: toTs,
      });
      if (error) throw error;
      return ((data ?? []) as Array<{ fecha: string; entrada: number; salida: number }>)
        .map((r) => ({
          fecha: r.fecha,
          ENTRADA: Number(r.entrada) || 0,
          SALIDA: Number(r.salida) || 0,
        }));
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
