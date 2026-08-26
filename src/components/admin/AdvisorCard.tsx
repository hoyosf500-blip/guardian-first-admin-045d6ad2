import { useState } from 'react';
import { ChevronDown, Gauge, LogIn, AlertTriangle, Check, CircleAlert } from 'lucide-react';
import { formatTimeBogota, formatDurationHM } from '@/lib/timeFormat';
import type { AdvisorVM, Tono, Atencion } from '@/lib/advisorCardVM';

/**
 * AdvisorCard — UNA tarjeta por asesor (rediseño Productividad, 26-ago-2026).
 * Presentacional PURO: recibe el VM ya calculado (advisorCardVM) y solo dibuja.
 * La cara cuenta la historia de un vistazo; el detalle hondo va plegado en
 * "Ver detalle". Usa los tokens de Guardian (aurora oscura), no colores sueltos.
 *
 * Guarda de honestidad heredada del VM: un dato en null se pinta "—", nunca 0.
 */

const EDGE: Record<Atencion, string> = {
  bad: 'bg-danger', warn: 'bg-warning', good: 'bg-success', idle: 'bg-muted-foreground/40',
};
const CARD_RING: Record<Atencion, string> = {
  bad: 'border-danger/30', warn: 'border-border', good: 'border-border', idle: 'border-border',
};
const TXT: Record<Tono, string> = {
  good: 'text-success', warn: 'text-warning', bad: 'text-danger', muted: 'text-muted-foreground',
};
const FLAG: Record<Atencion, string> = {
  bad: 'border-danger/25 bg-danger/10 text-danger',
  warn: 'border-warning/24 bg-warning/10 text-warning',
  good: 'border-success/22 bg-success/10 text-success',
  idle: 'border-border bg-muted/30 text-muted-foreground',
};
const RING_HSL: Record<Tono, string> = {
  good: 'hsl(var(--success))', warn: 'hsl(var(--warning))', bad: 'hsl(var(--danger))', muted: 'hsl(var(--muted-foreground))',
};

/** Color del aro del % del día según qué tan lejos de la meta. */
function ringTone(pct: number | null): Tono {
  if (pct == null) return 'muted';
  if (pct >= 85) return 'good';
  if (pct >= 60) return 'warn';
  return 'bad';
}

const hm = (sec: number | null | undefined) =>
  sec == null ? '—' : formatDurationHM(sec);
const hmMin = (min: number | null | undefined) =>
  min == null ? '—' : formatDurationHM(min * 60);

/** Mini-stat con etiqueta en cristiano y guarda "—". */
function Stat({ label, value, tone, sub }: { label: string; value: React.ReactNode; tone?: Tono; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card/40 px-2 py-2 text-center">
      <span className={`block font-mono tabular-nums text-lg font-bold leading-none ${tone ? TXT[tone] : 'text-foreground'}`}>
        {value}
      </span>
      <span className="block text-[10px] uppercase tracking-[0.05em] text-muted-foreground mt-1.5">{label}</span>
      {sub && <span className="block text-[9px] text-muted-foreground/70 mt-0.5">{sub}</span>}
    </div>
  );
}

/** Barritas de gestiones por hora del turno. */
function Barritas({ serie }: { serie: { hora: number; cantidad: number }[] }) {
  if (serie.length === 0) return null;
  const max = Math.max(1, ...serie.map((s) => s.cantidad));
  return (
    <span className="inline-flex items-end gap-[2px] h-6" role="img" aria-label="Gestiones por hora">
      {serie.map((s) => {
        const px = s.cantidad === 0 ? 2 : Math.max(3, Math.round((s.cantidad / max) * 22));
        return (
          <span
            key={s.hora}
            className={`w-[4px] rounded-sm ${s.cantidad === 0 ? 'bg-muted-foreground/25' : 'bg-accent/70'}`}
            style={{ height: `${px}px` }}
            title={`${s.hora}:00 — ${s.cantidad} ${s.cantidad === 1 ? 'gestión' : 'gestiones'}`}
          />
        );
      })}
    </span>
  );
}

