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
import { bucketizeEstados, type EstadoRow } from './estadoBuckets';

export type BucketTone =
  | 'pending'
  | 'preparacion'
  | 'transit'
  | 'novedad'
  | 'entregado'
  | 'devuelto'
  | 'rechazado'
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

// ─────────────────────────────────────────────────────────────────
// Versión RICA — desde el desglose CRUDO por estado (RPC
// orders_estado_breakdown). Agrega tiles estilo Dropi (productos
// vendidos, total vendido sin cancelados) y NO tiene "Otros" misterioso:
// los estados sin mapear se muestran POR NOMBRE como buckets propios.
// ─────────────────────────────────────────────────────────────────

export interface MesResumenFull extends MesResumen {
  /** Pedidos generados SIN cancelados (matchea "Pedidos Generados" de Dropi). */
  generadosSinCancel: number;
  cancelados: number;          // conteo
  entregados: number;          // conteo
  /** Devoluciones logísticas (SIN rechazos del cliente) — denominador de la tasa madura. */
  devueltos: number;           // conteo
  /** Rechazos del cliente — bucket propio, fuera de la tasa de entrega. */
  rechazados: number;          // conteo
  valorRechazos: number;       // COP
  /** % completado = entregados / generados sin cancelar. */
  pctCompletado: number;
  /** Unidades vendidas (SUM cantidad sin cancelados) = "Productos vendidos" Dropi. */
  unidadesVendidas: number;
  /** "Total vendido" ALINEADO a Dropi = despachado y NO rechazado (excluye
   *  cancelados, pendientes, preparación y rechazos). Reconcilia al peso con el
   *  dashboard de Dropi. Ver auditoría 2026-06-24. */
  totalVendido: number;
  valorPreparacion: number;
  /** En tránsito + novedad + preparación + pendientes = el "Estimado" de Dropi. */
  valorPendienteUpside: number;
  /** Valor de los estados sin clasificar (debería ser 0 con el mapeo completo). */
  valorOtros: number;
}

const TONE_BY_BUCKET: Record<string, BucketTone> = {
  pendiente: 'pending',
  preparacion: 'preparacion',
  en_transito: 'transit',
  novedad: 'novedad',
  entregado: 'entregado',
  devuelto: 'devuelto',
  rechazado: 'rechazado',
  cancelado: 'cancelado',
};

const BUCKET_META: Array<{ key: string; label: string; sublabel?: string }> = [
  { key: 'pendiente',   label: 'Pendientes',   sublabel: 'Sin confirmar / sin despachar' },
  { key: 'preparacion', label: 'En preparación', sublabel: 'Confirmados · guía generada' },
  { key: 'en_transito', label: 'En tránsito',  sublabel: 'Plata en la calle, aún sin cobrar' },
  { key: 'novedad',     label: 'En novedad',   sublabel: 'En riesgo — requiere gestión' },
  { key: 'entregado',   label: 'Entregados',   sublabel: 'Realizado' },
  { key: 'devuelto',    label: 'Devueltos',    sublabel: 'Devolución logística (flete + cargo)' },
  { key: 'rechazado',   label: 'Rechazados',   sublabel: 'Cliente rechazó en la entrega' },
  { key: 'cancelado',   label: 'Cancelados',   sublabel: 'No se concretó' },
];

/**
 * Construye el resumen desde el desglose crudo por estado. Garantiza que la suma
 * de counts de TODOS los buckets (incl. los "otros" itemizados) === generadoTotal.
 */
export function buildMesResumenFromBreakdown(rows: EstadoRow[] | null | undefined): MesResumenFull | null {
  if (!rows) return null;
  const { buckets: b, otros, totals } = bucketizeEstados(rows);

  const generadoTotal = totals.pedidos;
  const cancelados = b.cancelado.pedidos;
  const generadosSinCancel = generadoTotal - cancelados;
  const entregados = b.entregado.pedidos;

  const buckets: FunnelBucket[] = BUCKET_META
    .filter((m) => b[m.key as keyof typeof b].pedidos > 0)
    .map((m) => {
      const t = b[m.key as keyof typeof b];
      return {
        key: m.key,
        label: m.label,
        sublabel: m.sublabel,
        count: t.pedidos,
        valor: t.valor,
        pct: pctOf(t.pedidos, generadoTotal),
        tone: TONE_BY_BUCKET[m.key],
      };
    });

  // Estados sin mapear → un bucket POR NOMBRE (no una bolsa anónima).
  for (const o of otros) {
    buckets.push({
      key: `otros:${o.estado}`,
      label: o.estado,
      sublabel: 'Estado sin clasificar',
      count: o.pedidos,
      valor: o.valor,
      pct: pctOf(o.pedidos, generadoTotal),
      tone: 'otros',
    });
  }

  const valorOtros = otros.reduce((a, o) => a + o.valor, 0);
  const valorGenerado = totals.valor;
  const valorEntregado = b.entregado.valor;
  const valorEnTransito = b.en_transito.valor;
  const valorNovedades = b.novedad.valor;
  const valorPendientes = b.pendiente.valor;
  const valorPreparacion = b.preparacion.valor;
  const valorPerdido = b.devuelto.valor;
  const valorRechazos = b.rechazado.valor;
  const valorCancelado = b.cancelado.valor;

  // "Total vendido" alineado a Dropi: lo despachado y NO rechazado. Dropi excluye
  // cancelados, pendientes (sin despachar), preparación (con guía pero sin salir) y
  // rechazos. Lo que queda = entregados + devoluciones + tránsito + novedad + otros
  // (indemnización, etc.). En mayo CO reconcilia al peso ($23.204.742 vs $23.204.743).
  const totalVendido =
    valorGenerado - valorCancelado - valorPendientes - valorPreparacion - valorRechazos;

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
    // extras (Full)
    generadosSinCancel,
    cancelados,
    entregados,
    devueltos: b.devuelto.pedidos,
    rechazados: b.rechazado.pedidos,
    valorRechazos,
    pctCompletado: pctOf(entregados, generadosSinCancel),
    unidadesVendidas: totals.unidades - b.cancelado.unidades,
    totalVendido,
    valorPreparacion,
    valorPendienteUpside: valorEnTransito + valorNovedades + valorPreparacion + valorPendientes,
    valorOtros,
  };
}
