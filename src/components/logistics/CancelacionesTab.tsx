import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  RefreshCw, Lock, Wrench, ServerCrash, XCircle, PhoneOff, DollarSign,
  ShieldCheck, Users, MapPin, Package, Download, Clock, Gauge,
} from 'lucide-react';
import { useCancelacionesAnalisis } from '@/hooks/useCancelacionesAnalisis';
import { useCancelacionesPorProducto } from '@/hooks/useCancelacionesPorProducto';
import {
  cancelCategoriaLabel, CANCEL_CULPA_INFO, type CancelCulpa,
} from '@/lib/cancelTaxonomy';
import type { DimensionBucket, CulpaBucket } from '@/lib/cancelacionesResumen';
import { Stat } from '@/components/novedades/Stat';
import { NovCard, MetricBar, EmptyCard } from '@/components/novedades/NovedadesChrome';
import { fadeUp } from '@/components/novedades/chromeTokens';
import { SEMANTIC_COLORS } from '@/components/logistics/charts/chartTokens';
import { rowsToCsv, downloadCsv } from '@/lib/csvExport';
import { formatCOP } from '@/lib/utils';
import type { LogisticsFilters } from '@/lib/logistics.types';

/**
 * /logistica → Cancelaciones. Responde, con plata y no con porcentajes sueltos:
 * cuántas, por qué, de quién fue, si se le hizo seguimiento y dónde duele.
 *
 * TODA la aritmética vive en src/lib/cancelacionesResumen.ts (puro y testeado).
 * Acá no se calcula nada: se dibuja.
 *
 * EL ORDEN DE LAS SECCIONES ES EL ARGUMENTO
 * Primero la COBERTURA, no al pie: si solo el 30% de las cancelaciones tiene
 * motivo, eso hay que decirlo antes de que el dueño mire un solo gráfico. Un
 * reporte que entierra su propia incertidumbre en una nota final es un reporte
 * que induce a decidir mal.
 */

const CULPA_COLOR: Record<CancelCulpa, string> = {
  operacion: SEMANTIC_COLORS.danger,
  precio_oferta: SEMANTIC_COLORS.warning,
  trafico: SEMANTIC_COLORS.ai,
  cliente: SEMANTIC_COLORS.info,
  transportadora: SEMANTIC_COLORS.accent,
  filtro_interno: SEMANTIC_COLORS.success,
  generica: SEMANTIC_COLORS.muted,
};

/** Fila del CSV. Las claves son EXACTAMENTE las cabeceras exportadas. */
interface CancelCsvRow {
  external_id: string;
  fecha_pedido: string;
  cancelado_at: string;
  valor: number | string;
  ciudad: string;
  producto: string;
  operadora: string;
  origen: string;
  motivo: string;
  intentos_previos: number;
  contactos_previos: number;
  reagendas: number;
}

