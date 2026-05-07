import { useMemo, useState, useEffect } from 'react';
import {
  BookOpenCheck, ChevronDown, ChevronRight, Camera, Save, X, Plus,
  AlertTriangle, CheckCircle2, Loader2, Clock, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  useCfoRetrospectives, useUpsertCfoRetrospective, useSnapshotCfoDiagnostico,
  type RetrospectiveRow, type Decision, type DecisionStatus,
} from '@/hooks/useCfoRetrospective';
import { formatCOP } from '@/lib/utils';

// /cfo → "Bitácora mensual"
//
// Una entrada por mes. Cada entrada tiene:
//   - Un snapshot inamovible de los números clave (botón "Capturar")
//   - Listas editables de FUGAS / ACIERTOS
//   - Decisiones con deadline + status (pendiente / hecho / abandonado)
//   - Lecciones y notas en texto libre
//
// Sirve para documentar mes a mes el por qué se ganó/perdió plata y no
// repetir errores. El snapshot queda CONGELADO (no se recalcula).

interface Props {
  defaultYearMonth: string;
}

const STATUS_LABEL: Record<DecisionStatus, string> = {
  pendiente:  'Pendiente',
  hecho:      'Hecho',
  abandonado: 'Abandonado',
};

const STATUS_TONE: Record<DecisionStatus, string> = {
  pendiente:  'text-orange border-orange/40 bg-orange/5',
  hecho:      'text-green border-green/40 bg-green/5',
  abandonado: 'text-muted-foreground border-border bg-muted/20',
};

function fmtMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
}

function monthsFromJanuaryThisYear(now = new Date()): string[] {
  const y = now.getFullYear();
  const out: string[] = [];
  for (let m = now.getMonth(); m >= 0; m -= 1) {
    out.push(`${y}-${String(m + 1).padStart(2, '0')}`);
  }
  return out;
}

