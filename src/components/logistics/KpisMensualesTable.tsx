import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import { construirKpis, type KpiMes, type KpiMesCrudo } from '@/lib/kpisMensuales';

// Tabla ancha de KPIs mes a mes. Existe porque el dueño dijo "me perdí": el panel
// de Dropi le mostraba una "Utilidad Total" de $8M–$12M todos los meses mientras el
// negocio perdía plata, y no había ninguna pantalla donde ver la cadena completa
// desde ese número hasta lo que quedaba.
//
// Las dos columnas que justifican la tabla entera son DEJA y TE QUEDA:
//   · DEJA      = lo que sobra de cada entrega DESPUÉS de pagar lo que costó traerla.
//                 Si es negativa, vender más agranda la pérdida.
//   · TE QUEDA  = de cada $100 que el panel de Dropi promete, cuántos quedan.
//
// La fila RANGO no es decorativa: el dueño observó que "la tasa de entrega nunca es
// igual, las cancelaciones tampoco". Un promedio esconde justo eso; el mínimo y el
// máximo con el mes donde ocurrieron, no.

const mesLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1)
    .toLocaleDateString('es-CO', { month: 'short', year: '2-digit' })
    .replace('.', '');
};

const VACIO = '—';
// Sin Math.round: en EC (USD) los per-entrega son de un dígito y el redondeo
// borraba los centavos — un "Deja" de −$0,49 se mostraba "$0,00" y perdía
// hasta el signo. formatCOP ya resuelve los decimales por país (CO sin
// decimales, EC/GT con centavos). Auditoría 24-ago-2026.
const money = (v: number | null | undefined) => (v == null ? VACIO : formatCOP(v));
const pctTxt = (v: number | null | undefined, dec = 0) => (v == null ? VACIO : `${v.toFixed(dec)}%`);
const dec1 = (v: number | null | undefined) => (v == null ? VACIO : v.toFixed(1));
const entero = (v: number | null | undefined) => (v == null ? VACIO : Math.round(v).toLocaleString('es-CO'));
const ratio = (v: number | null | undefined) => (v == null ? VACIO : `${v.toFixed(2)}×`);

/** Grupos de la cabecera. El `span` tiene que sumar exactamente las columnas. */
const GRUPOS: Array<{ label: string; span: number }> = [
  { label: '', span: 1 },
  { label: 'Volumen', span: 3 },
  { label: 'Demanda', span: 2 },
  { label: 'Entrega', span: 3 },
  { label: 'Por cada entrega', span: 4 },
  { label: 'Resultado del mes', span: 6 },
];

interface Col {
  key: string;
  label: string;
  /** Explicación en castellano llano — el usuario dijo "me perdí", no adivina. */
  ayuda: string;
}

const COLS: Col[] = [
  { key: 'mes', label: 'Mes', ayuda: 'Cohorte: los pedidos GENERADOS en ese mes, se cobren cuando se cobren.' },

  { key: 'generados', label: 'Pedidos', ayuda: 'Pedidos generados, sin contar los borrados en Dropi.' },
  { key: 'porDia', label: '/día', ayuda: 'Pedidos por día transcurrido. El número a vigilar a diario.' },
  { key: 'unPed', label: 'Un/ped', ayuda: 'Unidades por pedido. Sube cuando se logra vender más de un producto por llamada.' },

  { key: 'cancel', label: 'Cancel.', ayuda: 'Cancelados ÷ generados. Mide la calidad de la demanda, no la logística.' },
  { key: 'ticket', label: 'Ticket', ayuda: 'Valor promedio de los pedidos que SÍ se despacharon (sin los cancelados).' },

  { key: 'entrega', label: 'Entrega', ayuda: 'Entregados ÷ concluidos. No cuenta los que siguen en la calle ni los rechazos del cliente.' },
  { key: 'devol', label: 'Devol.', ayuda: 'Devueltos ÷ concluidos.' },
  { key: 'concl', label: 'Concluido', ayuda: 'Cuánto del mes ya terminó su ciclo. Por debajo del 70% las tasas todavía no son concluyentes.' },

  { key: 'bruto', label: 'Bruto', ayuda: 'Lo que el panel de Dropi dice que deja cada entrega. NO descuenta fletes ni devoluciones.' },
  { key: 'neto', label: 'Neto', ayuda: 'Lo que deja cada entrega DESPUÉS de que las devoluciones se comieran su parte.' },
  { key: 'cpa', label: 'CPA', ayuda: 'Lo que costó en publicidad conseguir una entrega. Sin pauta cargada dice “—”, no cero.' },
  { key: 'deja', label: 'Deja', ayuda: 'Neto menos CPA. Si es negativo, cada venta agranda la pérdida: vender más no arregla nada.' },

  { key: 'operativo', label: 'Operativo', ayuda: 'Lo que de verdad entró a la billetera de Dropi por los pedidos de este mes.' },
  { key: 'pauta', label: 'Pauta', ayuda: 'Lo invertido en publicidad. Sale de Pauta diaria; si no hay, de los costos mensuales.' },
  { key: 'admin', label: 'Admin', ayuda: 'Costos fijos del mes: sueldos, herramientas, servicios.' },
  { key: 'resultado', label: 'Resultado', ayuda: 'Operativo − pauta − admin. Lo que quedó.' },
  { key: 'equil', label: 'Equilibrio', ayuda: 'Qué % habría que entregar para no perder. Por encima de 100 no hay operación que salve el mes: el problema es el costo de traer el pedido.' },
  { key: 'queda', label: 'Te queda', ayuda: 'De cada $100 que el panel de Dropi promete, cuántos quedan de verdad.' },
];