const pct = (n: number | null): string => (n == null ? '—' : `${Math.round(n * 100)}%`);
const horas = (h: number | null): string => {
  if (h == null) return '—';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${Math.round(h / 24)} días`;
};

function StatusCard({
  icon, title, body, tone,
}: { icon: React.ReactNode; title: string; body: string; tone: 'info' | 'warning' | 'danger' }) {
  const chip = {
    info: 'bg-info/14 border-info/30 text-info glow-info',
    warning: 'bg-warning/14 border-warning/30 text-warning glow-warning',
    danger: 'bg-danger/14 border-danger/30 text-danger glow-danger',
  }[tone];
  return (
    <div className="hairline-top bg-card/40 rounded-2xl border border-border p-10 flex flex-col items-center gap-3 text-center shadow-card3d">
      <div className={`w-12 h-12 rounded-2xl border flex items-center justify-center ${chip}`} aria-hidden="true">{icon}</div>
      <h3 className="text-sm font-bold text-foreground">{title}</h3>
      <p className="text-xs text-muted-foreground max-w-md">{body}</p>
    </div>
  );
}

/** Ranking de una dimensión (producto / ciudad) con su motivo dominante. */
function DimensionCard({
  title, icon, rows, total,
}: { title: string; icon: typeof MapPin; rows: DimensionBucket[]; total: number }) {
  const top = rows.slice(0, 8);
  return (
    <NovCard title={title} icon={icon} note={`top ${top.length}`}>
      {top.length === 0 ? <EmptyCard msg="Sin datos en el período." /> : (
        <ul className="space-y-1">
          {top.map((d, i) => (
            <MetricBar
              key={d.key}
              rank={i + 1}
              label={d.key}
              color={SEMANTIC_COLORS.danger}
              pct={total ? (d.cancelados / total) * 100 : null}
              dotTitle={d.topMotivo ? `Motivo dominante: ${cancelCategoriaLabel(d.topMotivo)}` : undefined}
              right={
                <span className="text-muted-foreground">
                  {d.cancelados} · {formatCOP(d.valor)}
                  {d.topMotivo && (
                    <span className="ml-1 text-[10px] opacity-80">· {cancelCategoriaLabel(d.topMotivo)}</span>
                  )}
                </span>
              }
            />
          ))}
        </ul>
      )}
    </NovCard>
  );
}

/**
 * LA PORTADA: ¿de qué lado está el problema?
 *
 * Antes esto era la cuarta tarjeta, se llamaba "¿De quién fue?" y **solo se
 * dibujaba si había motivos anotados** — justo al revés de lo que hace falta,
 * porque cuando NO hay motivos el bloque "nadie anotó por qué" es la respuesta
 * más importante de la pantalla. En agosto se llevaba el 79%.
 *
 * Va ordenada por tamaño, no por el orden fijo de la taxonomía: la barra más
 * grande es a dónde hay que ir. Y cada barra dice **dónde mirar**, que es lo
 * que convierte un porcentaje en algo que alguien puede hacer mañana.
 */
function LadoDelProblema({
  porCulpa, totalCancelados, valorCancelado,
}: { porCulpa: CulpaBucket[]; totalCancelados: number; valorCancelado: number }) {
  const ordenadas = useMemo(
    () => [...porCulpa].sort((a, b) => b.cancelados - a.cancelados),
    [porCulpa],
  );
  if (!ordenadas.length) return null;
  const mayor = ordenadas[0].cancelados || 1;

  return (
    <NovCard
      title="¿De qué lado está el problema?"
      icon={Gauge}
      iconClass="text-warning"
      note={`${totalCancelados} cancelados · ${formatCOP(valorCancelado)}`}
    >
      <ul className="space-y-3">
        {ordenadas.map(c => {
          const info = CANCEL_CULPA_INFO[c.culpa];
          return (
            <li key={c.culpa}>
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-sm font-semibold text-foreground">{info.label}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {c.cancelados} · {pct(c.pctSobreTotal)} · {formatCOP(c.valor)}
                </span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden my-1.5">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max((c.cancelados / mayor) * 100, 2)}%`,
                    background: CULPA_COLOR[c.culpa],
                  }}
                />
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug">
                {info.que} <span className="text-foreground/80">{info.dondeMirar}</span>
              </p>
            </li>
          );
        })}
      </ul>
    </NovCard>
  );
}

/**
 * Tasa de cancelación por producto. Reemplaza al `DimensionCard` de producto,
 * que ordenaba por CANTIDAD de cancelaciones: con ese criterio el producto más
 * vendido encabeza siempre y la pantalla no podía contestar "¿cuál me está
 * cancelando más?". En agosto-2026 decía que el problema eran las Gafas (109
 * cancelaciones, tasa 28,3%) cuando la peor era la Freidora (35 cancelaciones,
 * tasa 39,8%).
 *
 * Toda la aritmética está en `src/lib/cancelacionesPorProducto.ts`.
 */