export default function CfoMonthlyRetrospective({ defaultYearMonth }: Props) {
  const listQ = useCfoRetrospectives();
  const upsert = useUpsertCfoRetrospective();
  const snapshot = useSnapshotCfoDiagnostico();

  const monthsAvailable = useMemo(() => monthsFromJanuaryThisYear(), []);
  const existingByYM = useMemo(() => {
    const map = new Map<string, RetrospectiveRow>();
    for (const r of listQ.data ?? []) map.set(r.year_month, r);
    return map;
  }, [listQ.data]);

  const [expanded, setExpanded] = useState<string | null>(defaultYearMonth);

  if (listQ.isLoading) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 flex items-center justify-center gap-2 text-muted-foreground">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-sm">Cargando bitácora…</span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BookOpenCheck size={18} className="text-accent" />
          <h3 className="font-semibold text-sm">Bitácora mensual</h3>
          <span className="text-xs text-muted-foreground">
            ({existingByYM.size} {existingByYM.size === 1 ? 'mes documentado' : 'meses documentados'})
          </span>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Documentá cada mes <strong>fugas</strong> (qué quemó plata), <strong>aciertos</strong>,
        <strong> decisiones</strong> y <strong>lecciones</strong>. El botón &quot;Capturar diagnóstico&quot;
        congela los números del mes para que sigas teniendo la foto aunque cambie la data después.
      </p>

      <div className="space-y-2">
        {monthsAvailable.map((ym) => {
          const row = existingByYM.get(ym) ?? null;
          const isOpen = expanded === ym;
          return (
            <RetroCard
              key={ym}
              yearMonth={ym}
              row={row}
              isOpen={isOpen}
              onToggle={() => setExpanded(isOpen ? null : ym)}
              onSave={(params) => upsert.mutateAsync(params)}
              onSnapshot={() => snapshot.mutateAsync(ym)}
              isSaving={upsert.isPending}
              isSnapshotting={snapshot.isPending}
            />
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Card por mes — header colapsable + body editable
// ─────────────────────────────────────────────────────────────────

interface CardProps {
  yearMonth: string;
  row: RetrospectiveRow | null;
  isOpen: boolean;
  onToggle: () => void;
  onSave: (params: {
    year_month: string;
    fugas: string[];
    aciertos: string[];
    lecciones: string;
    decisiones: Decision[];
    notas: string;
  }) => Promise<RetrospectiveRow>;
  onSnapshot: () => Promise<RetrospectiveRow>;
  isSaving: boolean;
  isSnapshotting: boolean;
}

function RetroCard({
  yearMonth, row, isOpen, onToggle, onSave, onSnapshot, isSaving, isSnapshotting,
}: CardProps) {
  const [fugas, setFugas] = useState<string[]>([]);
  const [aciertos, setAciertos] = useState<string[]>([]);
  const [lecciones, setLecciones] = useState('');
  const [decisiones, setDecisiones] = useState<Decision[]>([]);
  const [notas, setNotas] = useState('');

  const [fugaInput, setFugaInput] = useState('');
  const [aciertoInput, setAciertoInput] = useState('');
  const [decAccion, setDecAccion] = useState('');
  const [decDeadline, setDecDeadline] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setFugas(row?.fugas ?? []);
    setAciertos(row?.aciertos ?? []);
    setLecciones(row?.lecciones ?? '');
    setDecisiones(row?.decisiones ?? []);
    setNotas(row?.notas ?? '');
    // T3-1: depender de updated_at, no de la ref de row. Cada refetch
    // background (staleTime 30s) crea nueva ref aunque la data sea idéntica
    // y disparaba reset perdiendo ediciones unsaved del usuario.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, row?.updated_at]);

  const diag = row?.diagnostico_auto ?? null;
  const hasSnapshot = !!diag && !!row?.diagnostico_at;

  async function handleSave() {
    try {
      await onSave({
        year_month: yearMonth,
        fugas, aciertos, lecciones, decisiones, notas,
      });
      toast.success('Retrospectiva guardada');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al guardar');
    }
  }

  async function handleSnapshot() {
    try {
      await onSnapshot();
      toast.success(`Diagnóstico capturado para ${fmtMonth(yearMonth)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al capturar diagnóstico');
    }
  }

  function addFuga() {
    const v = fugaInput.trim();
    if (!v) return;
    setFugas([...fugas, v]);
    setFugaInput('');
  }
  function addAcierto() {
    const v = aciertoInput.trim();
    if (!v) return;
    setAciertos([...aciertos, v]);
    setAciertoInput('');
  }
  function addDecision() {
    const v = decAccion.trim();
    if (!v) return;
    setDecisiones([...decisiones, {
      accion: v,
      deadline: decDeadline || null,
      status: 'pendiente',
    }]);
    setDecAccion('');
    setDecDeadline('');
  }

  return (
    <div className="rounded-md border border-border bg-card overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-center justify-between gap-2 hover:bg-muted/30 transition"
      >
        <div className="flex items-center gap-2 text-left">
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="text-sm font-medium capitalize">{fmtMonth(yearMonth)}</span>
          {row && (
            <div className="flex items-center gap-1.5 ml-2 flex-wrap">
              {row.fugas.length > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] text-red bg-red/10 border border-red/30 rounded px-1.5 py-0.5">
                  <AlertTriangle size={9} /> {row.fugas.length} {row.fugas.length === 1 ? 'fuga' : 'fugas'}
                </span>
              )}
              {row.aciertos.length > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] text-green bg-green/10 border border-green/30 rounded px-1.5 py-0.5">
                  <CheckCircle2 size={9} /> {row.aciertos.length} {row.aciertos.length === 1 ? 'acierto' : 'aciertos'}
                </span>
              )}
              {row.decisiones.length > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] text-orange bg-orange/10 border border-orange/30 rounded px-1.5 py-0.5">
                  <Clock size={9} /> {row.decisiones.filter(d => d.status === 'pendiente').length} pend
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasSnapshot ? (
            <span className="text-[10px] text-green inline-flex items-center gap-1">
              <Camera size={10} /> Diag capturado
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground">Sin diag</span>
          )}
        </div>
      </button>

      {isOpen && (
        <div className="border-t border-border p-3 space-y-4 text-xs">
          <div className="rounded border border-border/50 bg-muted/10 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-semibold flex items-center gap-1.5">
                <Camera size={12} className="text-accent" />
                Diagnóstico (números congelados)
              </h4>
              <Button
                size="sm"
                variant="outline"
                onClick={handleSnapshot}
                disabled={isSnapshotting}
                className="h-7 text-[11px]"
              >
                {isSnapshotting ? <Loader2 size={11} className="animate-spin mr-1" /> : <Camera size={11} className="mr-1" />}
                {hasSnapshot ? 'Re-capturar ahora' : 'Capturar ahora'}
              </Button>
            </div>

            {hasSnapshot && diag ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <DiagItem label="Ingresos"       value={diag.ingresos} kind="cop" />
                <DiagItem label="Utilidad bruta" value={diag.utilidad_bruta} kind="cop" />
                <DiagItem label="Pauta total"    value={diag.ads_total} kind="cop" tone="warn" />
                <DiagItem label="Wallet neto"    value={diag.wallet_neto} kind="cop" tone="success" />
                <DiagItem label="Pedidos"        value={diag.total_ordenes} kind="int" />
                <DiagItem label="Entregados"     value={diag.entregados} kind="int" tone="success" />
                <DiagItem label="Tasa entrega"   value={diag.tasa_entrega} kind="pct" />
                <DiagItem label="Tasa devol."    value={diag.tasa_devolucion} kind="pct" tone="danger" />
                <DiagItem label="Meta ads"       value={diag.ads_meta} kind="cop" />
                <DiagItem label="TikTok ads"     value={diag.ads_tiktok} kind="cop" />
                <DiagItem label="Deuda TC USD"   value={diag.tc_debt_usd} kind="usd" tone="danger" />
                <DiagItem label="Deuda TC COP"   value={diag.tc_debt_cop} kind="cop" tone="danger" />
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground italic">
                Sin diagnóstico. Click en &quot;Capturar ahora&quot; para congelar los números del mes.
              </p>
            )}
            {row?.diagnostico_at && (
              <p className="text-[10px] text-muted-foreground">
                Capturado: {new Date(row.diagnostico_at).toLocaleString('es-CO')}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1.5">
              <AlertTriangle size={11} className="text-red" />
              Fugas (qué quemó plata este mes)
            </Label>
            <ChipList
              items={fugas}
              onRemove={(i) => setFugas(fugas.filter((_, idx) => idx !== i))}
              tone="danger"
            />
            <div className="flex gap-1.5">
              <Input
                value={fugaInput}
                onChange={(e) => setFugaInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addFuga(); } }}
                placeholder="Ej: FB USD sin ROAS · Quibdó devolución 65%"
                className="h-8 text-xs"
              />
              <Button size="sm" variant="outline" onClick={addFuga} className="h-8 px-2">
                <Plus size={12} />
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1.5">
              <CheckCircle2 size={11} className="text-green" />
              Aciertos (qué funcionó)
            </Label>
            <ChipList
              items={aciertos}
              onRemove={(i) => setAciertos(aciertos.filter((_, idx) => idx !== i))}
              tone="success"
            />
            <div className="flex gap-1.5">
              <Input
                value={aciertoInput}
                onChange={(e) => setAciertoInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAcierto(); } }}
                placeholder="Ej: CPP CLON 12 ROAS 6.6x · TikTok ganó tracción"
                className="h-8 text-xs"
              />
              <Button size="sm" variant="outline" onClick={addAcierto} className="h-8 px-2">
                <Plus size={12} />
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1.5">
              <Clock size={11} className="text-orange" />
              Decisiones (acción + deadline + status)
            </Label>
            <div className="space-y-1.5">
              {decisiones.map((d, i) => (
                <div key={i} className={`flex items-center gap-2 rounded border px-2 py-1.5 ${STATUS_TONE[d.status]}`}>
                  <span className="flex-1 text-xs">{d.accion}</span>
                  {d.deadline && (
                    <span className="text-[10px] opacity-80">→ {d.deadline}</span>
                  )}
                  <Select
                    value={d.status}
                    onValueChange={(v: DecisionStatus) => {
                      const next = [...decisiones];
                      next[i] = { ...d, status: v };
                      setDecisiones(next);
                    }}
                  >
                    <SelectTrigger className="h-6 text-[10px] w-28 border-0 bg-transparent">
                      <SelectValue>{STATUS_LABEL[d.status]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pendiente">Pendiente</SelectItem>
                      <SelectItem value="hecho">Hecho</SelectItem>
                      <SelectItem value="abandonado">Abandonado</SelectItem>
                    </SelectContent>
                  </Select>
                  <button
                    onClick={() => setDecisiones(decisiones.filter((_, idx) => idx !== i))}
                    className="text-muted-foreground hover:text-red"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-1.5">
              <Input
                value={decAccion}
                onChange={(e) => setDecAccion(e.target.value)}
                placeholder="Acción a tomar (ej: Migrar pauta Meta a cuenta COP)"
                className="h-8 text-xs flex-1"
              />
              <Input
                type="date"
                value={decDeadline}
                onChange={(e) => setDecDeadline(e.target.value)}
                className="h-8 text-xs w-36"
              />
              <Button size="sm" variant="outline" onClick={addDecision} className="h-8 px-2">
                <Plus size={12} />
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Lecciones (no repetir)</Label>
            <Textarea
              value={lecciones}
              onChange={(e) => setLecciones(e.target.value)}
              placeholder="Resumen narrativo de qué aprendiste este mes…"
              className="text-xs min-h-[60px]"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Notas adicionales</Label>
            <Textarea
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              placeholder="Cualquier contexto extra (eventos, cambios de equipo, etc.)"
              className="text-xs min-h-[40px]"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1 border-t border-border/30">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={isSaving}
              className="h-8 text-xs"
            >
              {isSaving ? <Loader2 size={11} className="animate-spin mr-1" /> : <Save size={11} className="mr-1" />}
              Guardar retrospectiva
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Helpers de UI
// ─────────────────────────────────────────────────────────────────

function ChipList({ items, onRemove, tone }: {
  items: string[];
  onRemove: (i: number) => void;
  tone: 'success' | 'danger';
}) {
  if (items.length === 0) return (
    <p className="text-[11px] text-muted-foreground italic">— sin items —</p>
  );
  const toneClass = tone === 'success'
    ? 'bg-green/10 text-green border-green/30'
    : 'bg-red/10 text-red border-red/30';
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item, i) => (
        <span
          key={`${i}-${item}`}
          className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border ${toneClass}`}
        >
          {item}
          <button
            onClick={() => onRemove(i)}
            className="opacity-60 hover:opacity-100"
          >
            <X size={10} />
          </button>
        </span>
      ))}
    </div>
  );
}

function DiagItem({ label, value, kind, tone }: {
  label: string;
  value: number | null | undefined;
  kind: 'cop' | 'usd' | 'int' | 'pct';
  tone?: 'success' | 'danger' | 'warn';
}) {
  const toneCls = tone === 'success' ? 'text-green'
    : tone === 'danger' ? 'text-red'
    : tone === 'warn' ? 'text-orange'
    : 'text-foreground';
  let display = '—';
  if (value !== null && value !== undefined && Number.isFinite(value)) {
    if (kind === 'cop')      display = formatCOP(Number(value));
    else if (kind === 'usd') display = `USD ${Number(value).toFixed(2)}`;
    else if (kind === 'pct') display = `${(Number(value) * (Number(value) <= 1 ? 100 : 1)).toFixed(1)}%`;
    else                     display = String(Math.round(Number(value)));
  }
  return (
    <div className="rounded bg-card border border-border/40 px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`text-xs font-semibold tabular-nums ${toneCls}`}>{display}</div>
    </div>
  );
}
