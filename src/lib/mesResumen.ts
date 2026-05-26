// Embudo por estado + conciliación de plata para "Cómo voy este mes"
// (Logística → Resumen). Función PURA: toma el LogisticsSummary que ya
// trae useLogisticsStats y arma los buckets del embudo y los números de la
// conciliación. NO hace fetch — el componente le inyecta los datos.
//
// Invariante de diseño ("sin huecos"): la suma de los counts de TODOS los
// buckets (incluido el residual "Otros") DEBE ser igual a `generadoTotal`.
// El test lo verifica. Si Dropi agrega un estado nuevo que no cae en ninguna
// lista del RPC `logistics_summary`, ese pedido aparece en "Otros" en vez de
// desaparecer silenciosamente.

import type { LogisticsSummary } from './logistics.types';

export type BucketTone =
  | 'pending'
  | 'transit'
  | 'novedad'
  | 'entregado'
  | 'devuelto'
  | 'cancelado'
  | 'otros';

export interface FunnelBucket {
  key: string;
  label: string;
  sublabel?: string;
  count: number;
  valor: number; // COP; 0 cuando el RPC no separa el valor de ese estado
  pct: number;   // % sobre generadoTotal (0-100)
  tone: BucketTone;
}

export interface MesResumen {
  /** Todo lo generado en el período = total_pedidos (sin cancelados) + cancelados. */
  generadoTotal: number;
  buckets: FunnelBucket[];

  // ── Conciliación de plata (la cascada balancea por construcción) ──
  valorGenerado: number;   // suma de los 6 buckets con valor
  valorEntregado: number;  // realizado
  valorEnTransito: number; // aún sin cobrar
  valorNovedades: number;  // en riesgo
  valorPendientes: number; // sin despachar/confirmar
  valorPerdido: number;    // devoluciones
  valorCancelado: number;
}

function pctOf(count: number, total: number): number {
  return total > 0 ? (count / total) * 100 : 0;
}

/**
 * Arma el embudo y la conciliación a partir del summary del RPC.
 * Devuelve `null` si no hay datos todavía (el componente muestra skeleton).
 */
export function buildMesResumen(summary: LogisticsSummary | null): MesResumen | null {
  if (!summary) return null;

  const entregados = summary.entregados ?? 0;
  const devueltos = summary.devueltos ?? 0;
  const enTransito = summary.en_transito ?? 0;
  const novedades = summary.novedades ?? 0;
  const pendConfirmar = summary.pendientes_por_confirmar ?? 0;
  const pendDespachar = summary.pendientes_sin_despachar ?? 0;
  const pendientes = pendConfirmar + pendDespachar;
  const cancelados = summary.cancelados ?? 0;

  // total_pedidos ya EXCLUYE cancelados (ver RPC logistics_summary). Para
  // "generado" sumamos los cancelados de vuelta — así matchea "Pedidos
  // Generados" del dashboard de Dropi.
  const totalNoCancel = summary.total_pedidos ?? 0;
  const generadoTotal = totalNoCancel + cancelados;

  // Residual: cualquier estado no-cancelado que el RPC no clasificó en
  // entregado/devuelto/tránsito/novedad/pendiente. Garantiza Σ = total.
  const clasificadosNoCancel = entregados + devueltos + enTransito + novedades + pendientes;
  const otros = Math.max(0, totalNoCancel - clasificadosNoCancel);

  const valorEntregado = summary.valor_entregado ?? 0;
  const valorPerdido = summary.valor_perdido ?? 0;
  const valorEnTransito = summary.valor_en_transito ?? 0;
  const valorNovedades = summary.valor_novedades ?? 0;
  const valorPendientes = summary.valor_pendientes ?? 0;
  const valorCancelado = summary.valor_cancelado ?? 0;
  const valorGenerado =
    valorEntregado + valorEnTransito + valorNovedades + valorPendientes + valorPerdido + valorCancelado;

  const buckets: FunnelBucket[] = [
    {
      key: 'pendientes',
      label: 'Pendientes',
      sublabel:
        pendConfirmar || pendDespachar
          ? `${pendConfirmar} por confirmar · ${pendDespachar} por despachar`
          : undefined,
      count: pendientes,
      valor: valorPendientes,
      pct: pctOf(pendientes, generadoTotal),
      tone: 'pending',
    },
    {
      key: 'en_transito',
      label: 'En tránsito',
      sublabel: 'Plata en la calle, aún sin cobrar',
      count: enTransito,
      valor: valorEnTransito,
      pct: pctOf(enTransito, generadoTotal),
      tone: 'transit',
    },
    {
      key: 'novedad',
      label: 'En novedad',
      sublabel: 'En riesgo — requiere gestión',
      count: novedades,
      valor: valorNovedades,
      pct: pctOf(novedades, generadoTotal),
      tone: 'novedad',
    },
    {
      key: 'entregado',
      label: 'Entregados',
      sublabel: 'Realizado',
      count: entregados,
      valor: valorEntregado,
      pct: pctOf(entregados, generadoTotal),
      tone: 'entregado',
    },
    {
      key: 'devuelto',
      label: 'Devueltos',
      sublabel: 'Perdido (flete + cargo)',
      count: devueltos,
      valor: valorPerdido,
      pct: pctOf(devueltos, generadoTotal),
      tone: 'devuelto',
    },
    {
      key: 'cancelado',
      label: 'Cancelados',
      sublabel: 'No se concretó',
      count: cancelados,
      valor: valorCancelado,
      pct: pctOf(cancelados, generadoTotal),
      tone: 'cancelado',
    },
  ];

  // Solo agregamos "Otros" si hay residual — evita una barra en cero.
  if (otros > 0) {
    buckets.push({
      key: 'otros',
      label: 'Otros estados',
      sublabel: 'Sin clasificar en un bucket',
      count: otros,
      valor: 0,
      pct: pctOf(otros, generadoTotal),
      tone: 'otros',
    });
  }

  return {
    generadoTotal,
    buckets,
    valorGenerado,
    valorEntregado,
    valorEnTransito,
    valorNovedades,
    valorPendientes,
    valorPerdido,
    valorCancelado,
  };
}