function TasaPorProductoCard({ data }: { data: ReturnType<typeof useCancelacionesPorProducto> }) {
  const { status, resumen: pp } = data;

  if (status === 'not_ready') {
    return (
      <NovCard title="Tasa por producto" icon={Package}>
        <EmptyCard msg="Falta activar el reporte: la función cancelaciones_por_producto todavía no está en la base." />
      </NovCard>
    );
  }
  if (status === 'forbidden' || status === 'error') {
    return (
      <NovCard title="Tasa por producto" icon={Package}>
        <EmptyCard msg={status === 'forbidden'
          ? 'Solo los encargados de la tienda pueden ver esto.'
          : 'No se pudo cargar. Volvé a intentar en un momento.'} />
      </NovCard>
    );
  }
  if (!pp.ranking.length && !pp.bajoMinimo.length) {
    return (
      <NovCard title="Tasa por producto" icon={Package}>
        <EmptyCard msg="Sin pedidos en el período." />
      </NovCard>
    );
  }

  const peor = pp.ranking[0]?.tasa ?? 0;
  const discrepantes = pp.hermanas.filter(h => h.discrepan);

  return (
    <NovCard
      title="Tasa por producto"
      icon={Package}
      note={pp.promedioTienda == null ? 'sin promedio' : `la tienda va en ${pp.promedioTienda}%`}
    >
      {pp.ranking.length === 0 ? (
        <EmptyCard msg="Ningún producto tiene todavía suficientes pedidos resueltos para una tasa." />
      ) : (
        <ul className="space-y-2">
          {pp.ranking.map((f, i) => (
            <li key={f.producto} className="text-xs">
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] text-muted-foreground w-4 shrink-0 tabular-nums">{i + 1}</span>
                <span className="flex-1 min-w-0 truncate text-foreground" title={f.producto}>{f.producto}</span>
                <span className="font-semibold tabular-nums text-danger">{f.tasa}%</span>
              </div>
              <div className="flex items-center gap-2 mt-1 pl-6">
                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-danger/70"
                    style={{ width: `${peor > 0 ? Math.max((f.tasa! / peor) * 100, 2) : 0}%` }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap">
                  {f.cancelados} de {f.resueltos} · {formatCOP(f.valorCancelado)}
                  {f.delta != null && f.delta !== 0 && (
                    <span className={f.delta > 0 ? 'ml-1 text-danger' : 'ml-1 text-success'}>
                      {f.delta > 0 ? '+' : ''}{f.delta} pts
                    </span>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Publicaciones hermanas: el MISMO producto publicado dos veces cancela
          distinto. Es la señal más fuerte de que el problema está en el anuncio
          y no en el producto — y no se ve en ninguna otra parte del tablero. */}
      {discrepantes.length > 0 && (
        <div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-3">
          <p className="text-[11px] font-semibold text-foreground mb-2">
            El mismo producto, publicado distinto, cancela distinto
          </p>
          <ul className="space-y-2">
            {discrepantes.map(h => (
              <li key={h.clave} className="text-[11px] text-muted-foreground">
                {h.filas.filter(f => f.rankeable).map((f, i, arr) => (
                  <span key={f.producto}>
                    <span className="text-foreground">{f.producto}</span>{' '}
                    <span className="tabular-nums font-semibold">{f.tasa}%</span>
                    <span className="opacity-70"> ({f.generados} ped.)</span>
                    {i < arr.length - 1 && <span className="mx-1 opacity-60">vs</span>}
                  </span>
                ))}
                <span className="ml-1 text-warning font-semibold tabular-nums">
                  · {h.brechaPuntos} pts de diferencia
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-muted-foreground mt-2">
            Si fuera el producto, las dos publicaciones cancelarían igual. Mirá el anuncio de la peor.
          </p>
        </div>
      )}

      {/* Los de poco volumen NO se esconden: se listan sin ranking. Un producto
          con 3 pedidos y 2 cancelaciones da 67% y encabezaría la lista con puro
          ruido — el mismo bug que ya tuvo el ranking de transportadoras. */}
      {pp.bajoMinimo.length > 0 && (
        <p className="text-[10px] text-muted-foreground mt-4 pt-3 border-t border-border">
          <span className="font-semibold">{pp.bajoMinimo.length} producto(s) con pocos pedidos resueltos</span>{' '}
          quedan fuera del ranking porque su porcentaje todavía no significa nada:{' '}
          {pp.bajoMinimo.slice(0, 4).map(f => `${f.producto} (${f.cancelados}/${f.resueltos})`).join(' · ')}
          {pp.bajoMinimo.length > 4 && ` y ${pp.bajoMinimo.length - 4} más`}.
        </p>
      )}
    </NovCard>
  );
}

export default function CancelacionesTab({ filters }: { filters: LogisticsFilters }) {
  const s = useCancelacionesAnalisis({ fromDate: filters.fromDate, toDate: filters.toDate });
  // Denominador por producto: query APARTE. Sin ella la pantalla sigue igual.
  const porProducto = useCancelacionesPorProducto({ fromDate: filters.fromDate, toDate: filters.toDate });
  const { resumen: r, rows } = s;
  const [verTodo, setVerTodo] = useState(false);

  const detalle = useMemo(
    () => (verTodo ? rows : rows.slice(0, 50)),
    [rows, verTodo],
  );

  const exportar = () => {
    // Tipado sobre CancelCsvRow (mismo patrón que CarrierStatsTable): si alguien
    // renombra un campo del objeto y no la cabecera, lo caza el build en vez de
    // exportar una columna vacía en silencio. `escapeCell` emite celda vacía
    // ante null, así el CSV dice lo mismo que la pantalla.
    const csv = rowsToCsv<CancelCsvRow>([
      'external_id', 'fecha_pedido', 'cancelado_at', 'valor', 'ciudad', 'producto',
      'operadora', 'origen', 'motivo', 'intentos_previos', 'contactos_previos', 'reagendas',
    ], rows.map(x => ({
      external_id: x.externalId ?? '',
      fecha_pedido: x.fecha ?? '',
      cancelado_at: x.canceladoAt ?? '',
      valor: x.valor ?? '',
      ciudad: x.ciudad ?? '',
      producto: x.producto ?? '',
      operadora: x.operatorName ?? '',
      origen: x.origen,
      motivo: x.motivo ?? '',
      intentos_previos: x.intentosPrevios,
      contactos_previos: x.contactosPrevios,
      reagendas: x.reagendas,
    })));
    downloadCsv(`cancelaciones-${filters.fromDate}_a_${filters.toDate}.csv`, csv);
  };

  if (s.status === 'forbidden') {
    return <StatusCard tone="info" icon={<Lock size={22} />} title="Solo para encargados"
      body="Este análisis incluye nombres de operadoras y montos, así que solo lo ven dueño o supervisor de la tienda." />;
  }
  if (s.status === 'not_ready') {
    return <StatusCard tone="warning" icon={<Wrench size={22} />} title="Falta activar el reporte"
      body="La migración `cancelaciones_analisis` todavía no está aplicada en la base. En cuanto se aplique, este panel se llena solo — no hay que tocar nada más." />;
  }
  if (s.status === 'error') {
    return <StatusCard tone="danger" icon={<ServerCrash size={22} />} title="No se pudo cargar"
      body="Falló la consulta. Probá recargar; si sigue, revisá la conexión con Supabase." />;
  }

  const sinDatos = r.totalCancelados === 0;
  // Con cobertura nula las secciones de MOTIVO y CULPA no se dibujan: no hay
  // nada que mostrar. Pero el resto SÍ — la clasificación por "sin gestión", los
  // intentos, el tiempo al primer toque y la tabla NO necesitan ni un motivo
  // para funcionar. Al 0% de cobertura el reporte todavía contesta dos de las
  // cinco preguntas, y se convierte en el argumento para empezar a anotar.
  const hayMotivos = r.cobertura.conMotivo > 0;
  const maxMotivo = r.topMotivos[0]?.cancelados || 1;

  return (
    <div className="space-y-5">
      <motion.div {...fadeUp(0)} className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-muted-foreground">
          Pedidos <span className="text-foreground font-semibold">creados</span> entre {filters.fromDate} y {filters.toDate}
          {/* La RPC no recibe ciudad (no tiene p_ciudad): estas cifras son de
              TODA la tienda. Decirlo es obligatorio — antes acá decía
              "filtrado por {ciudad}" sobre datos sin filtrar. */}
          {filters.ciudad && (
            <> · <span className="text-warning font-semibold">el filtro de ciudad ({filters.ciudad}) NO aplica acá — cifras de toda la tienda</span></>
          )}
        </p>
        <div className="flex items-center gap-2">
          <button type="button" onClick={exportar} disabled={!rows.length}
            className="px-3 py-2 rounded-xl bg-card/40 border border-border text-muted-foreground text-sm font-medium flex items-center gap-1.5 hover:text-foreground hover:border-border-strong transition-colors disabled:opacity-40">
            <Download size={13} aria-hidden="true" /> CSV
          </button>
          <button type="button" onClick={s.refresh} disabled={s.loading}
            className="px-3 py-2 rounded-xl bg-card/40 border border-border text-muted-foreground text-sm font-medium flex items-center gap-1.5 hover:text-foreground hover:border-border-strong transition-colors disabled:opacity-50">
            <RefreshCw size={13} className={s.loading ? 'animate-spin' : ''} aria-hidden="true" /> Recargar
          </button>
        </div>
      </motion.div>

      {sinDatos ? (
        <EmptyCard msg="No hubo cancelaciones en el período. Es un buen resultado, no un error." />
      ) : (
        <>
          {/* 0 · COBERTURA — va primero a propósito */}
          <motion.div {...fadeUp(0.04)}>
            <div className={`hairline-top rounded-2xl border p-5 shadow-card3d ${
              r.cobertura.nivel === 'alta' ? 'bg-success/8 border-success/30'
                : r.cobertura.nivel === 'media' ? 'bg-warning/8 border-warning/30'
                : 'bg-danger/8 border-danger/30'
            }`}>
              <div className="flex items-start gap-3 flex-wrap">
                <Gauge size={18} className="text-foreground mt-0.5 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-foreground">
                    {r.cobertura.conMotivo} de {r.cobertura.total} cancelaciones tienen motivo anotado ({pct(r.cobertura.pctConMotivo)})
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Los bloques de <span className="text-foreground font-medium">motivo</span> y{' '}
                    <span className="text-foreground font-medium">culpa</span> describen solo esos {r.cobertura.conMotivo}.
                    El resto de la pantalla (plata, seguimiento, operadoras) cubre las {r.cobertura.total}.
                  </p>
                  <div className="flex gap-2 mt-2 flex-wrap">
                    {r.cobertura.porOrigen.map(o => (
                      <span key={o.origen} className="text-[11px] font-mono tabular-nums px-2 py-1 rounded-lg bg-card/60 border border-border text-muted-foreground">
                        {o.origen === 'guardian' ? 'Cancelado en el CRM' : 'Cancelado en Dropi'}: {o.cancelados} · {pct(o.pctConMotivo)} con motivo
                      </span>
                    ))}
                  </div>
                  {(r.cobertura.porOrigen.find(o => o.origen === 'externo')?.cancelados ?? 0) > 0 && (
                    <p className="text-[11px] text-muted-foreground mt-2">
                      Las canceladas en Dropi nunca pasan por el CRM, así que no dejan motivo. Bajar ese número
                      es lo que sube la confianza de todo este reporte.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </motion.div>

          {/* 1 · LA PORTADA — de que lado esta el problema */}
          <motion.div {...fadeUp(0.08)}>
            <LadoDelProblema
              porCulpa={r.porCulpa}
              totalCancelados={r.totalCancelados}
              valorCancelado={r.valorCancelado}
            />
          </motion.div>

          {/* 2 · LA PLATA */}
          <motion.div {...fadeUp(0.08)} className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            {/* La tasa que se muestra es la REAL: sin los pedidos que se
                recrearon con otro id (cambio de transportadora, edición). Esos
                no se perdieron — contarlos cuenta la misma venta dos veces. La
                tasa cruda queda al lado para poder cuadrar con el panel de
                Dropi, que sí los cuenta. */}
            <Stat icon={<XCircle size={16} />} label="Cancelados" value={r.totalCancelados} tone="danger"
              hint={r.tasaCancelacionReal != null
                ? `${pct(r.tasaCancelacionReal)} de ${r.generados} generados`
                : r.tasaCancelacion == null
                  ? (r.universoInconsistente ? 'tasa no confiable' : 'sin base comparable')
                  : `${pct(r.tasaCancelacion)} de ${r.generados} generados`} />
            <Stat icon={<DollarSign size={16} />} label="Pérdida evitable" value={formatCOP(r.plata.evitable.valor)} tone="warning"
              hint={`${r.plata.evitable.cancelados} pedidos`} />
            <Stat icon={<DollarSign size={16} />} label="Pérdida inevitable" value={formatCOP(r.plata.inevitable.valor)}
              hint={`${r.plata.inevitable.cancelados} pedidos`} />
            <Stat icon={<ShieldCheck size={16} />} label="Ahorro (estuvo bien cancelar)" value={formatCOP(r.plata.ahorro.valor)} tone="success"
              hint={`${r.plata.ahorro.cancelados} duplicados / mal historial`} />
          </motion.div>

          <motion.div {...fadeUp(0.1)} className="text-xs text-muted-foreground">
            Perdido bruto del período: <span className="font-mono tabular-nums text-foreground font-bold text-sm">{formatCOP(r.plata.perdidoBruto)}</span>
            {' '}· sin clasificar: {formatCOP(r.plata.sinClasificar.valor)} ({r.plata.sinClasificar.cancelados})
            <span className="block mt-1 opacity-80">Es venta bruta no realizada, no utilidad.</span>
            {/* Se dice SIEMPRE que hay recreados, aunque la tasa real no se
                haya podido calcular: si el número de la pantalla difiere del
                de Dropi, esta línea explica por qué antes de que nadie
                sospeche del dato. */}
            {r.recreados > 0 && (
              <span className="block mt-1">
                <span className="font-mono tabular-nums text-foreground">{r.recreados}</span>
                {' '}de esos cancelados no se perdieron: se recrearon con otro número de pedido
                (cambio de transportadora o edición).
                {r.tasaCancelacionReal != null
                  ? ` La tasa de arriba ya los descuenta — con ellos sería ${pct(r.tasaCancelacion)}, que es lo que muestra Dropi.`
                  : ' No entran en la tasa de arriba.'}
              </span>
            )}
          </motion.div>

          {/* 4 · ¿SE LE HIZO SEGUIMIENTO? — arriba de motivos porque no depende
                de que haya motivos y suele ser el hallazgo más grande. */}
          <motion.div {...fadeUp(0.14)} className="grid gap-4 lg:grid-cols-2">
            <NovCard title="¿Se le hizo seguimiento antes de cancelar?" icon={PhoneOff} iconClass="text-danger">
              <div className="rounded-xl bg-danger/10 border border-danger/30 px-3 py-2.5 mb-3">
                <p className="text-sm font-bold text-danger">
                  {r.gestion.sinGestion} cancelados sin una sola llamada = {formatCOP(r.gestion.sinGestionValor)}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {pct(r.gestion.pctSinGestion)} del total. Acá el motivo anotado no se verificó con nadie.
                </p>
              </div>
              <ul className="space-y-1">
                {r.gestion.distribucionIntentos.map(b => (
                  <MetricBar
                    key={b.bucket}
                    label={b.bucket === '0' ? 'Sin ningún intento' : `${b.bucket} intento${b.bucket === '1' ? '' : 's'}`}
                    color={b.bucket === '0' ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.info}
                    pct={b.pctSobreTotal == null ? null : b.pctSobreTotal * 100}
                    right={<span className="text-muted-foreground">{b.cancelados} · {formatCOP(b.valor)}</span>}
                  />
                ))}
              </ul>
            </NovCard>

            <NovCard title="Cuánto tardamos en llamarlo" icon={Clock} iconClass="text-warning"
              note={`sobre ${r.gestion.ttfcMedidos} medidos`}>
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Mediana" value={horas(r.gestion.ttfcMedianaHoras)} tone="warning" />
                <Stat label="El 10% más lento" value={horas(r.gestion.ttfcP90Horas)} />
              </div>
              <p className="text-[11px] text-muted-foreground mt-3">
                {r.gestion.ttfcNunca} nunca se tocaron (no entran en la mediana).
                {r.gestion.reagendasQuemadas > 0 && (
                  <> · {r.gestion.reagendasQuemadas} se habían reagendado y aun así se cancelaron.</>
                )}
              </p>
              <div className="mt-3 pt-3 border-t border-border grid grid-cols-2 gap-3 text-xs">
                <div>
                  <div className="hud-label text-subtle">Cancelados el mismo día</div>
                  <div className="font-mono tabular-nums text-foreground font-semibold">{r.antiguedad.frescos}</div>
                </div>
                <div>
                  <div className="hud-label text-subtle">De arrastre (+1 día)</div>
                  <div className="font-mono tabular-nums text-foreground font-semibold">
                    {r.antiguedad.arrastre} · {formatCOP(r.antiguedad.valorArrastre)}
                  </div>
                </div>
              </div>
            </NovCard>
          </motion.div>

          {/* 2 y 3 · MOTIVO y CULPA — solo si hay motivos que mostrar */}
          {hayMotivos && (
            <motion.div {...fadeUp(0.18)}>
              <NovCard title="¿Por qué cancelan?" icon={XCircle} iconClass="text-danger"
                note={`sobre ${r.cobertura.conMotivo} con motivo`}>
                <ul className="space-y-1">
                  {r.topMotivos.slice(0, 8).map((m, i) => (
                    <MetricBar
                      key={m.categoria}
                      rank={i + 1}
                      label={cancelCategoriaLabel(m.categoria)}
                      color={CULPA_COLOR[m.culpa]}
                      dotTitle={CANCEL_CULPA_INFO[m.culpa].label}
                      pct={(m.cancelados / maxMotivo) * 100}
                      right={
                        <span className="text-muted-foreground">
                          {m.cancelados} · {pct(m.pctSobreConMotivo)} · {formatCOP(m.valor)}
                        </span>
                      }
                    />
                  ))}
                </ul>
                {r.motivosCrudos.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-border">
                    <h4 className="hud-label text-subtle mb-2">Todavía sin clasificar</h4>
                    <p className="text-[11px] text-muted-foreground mb-2">
                      Lo que la asesora escribió y la taxonomía aún no entiende. Es la lista de reglas por agregar.
                    </p>
                    <ul className="space-y-1">
                      {r.motivosCrudos.slice(0, 6).map(c => (
                        <li key={c.texto} className="flex justify-between gap-2 text-xs">
                          <span className="truncate text-muted-foreground">“{c.texto}”</span>
                          <span className="font-mono tabular-nums shrink-0">{c.veces}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </NovCard>

            </motion.div>
          )}

          {/* 5 · POR OPERADORA */}
          <motion.div {...fadeUp(0.22)}>
            <NovCard title="Por operadora" icon={Users} iconClass="text-info"
              note="ordenado por cancelaciones sin llamar">
              {r.porOperadora.length === 0 ? <EmptyCard msg="Sin datos." /> : (
                <ul className="space-y-1">
                  {r.porOperadora.map((o, i) => (
                    <MetricBar
                      key={o.operatorId ?? 'sin-op'}
                      rank={i + 1}
                      label={o.name}
                      labelClassName={o.operatorId ? 'text-foreground' : 'text-muted-foreground italic'}
                      color={o.muestraSuficiente && (o.pctSinGestion ?? 0) > 0.3
                        ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.info}
                      pct={o.pctConMotivo == null ? null : o.pctConMotivo * 100}
                      dotTitle={o.muestraSuficiente ? undefined : 'Pocos datos para juzgar'}
                      right={
                        <span className="text-muted-foreground">
                          {o.cancelados} canc · {o.sinGestion} sin llamar · {pct(o.pctConMotivo)} con motivo
                        </span>
                      }
                    />
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-muted-foreground mt-3">
                La barra mide <span className="text-foreground font-medium">% con motivo anotado</span>, no volumen:
                cancelar mucho no es malo por sí solo — la que más pedidos atiende siempre cancela más.
              </p>
            </NovCard>
          </motion.div>

          {/* 6 · DÓNDE */}
          <motion.div {...fadeUp(0.26)} className="grid gap-4 lg:grid-cols-2">
            <TasaPorProductoCard data={porProducto} />
            {filters.ciudad ? (
              <NovCard title="Por ciudad" icon={MapPin}>
                <EmptyCard msg={`Estás viendo solo ${filters.ciudad}. Quitá el filtro de ciudad para comparar entre ciudades.`} />
              </NovCard>
            ) : (
              <DimensionCard title="Por ciudad" icon={MapPin} rows={r.porCiudad} total={r.totalCancelados} />
            )}
          </motion.div>

          {/* 7 · DETALLE + CSV */}
          <motion.div {...fadeUp(0.3)}>
            <NovCard title="Detalle" icon={XCircle}
              note={`${detalle.length} de ${r.totalPeriodo}`}
              right={rows.length > 50 && (
                <button type="button" onClick={() => setVerTodo(v => !v)}
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2">
                  {verTodo ? 'Ver menos' : `Ver los ${rows.length}`}
                </button>
              )}>
              {s.partial && (
                <p className="text-[11px] text-warning mb-2">
                  Se alcanzó el tope del servidor: hay {r.totalPeriodo} cancelaciones en el período y se
                  trajeron las {rows.length} de mayor valor. Achicá el rango de fechas para verlas todas.
                </p>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b border-border">
                      <th className="py-2 pr-3 font-medium">Pedido</th>
                      <th className="py-2 pr-3 font-medium">Fecha</th>
                      <th className="py-2 pr-3 font-medium text-right">Valor</th>
                      <th className="py-2 pr-3 font-medium">Ciudad</th>
                      <th className="py-2 pr-3 font-medium">Operadora</th>
                      <th className="py-2 pr-3 font-medium text-right">Int.</th>
                      <th className="py-2 pr-3 font-medium">Motivo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detalle.map(x => (
                      <tr key={x.orderId} className="border-b border-border/50 hover:bg-card/60">
                        <td className="py-2 pr-3">
                          <a href={`/pedido/${x.externalId}`} className="font-mono text-accent hover:underline">
                            {x.externalId ?? '—'}
                          </a>
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">{x.fecha ?? '—'}</td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums">{formatCOP(x.valor ?? 0)}</td>
                        <td className="py-2 pr-3 text-muted-foreground truncate max-w-[120px]">{x.ciudad ?? '—'}</td>
                        <td className="py-2 pr-3 text-muted-foreground truncate max-w-[110px]">
                          {x.operatorName ?? <span className="italic">en Dropi</span>}
                        </td>
                        <td className={`py-2 pr-3 text-right font-mono tabular-nums ${x.intentosPrevios === 0 ? 'text-danger font-bold' : ''}`}>
                          {x.intentosPrevios}
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground truncate max-w-[180px]">
                          {x.motivo ?? <span className="italic opacity-70">sin motivo</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </NovCard>
          </motion.div>

          {/* Pie: los denominadores, escritos. */}
          <motion.div {...fadeUp(0.34)} className="text-[11px] text-muted-foreground leading-relaxed">
            <strong className="text-foreground">Cómo leer estos números.</strong>{' '}
            La base de la tasa son los pedidos <em>creados</em> en el rango, con los cancelados incluidos y los
            borrados/fantasma excluidos — la misma que usa Finanzas. Logística → Resumen usa una base
            <em> sin</em> cancelados, por eso sus porcentajes no coinciden con estos y no es un error.
            El top de motivos se calcula sobre las cancelaciones que tienen motivo anotado, no sobre el total.
            “Pérdida evitable” incluye toda cancelación sin ninguna gestión registrada, aunque el motivo culpe
            al cliente: nadie verificó ese motivo. El valor es venta bruta no realizada, no utilidad.
          </motion.div>
        </>
      )}
    </div>
  );
}