export default function AdvisorCard({
  vm, isToday, onInactivityDetail,
}: {
  vm: AdvisorVM;
  isToday: boolean;
  onInactivityDetail?: (id: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rt = ringTone(vm.tasaDia);
  const d = vm.detalle;
  const serie = isToday ? vm.hourly : [];

  return (
    <article className={`relative flex flex-col gap-3.5 overflow-hidden rounded-2xl border ${CARD_RING[vm.atencion]} bg-card/40 shadow-card3d hairline-top p-4`}>
      <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${EDGE[vm.atencion]}`} aria-hidden="true" />

      {/* Identidad + estado en vivo */}
      <div className="flex items-center gap-2.5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/30 bg-accent/15 text-accent font-bold text-sm">
          {vm.initials}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-foreground truncate leading-tight" title={vm.name}>{vm.name}</h3>
          {vm.estadoTexto && (
            <span className={`inline-flex items-center gap-1.5 text-[11px] leading-tight ${vm.enLinea ? 'text-success' : 'text-muted-foreground'}`}>
              <span className={`relative h-2 w-2 rounded-full ${vm.estado === 'trabajando' ? 'bg-success' : vm.estado === 'presente_sin_marcar' ? 'bg-warning' : 'bg-muted-foreground/50'}`}>
                {vm.estado === 'trabajando' && <span className="absolute inset-0 rounded-full bg-success animate-ping opacity-75" />}
              </span>
              {vm.estadoTexto}
            </span>
          )}
        </div>
      </div>

      {/* Cabecera: confirmó (grande) + % del día (aro) */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-end gap-1.5">
            <span className="font-mono tabular-nums text-4xl font-bold leading-none text-foreground">{vm.confirmados}</span>
          </div>
          <span className="block text-xs text-muted-foreground mt-1">confirmó {isToday ? 'hoy' : 'en el rango'}</span>
          <span className="block text-[11px] text-muted-foreground/70">de {vm.trabajo} pedidos que trabajó</span>
        </div>
        <div className="relative shrink-0" style={{ width: 76, height: 76 }} title={vm.tasaDia == null ? 'Sin pedidos trabajados aún.' : `Confirmó ${vm.confirmados} de ${vm.trabajo} que trabajó`}>
          <svg viewBox="0 0 36 36" className="h-full w-full -rotate-90">
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="hsl(var(--foreground) / 0.1)" strokeWidth="3.2" />
            {vm.tasaDia != null && (
              <circle cx="18" cy="18" r="15.5" fill="none" stroke={RING_HSL[rt]} strokeWidth="3.2"
                strokeDasharray={`${vm.tasaDia} 100`} pathLength={100} strokeLinecap="round" />
            )}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={`font-mono tabular-nums text-lg font-bold leading-none ${vm.tasaDia == null ? 'text-muted-foreground' : TXT[rt]}`}>
              {vm.tasaDia == null ? '—' : `${vm.tasaDia}%`}
            </span>
            <span className="text-[8px] uppercase tracking-[0.08em] text-muted-foreground mt-0.5">del día</span>
          </div>
        </div>
      </div>

      {/* Ritmo en vivo + entrada + barritas por hora */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border bg-card/40 px-3 py-2">
        <span className={`inline-flex items-baseline gap-1 font-semibold ${TXT[vm.ritmoTono]}`}
          title={`Velocidad ${isToday ? 'ahora' : 'del rango'} (gestiones por hora).${isToday ? ' Óptimo 25/h · rojo bajo 15/h.' : ''}`}>
          <Gauge size={13} className="self-center" aria-hidden="true" />
          <span className="font-mono tabular-nums text-lg leading-none">{vm.ritmoPorHora == null ? '—' : vm.ritmoPorHora}</span>
          <span className="text-[11px] text-muted-foreground font-normal">por hora</span>
          {vm.ritmoTag && <span className="text-[11px] font-semibold">· {vm.ritmoTag}</span>}
        </span>
        {isToday && serie.length > 0 && <span className="ml-auto"><Barritas serie={serie} /></span>}
        {vm.ritmoCount != null && (
          <span className="w-full text-[11px] text-muted-foreground">
            marcó <b className="font-mono tabular-nums font-semibold text-foreground">{vm.ritmoCount}</b> {vm.ritmoCount === 1 ? 'gestión' : 'gestiones'}
            {vm.ritmoElapsedMin != null && <> en <b className="font-semibold text-foreground">{hmMin(vm.ritmoElapsedMin)}</b>{isToday ? '' : ' de trabajo'}</>}
            {' '}— el {vm.ritmoPorHora == null ? 'ritmo' : `${vm.ritmoPorHora}`} es <b className="font-semibold text-foreground">por hora</b>, no pedidos sueltos
          </span>
        )}
        {isToday && vm.entroHora && (
          <span className={`inline-flex w-full items-center gap-1.5 text-[11px] ${vm.tardeMin ? 'text-danger font-semibold' : 'text-muted-foreground'}`}>
            <LogIn size={12} aria-hidden="true" />
            entró <b className="text-foreground font-semibold">{formatTimeBogota(vm.entroHora)}</b>
            {vm.tardeMin ? ` · ${hmMin(vm.tardeMin)} tarde` : <span className="text-success font-semibold">· puntual</span>}
          </span>
        )}
      </div>

      {/* Métricas de la cara — etiquetas en cristiano */}
      <div className="grid grid-cols-4 gap-2">
        <Stat label="trabajó" value={vm.trabajo} />
        <Stat label="contestaron" value={vm.contestaron} tone={vm.contestaron > 0 ? 'good' : undefined} />
        <Stat label="no contestó" value={vm.noContesto} tone={vm.noContesto > 0 ? 'warn' : undefined} />
        <Stat label="devoluciones" value={vm.devoluciones == null ? '—' : vm.devoluciones} tone={vm.devoluciones && vm.devoluciones > 0 ? 'bad' : undefined} />
      </div>

      {/* Seguimiento / Novedades en la CARA — el trabajo que Confirmar no cuenta */}
      {(d.segAcciones > 0 || d.novResueltas > 0) && (
        <div className="-mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 px-0.5 text-[11px] text-muted-foreground">
          {d.segAcciones > 0 && (
            <span>Seguimiento <b className="font-mono tabular-nums text-foreground">{d.segAcciones}</b>
              {d.segTasa != null && <span className="text-muted-foreground/70"> · {d.segTasa}% resuelto</span>}</span>
          )}
          {d.novResueltas > 0 && (
            <span>Novedades <b className="font-mono tabular-nums text-foreground">{d.novResueltas}</b> resueltas</span>
          )}
        </div>
      )}

      {/* Bandera de atención — el porqué, en cristiano */}
      {vm.atencion !== 'idle' && vm.motivos.length > 0 ? (
        <div className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-[12px] font-medium ${FLAG[vm.atencion]}`}>
          {vm.atencion === 'bad' ? <CircleAlert size={14} className="mt-px shrink-0" aria-hidden="true" />
            : <AlertTriangle size={14} className="mt-px shrink-0" aria-hidden="true" />}
          <span>{vm.motivos.join(' · ')}</span>
        </div>
      ) : vm.atencion === 'good' ? (
        <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-medium ${FLAG.good}`}>
          <Check size={14} className="shrink-0" aria-hidden="true" />
          <span>Al día{vm.tardeMin ? '' : isToday ? ' · puntual' : ''}.</span>
        </div>
      ) : vm.atencion === 'idle' ? (
        <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-[12px] ${FLAG.idle}`}>
          <span>Sin señal {isToday ? 'hoy' : 'en el rango'}. "—" = no medido, nunca un cero que acuse.</span>
        </div>
      ) : null}

      {/* Ver detalle */}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card/40 py-1.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {open ? 'Ocultar detalle' : 'Ver detalle'}
        <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-border/60 pt-3 text-[12px]">
          {/* Calidad */}
          <DetalleGrupo titulo="Calidad"
            nota="«Direcciones malas» = de lo que confirmó y YA se despachó, cuánto salió con la dirección en rojo del validador. Dato nuevo (desde el 22-ago) y por heurística — señal para revisar, no sentencia. En «—» = todavía no hay con qué medir.">
            <DetalleItem label="Tasa de devolución" value={d.tasaDevolucion == null ? '—' : `${d.tasaDevolucion}%`}
              tone={d.tasaDevolucion != null && d.tasaDevolucion >= 15 ? 'bad' : d.tasaDevolucion != null && d.tasaDevolucion >= 10 ? 'warn' : 'muted'} />
            <DetalleItem label="Direcciones malas" value={d.dirMalas == null ? '—' : `${d.dirMalas}%`}
              tone={d.dirMalas != null && d.dirMalas >= 30 ? 'bad' : d.dirMalas != null && d.dirMalas >= 15 ? 'warn' : 'muted'}
              hint="de lo que confirmó y ya se despachó, cuánto salió con la dirección en rojo" />
            <DetalleItem label="Devoluciones evitables" value={d.evitables} />
          </DetalleGrupo>

          {/* Confirmar (hondo) */}
          <DetalleGrupo titulo="Confirmar">
            <DetalleItem label="Canceló" value={d.cancelados} tone={d.cancelados > 0 ? 'bad' : 'muted'} />
            <DetalleItem label="Siguen sin cerrar" value={d.sinCerrarAun} />
            <DetalleItem label="Contactó (de lo que entró)" value={d.contactoPct == null ? '—' : `${d.contactoPct}%`}
              hint={d.contactoFaltan == null ? undefined : `faltan ${d.contactoFaltan} por contactar`} />
            <DetalleItem label="Pedidos por hora" value={d.clientesHora == null ? '—' : d.clientesHora}
              hint="los que contestaron ÷ horas trabajadas (producción)" />
            <DetalleItem label="Veces que marcó por hora" value={d.llamadasHora == null ? '—' : d.llamadasHora} tone={d.llamadasHoraTono}
              hint="todas las llamadas, incl. las que no contestaron (esfuerzo)" />
          </DetalleGrupo>

          {/* Jornada */}
          <DetalleGrupo titulo="Jornada"
            nota="«Estuvo en el horario» es PRESENCIA (entró a tiempo y sigue conectada), no cuánto trabajó — por eso puede ir en 96% con pocas horas de trabajo medido. La diferencia entre «horas presente» y «con trabajo medido» es la que hay que mirar.">
            <DetalleItem label="Estuvo en el horario" value={d.cumplioPct == null ? '—' : `${d.cumplioPct}%`}
              hint="entró a tiempo y sigue conectada; NO es cuánto trabajó" />
            <DetalleItem label="Horas presente" value={hm(d.presenciaSec ?? d.enCrmSec)}
              hint="desde que entró hasta su última señal, dentro del horario" />
            <DetalleItem label="Con trabajo medido" value={hm(d.trabajandoSec)}
              tone={d.trabajandoSec != null && d.presenciaSec != null && d.presenciaSec > 0 && d.trabajandoSec < d.presenciaSec * 0.6 ? 'warn' : 'muted'}
              hint="tiempo con acciones reales (marcar, notas). Muy por debajo de «horas presente» = presente pero flojo" />
            <DetalleItem label="Con el CRM abierto" value={hm(d.enCrmSec)} hint={d.fueraSec ? `${hm(d.fueraSec)} fuera` : undefined} />
            <DetalleItem label="Minutos por pedido" value={d.minPorPedido == null ? '—' : `${d.minPorPedido} min`} />
            {isToday && (
              <DetalleItem label="Sin marcar hace" value={d.sinGestionMin == null ? '—' : `${d.sinGestionMin} min`}
                tone={d.sinGestionMin != null && d.sinGestionMin >= 20 ? 'bad' : d.sinGestionMin != null && d.sinGestionMin >= 12 ? 'warn' : 'muted'}
                hint={d.peorHuecoMin && d.peorHuecoMin >= 15 ? `peor hueco: ${d.peorHuecoMin} min` : undefined} />
            )}
            <button
              type="button"
              onClick={() => d.avisos > 0 && onInactivityDetail?.(vm.operatorId, vm.name)}
              className={`flex items-center justify-between gap-2 rounded-lg border border-border bg-card/40 px-2.5 py-1.5 text-left ${d.avisos > 0 ? 'cursor-pointer hover:border-border-strong' : 'cursor-default'}`}
              title={d.avisos > 0 ? 'Ver cada aviso con su hora' : 'Sin avisos de inactividad'}
            >
              <span className="text-[10px] uppercase tracking-[0.05em] text-muted-foreground">Avisos sin trabajar</span>
              <span className={`font-mono tabular-nums font-bold ${d.avisos >= 3 ? 'text-danger' : d.avisos > 0 ? 'text-warning' : 'text-success'}`}>
                {d.avisos}{d.avisos > 0 ? ` · ${d.avisosMin} min` : ''}
              </span>
            </button>
            <DetalleItem
              label="Salió"
              value={d.salioTexto === 'cierre' && d.cierreIso ? formatTimeBogota(d.cierreIso) : d.salioTexto === 'en línea' ? 'en línea' : d.salioTexto === 'sin cierre' ? 'sin cierre' : '—'}
              tone={d.salioTexto === 'sin cierre' ? 'warn' : 'muted'}
              hint={d.cierreTempranoMin > 0 ? `${hmMin(d.cierreTempranoMin)} antes` : d.trabajoExtraMin > 0 ? `${hmMin(d.trabajoExtraMin)} más` : undefined} />
          </DetalleGrupo>

          {/* Mezcla — descreme */}
          {(d.dificiles + d.faciles + d.otrosMezcla) > 0 && (
            <div>
              <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground font-semibold">Qué tipo de pedidos agarró</span>
              <div className="mt-1.5 flex h-3 w-full overflow-hidden rounded-full bg-muted/40"
                role="img" aria-label={`${d.dificiles} difíciles, ${d.faciles} fáciles`}>
                {d.dificiles > 0 && <div className="h-full bg-danger" style={{ width: `${(d.dificiles / (d.dificiles + d.faciles + d.otrosMezcla)) * 100}%` }} title={`${d.dificiles} difíciles (llamar/convencer)`} />}
                {d.faciles > 0 && <div className="h-full bg-success" style={{ width: `${(d.faciles / (d.dificiles + d.faciles + d.otrosMezcla)) * 100}%` }} title={`${d.faciles} fáciles (ya confirmó)`} />}
                {d.otrosMezcla > 0 && <div className="h-full bg-muted-foreground/40" style={{ width: `${(d.otrosMezcla / (d.dificiles + d.faciles + d.otrosMezcla)) * 100}%` }} title={`${d.otrosMezcla} sin leer`} />}
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
                <span><b className="text-danger">{d.dificiles}</b> difíciles · <b className="text-success">{d.faciles}</b> fáciles</span>
                <span title="% difícil de lo clasificable — bajo = descrema">{d.pctDificiles == null ? '—' : `${d.pctDificiles}% difícil`}</span>
              </div>
            </div>
          )}

          {/* Seguimiento / Novedades */}
          <DetalleGrupo titulo="Seguimiento y novedades">
            <DetalleItem label="Seguimiento · acciones" value={d.segAcciones} />
            <DetalleItem label="Seguimiento · resueltos" value={d.segResueltos} tone={d.segResueltos > 0 ? 'good' : 'muted'} />
            <DetalleItem label="Seguimiento · tasa" value={d.segTasa == null ? '—' : `${d.segTasa}%`} />
            <DetalleItem label="Novedades resueltas" value={d.novResueltas} tone={d.novResueltas > 0 ? 'good' : 'muted'} />
          </DetalleGrupo>
        </div>
      )}
    </article>
  );
}

function DetalleGrupo({ titulo, nota, children }: { titulo: string; nota?: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground font-semibold">{titulo}</span>
      {nota && <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground/70">{nota}</p>}
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">{children}</div>
    </div>
  );
}

function DetalleItem({ label, value, tone = 'muted', hint }: { label: string; value: React.ReactNode; tone?: Tono; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card/40 px-2.5 py-1.5" title={hint}>
      <span className="text-[10px] uppercase tracking-[0.04em] text-muted-foreground leading-tight">{label}</span>
      <span className={`font-mono tabular-nums font-bold shrink-0 ${tone === 'muted' ? 'text-foreground' : TXT[tone]}`}>{value}</span>
    </div>
  );
}