const TH = 'px-2.5 py-2 font-semibold text-right whitespace-nowrap';
const TD = 'px-2.5 py-2 font-mono text-right whitespace-nowrap';

function signo(v: number | null | undefined): string {
  if (v == null) return 'text-muted-foreground';
  return v >= 0 ? 'text-success' : 'text-danger';
}

function Fila({ m, destacar }: { m: KpiMes; destacar?: boolean }) {
  const base = destacar
    ? 'border-t border-border font-bold'
    : 'border-b border-border/40 hover:bg-foreground/[0.03] transition-colors';
  // Un mes que todavía está cobrando no se juzga: se atenúa y se rotula.
  const atenuado = m.preliminar && !destacar ? ' text-muted-foreground/80' : '';

  return (
    <tr className={base + atenuado}>
      <th scope="row" className="px-3 py-2 text-left font-medium capitalize whitespace-nowrap">
        {destacar ? 'Total' : mesLabel(m.year_month)}
        {m.preliminar && !destacar && (
          <span
            className="ml-1.5 rounded px-1 py-px text-[9px] font-normal uppercase tracking-wide bg-muted text-muted-foreground align-middle"
            title={`Concluyó el ${m.pctConcluido}% de los pedidos: el mes todavía se está definiendo.`}
          >
            prelim
          </span>
        )}
      </th>

      <td className={TD}>{entero(m.generados)}</td>
      <td className={`${TD} text-muted-foreground`}>{dec1(m.pedidosPorDia)}</td>
      <td className={`${TD} text-muted-foreground`}>{dec1(m.unidadesPorPedido)}</td>

      <td className={`${TD} text-muted-foreground`}>{pctTxt(m.tasaCancelacion)}</td>
      <td className={TD}>{money(m.ticketPromedio)}</td>

      <td className={TD}>{pctTxt(m.tasaEntregaMadura)}</td>
      <td className={`${TD} text-muted-foreground`}>{pctTxt(m.tasaDevolucionMadura)}</td>
      <td className={`${TD} text-muted-foreground`}>{pctTxt(m.pctConcluido)}</td>

      <td className={`${TD} text-muted-foreground`}>{money(m.gananciaBrutaPorEntrega)}</td>
      <td className={TD}>{money(m.netoPorEntrega)}</td>
      <td className={`${TD} text-muted-foreground`}>{money(m.cpaPorEntrega)}</td>
      <td
        className={`${TD} font-bold ${signo(m.contribucionPorEntrega)}`}
        title={
          m.contribucionPorEntrega == null
            ? 'Falta cargar la pauta del mes para poder calcularlo.'
            : m.contribucionPorEntrega < 0
              ? 'Negativo: cada venta agrandaba la pérdida.'
              : undefined
        }
      >
        {money(m.contribucionPorEntrega)}
      </td>

      <td className={TD}>{money(m.operativo)}</td>
      <td className={`${TD} text-muted-foreground`}>{m.pauta ? `−${formatCOP(m.pauta)}` : VACIO}</td>
      <td className={`${TD} text-muted-foreground`}>{m.admin ? `−${formatCOP(m.admin)}` : VACIO}</td>
      <td className={`${TD} font-bold ${signo(m.resultado)}`}>
        {m.resultado >= 0 ? '+' : ''}{formatCOP(m.resultado)}
      </td>
      <td
        className={`${TD} ${
          m.tasaEquilibrio == null
            ? 'text-muted-foreground'
            : m.tasaEquilibrio > 100
              ? 'text-danger font-bold'
              : 'text-muted-foreground'
        }`}
        title={
          m.tasaEquilibrio != null && m.tasaEquilibrio > 100
            ? 'Por encima del 100%: ninguna tasa de entrega salvaba este mes. No fue la operación, fue el costo de traer el pedido.'
            : undefined
        }
      >
        {pctTxt(m.tasaEquilibrio)}
      </td>
      <td className={`${TD} font-bold ${signo(m.loQueQueda)}`}>{pctTxt(m.loQueQueda)}</td>
    </tr>
  );
}

interface Props {
  filas: KpiMesCrudo[];
}

export default function KpisMensualesTable({ filas }: Props) {
  const { meses, totales, rangos } = useMemo(() => construirKpis(filas), [filas]);

  if (!meses.length) {
    return (
      <p className="px-5 py-6 text-[13px] text-muted-foreground">
        No hay pedidos en este rango.
      </p>
    );
  }

  const sinPauta = meses.filter((m) => m.sinPauta && m.generados > 0);
  const rango = (k: keyof typeof rangos, fmt: (v: number) => string) => {
    const r = rangos[k];
    return r ? `${fmt(r.min)} – ${fmt(r.max)}` : VACIO;
  };

  return (
    <>
      {sinPauta.length > 0 && (
        <p className="px-5 py-2.5 text-[12px] text-warning flex items-start gap-2 border-b border-border/60">
          <AlertTriangle size={13} className="mt-px shrink-0" />
          <span>
            Sin pauta cargada en {sinPauta.map((m) => mesLabel(m.year_month)).join(', ')}, así que
            el CPA y lo que deja cada entrega quedan en blanco. Cargala en{' '}
            <strong className="font-semibold">Resumen → Pauta diaria</strong>: sin ese número
            no se puede decir si el mes ganó o perdió.
          </span>
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <caption className="sr-only">
            Indicadores del negocio por mes: volumen, calidad de la demanda, cumplimiento,
            economía por entrega y resultado.
          </caption>
          <thead>
            <tr className="hud-label text-[9px] text-muted-foreground/70">
              {GRUPOS.map((g, i) => (
                <th
                  key={g.label || `g${i}`}
                  colSpan={g.span}
                  scope="colgroup"
                  className={`px-2.5 pt-2.5 pb-1 text-left font-semibold ${
                    i > 1 ? 'border-l border-border/50' : ''
                  }`}
                >
                  {g.label}
                </th>
              ))}
            </tr>
            <tr className="hud-label border-b border-border">
              {COLS.map((c, i) => (
                <th
                  key={c.key}
                  scope="col"
                  title={c.ayuda}
                  className={`${i === 0 ? 'px-3 py-2 text-left font-semibold whitespace-nowrap' : TH} cursor-help`}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {meses.map((m) => (
              <Fila key={m.year_month} m={m} />
            ))}
          </tbody>
          <tfoot>
            <Fila m={totales} destacar />
            {/* Rango: la variación que un promedio esconde. */}
            <tr className="border-t border-border/50 text-[10px] text-muted-foreground">
              <th scope="row" className="px-3 py-2 text-left font-medium">
                Rango
              </th>
              <td className={TD} />
              <td className={TD}>{rango('pedidosPorDia', (v) => v.toFixed(1))}</td>
              <td className={TD}>{rango('unidadesPorPedido', (v) => v.toFixed(1))}</td>
              <td className={TD}>{rango('tasaCancelacion', (v) => `${v.toFixed(0)}%`)}</td>
              <td className={TD}>{rango('ticketPromedio', (v) => formatCOP(Math.round(v)))}</td>
              <td className={TD}>{rango('tasaEntregaMadura', (v) => `${v.toFixed(0)}%`)}</td>
              <td className={TD} colSpan={2} />
              <td className={TD} />
              <td className={TD}>{rango('netoPorEntrega', (v) => formatCOP(Math.round(v)))}</td>
              <td className={TD}>{rango('cpaPorEntrega', (v) => formatCOP(Math.round(v)))}</td>
              <td className={TD}>{rango('contribucionPorEntrega', (v) => formatCOP(Math.round(v)))}</td>
              <td className={TD} colSpan={3} />
              <td className={TD} />
              <td className={TD}>{rango('tasaEquilibrio', (v) => `${v.toFixed(0)}%`)}</td>
              <td className={TD}>{rango('loQueQueda', (v) => `${v.toFixed(0)}%`)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="px-5 py-3 text-[11px] leading-relaxed text-muted-foreground border-t border-border/60">
        Todo está atribuido por <strong className="text-foreground">cohorte de pedido</strong>: la
        plata cae en el mes en que se generó el pedido, no en el que Dropi la pagó.{' '}
        <strong className="text-foreground">Bruto</strong> es lo que promete el panel de Dropi;{' '}
        <strong className="text-foreground">Operativo</strong> es lo que de verdad entró. El rango
        deja afuera los meses marcados <em>prelim</em>, que todavía están cobrando.
        {totales.roasReal != null && (
          <> Retorno cobrado del período: <strong className="text-foreground">{ratio(totales.roasReal)}</strong>.</>
        )}
      </p>
    </>
  );
}
