import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { CheckCircle2, ListChecks, Hourglass, Users, AlertTriangle, Eye, SkipForward, Target } from 'lucide-react';
import { bogotaToday } from '@/lib/utils';
import { isSegCloser } from '@/lib/segDailyReview';
import { useBitacoraDia } from '@/hooks/useBitacoraDia';
import { useStoreSchedule } from '@/hooks/useStoreSchedule';
import { scheduleFromMinutes, bogotaSecondsOfDay } from '@/lib/inactivityWindow';
import { horarioNetoSeconds, horarioNetoTranscurridoSec } from '@/lib/jornadaMath';
import { metaGestionesDelRango, nivelMeta } from '@/lib/responsabilidadAsesor';

/**
 * Barra de productividad para Seguimiento. Cuenta touchpoints "SEG:*"
 * del día. Realtime: refresca al insertarse un touchpoint nuevo.
 *
 * Antes era SegRescueCounterBar y soportaba módulo "RESCUE"; el módulo
 * Rescate se eliminó (2026-05-08) y las listas SLA de /seguimiento ya
 * cubren los casos. Esto quedó single-purpose.
 *
 * "Resuelto" cuenta los cierres (Resuelto/Devolución) vía isSegCloser, que
 * también reconoce los labels viejos para los touchpoints históricos.
 *
 * HONESTIDAD DE DATOS: los ceros de esta barra alimentan la percepción de
 * desempeño de la asesora, así que NO pueden salir de una consulta que falló
 * ni de un estado sin leer todavía. `status` distingue los tres casos —
 * 'loading' (aún no preguntamos), 'error' (no pudimos leer la base) y 'ok'
 * (los números son una medición real). Solo en 'ok' se pintan contadores.
 */

interface Stats {
  myActions: number;
  myResolved: number;
  teamActions: number;
  teamResolved: number;
}

export default function SegCounterBar() {
  const { user, isAdmin } = useAuth();
  const { activeStoreId, isOwnerOfActive } = useStore();
  const [stats, setStats] = useState<Stats>({
    myActions: 0, myResolved: 0, teamActions: 0, teamResolved: 0,
  });
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');

  const refetch = useCallback(async () => {
    // Sin usuario o sin tienda activa todavía no hay a quién preguntarle:
    // se queda en 'loading', NUNCA en ceros que parezcan medidos.
    if (!user || !activeStoreId) return;
    const today = bogotaToday();
    const { data, error } = await supabase
      .from('touchpoints')
      .select('action, operator_id')
      .eq('action_date', today)
      .eq('store_id', activeStoreId)
      .like('action', 'SEG:%');
    if (error || !data) { setStatus('error'); return; }
    let mA = 0, mR = 0, tA = 0, tR = 0;
    data.forEach(t => {
      const isResolving = isSegCloser(t.action);
      tA++;
      if (isResolving) tR++;
      if (t.operator_id === user.id) {
        mA++;
        if (isResolving) mR++;
      }
    });
    setStats({ myActions: mA, myResolved: mR, teamActions: tA, teamResolved: tR });
    setStatus('ok');
  }, [user, activeStoreId]);

  useEffect(() => { void refetch(); }, [refetch]);

  useEffect(() => {
    if (!user || !activeStoreId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void refetch(); }, 400);
    };
    const channel = supabase
      .channel(`tp-stats-seg-${user.id}-${activeStoreId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'touchpoints', filter: `store_id=eq.${activeStoreId}` },
        debounced,
      )
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [user, activeStoreId, refetch]);

  // ── Su propio registro y su meta (3-sep-2026) ───────────────────────────────
  //
  // Pedido del dueño: *"que el asesor sepa que cualquier acción que haga se
  // registra"*. La bitácora ya existía y ella ya podía entrar a /actividad, pero
  // no estaba donde trabaja. **Saber que está anotado, y poder verlo, es lo que
  // presiona** — y después nadie puede alegar que no sabía.
  //
  // Va SIN ranking entre compañeras, decisión del dueño: la competencia abierta
  // empuja al descreme (agarrar solo los pedidos fáciles), que es justo lo que
  // `MezclaTrabajoPanel` existe para detectar.
  const { resumen: bitacora, estado: estadoBitacora } = useBitacoraDia(activeStoreId, bogotaToday(), user?.id ?? null);
  const mio = bitacora[0] ?? null;

  // La META, que hasta hoy solo alimentaba el semáforo del dueño y ella nunca
  // veía. Prorrateada al turno transcurrido con la función que ya existe: a las
  // 10:30 exigirle el día entero sería una vara falsa.
  const scheduleQuery = useStoreSchedule(activeStoreId);
  const meta = (() => {
    if (!scheduleQuery.isSuccess || !scheduleQuery.data) return null;
    const s = scheduleFromMinutes(scheduleQuery.data);
    const neto = horarioNetoSeconds(s);
    if (neto <= 0) return null;
    const transcurrido = horarioNetoTranscurridoSec(s, bogotaSecondsOfDay(new Date()));
    const m = metaGestionesDelRango('today', transcurrido / neto);
    return m > 0 ? m : null;
  })();
  const nivel = meta != null ? nivelMeta(stats.myActions, meta) : null;
  const metaTono =
    nivel === 'optimo' ? 'text-success'
    : nivel === 'aceptable' ? 'text-warning'
    : nivel === 'lento' ? 'text-danger'
    : 'text-muted-foreground';

  // El jefe (admin o dueño) no ve la barra de cola personal de operadora.
  if (!user || isAdmin || isOwnerOfActive) return null;

  // La consulta falló: decirlo explícitamente. Un 0 que en realidad significa
  // "no pude leer la base" es una cifra inventada — y acá se lee como "no
  // trabajaste hoy". Mismo patrón que el aviso de equipo en DashboardTab.
  if (status === 'error') {
    return (
      <div className="bg-card/40 border border-danger/30 rounded-2xl p-3.5 mb-4 flex items-start gap-2.5 shadow-card3d">
        <AlertTriangle size={14} className="text-danger shrink-0 mt-0.5" aria-hidden="true" />
        <p className="text-[11px] leading-relaxed text-danger">
          <span className="font-semibold">No se pudieron cargar tus stats de hoy.</span>{' '}
          <span className="text-muted-foreground">
            Esto NO significa que no trabajaste: significa que no se pudo leer la base.
            Recargá la página; si sigue igual, avisá.
          </span>
        </p>
      </div>
    );
  }

  // Todavía no leímos nada. Mostrar ceros acá sería afirmar una medición que
  // no hicimos, así que se rotula el estado real.
  if (status === 'loading') {
    return (
      <div className="bg-card/40 border border-border rounded-2xl p-3.5 mb-4 flex items-center shadow-card3d">
        <span className="text-[11px] text-muted-foreground">Cargando tu productividad de hoy…</span>
      </div>
    );
  }

  const pendientes = Math.max(0, stats.myActions - stats.myResolved);

  // null = todavía no registraste acciones hoy → no hay tasa que calcular.
  // Antes caía a 0, que se leía como "0% de resolución" (un veredicto) sobre
  // una muestra vacía.
  const tasa = stats.myActions > 0 ? Math.round((stats.myResolved / stats.myActions) * 100) : null;
  const tasaTone =
    tasa === null ? 'bg-muted/60 text-muted-foreground border-border'
    : tasa >= 50 ? 'bg-success/14 text-success border-success/30'
    : tasa >= 25 ? 'bg-warning/14 text-warning border-warning/30'
    : 'bg-muted/60 text-muted-foreground border-border';

  return (
    <div className="bg-card/40 border border-border rounded-2xl p-3.5 mb-4 shadow-card3d">
    <div className="flex items-center gap-4 flex-wrap">
      {/* Rótulo de la barra (espeja "Equipo hoy" de CounterBar). Se oculta en
          celular para no apretar la fila: las asesoras trabajan desde el móvil. */}
      <span className="text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground shrink-0 hidden sm:inline">
        Productividad hoy
      </span>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-sm">
          <div className="w-6 h-6 rounded-lg bg-info/14 border border-info/30 flex items-center justify-center">
            <ListChecks size={13} className="text-info" aria-hidden="true" />
          </div>
          <span className="font-mono text-sm font-bold text-foreground tabular-nums">{stats.myActions}</span>
          <span className="text-xs text-muted-foreground">acciones</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm">
          <div className="w-6 h-6 rounded-lg bg-success/14 border border-success/30 flex items-center justify-center">
            <CheckCircle2 size={13} className="text-success" aria-hidden="true" />
          </div>
          <span className="font-mono text-sm font-bold text-foreground tabular-nums">{stats.myResolved}</span>
          <span className="text-xs text-muted-foreground">resueltos</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm">
          <div className="w-6 h-6 rounded-lg bg-warning/14 border border-warning/30 flex items-center justify-center">
            <Hourglass size={13} className="text-warning" aria-hidden="true" />
          </div>
          <span className="font-mono text-sm font-bold text-foreground tabular-nums">{pendientes}</span>
          <span className="text-xs text-muted-foreground">pendientes</span>
        </div>
      </div>
      <div className="flex items-center gap-2 ml-auto">
        <span
          className={`text-[11px] font-semibold px-2 py-1 rounded-md border tabular-nums ${tasaTone}`}
          title={tasa === null ? 'Todavía no registraste acciones hoy: no hay tasa que calcular.' : undefined}
        >
          Resolución {tasa === null ? '—' : `${tasa}%`}
        </span>
        <div className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground border-l border-border pl-3">
          <Users size={12} aria-hidden="true" />
          <span>Equipo</span>
          <span className="font-mono font-bold text-foreground tabular-nums">{stats.teamActions}</span>
          <span>/</span>
          <span className="font-mono text-success tabular-nums">{stats.teamResolved}</span>
          <span>resueltos</span>
        </div>
      </div>
    </div>

    {/* ── Su propio registro, donde trabaja ─────────────────────────────────
        Pedido del dueño: que la asesora sepa que cada acción queda anotada.
        No es una amenaza: es su registro, el mismo que ve él, y lo puede
        mirar entero en Actividad.

        ⛔ Solo se dibuja con `estado === 'ok'`. Mientras carga —o si la
        migración de la bitácora todavía no corrió— NO se pinta un "0 abiertos
        · 0 pasaste sin gestionar", que sería un veredicto sobre datos que no
        existen. Es la misma regla que ya rige los contadores de arriba. */}
    {(estadoBitacora === 'ok' && mio) || meta != null ? (
      <div className="mt-2.5 pt-2.5 border-t border-border/60 flex items-center gap-x-4 gap-y-1 flex-wrap text-[11px] text-muted-foreground">
        {estadoBitacora === 'ok' && mio && (
          <>
            <span className="inline-flex items-center gap-1.5" title="Pedidos que abriste hoy, contados por el sistema.">
              <Eye size={12} aria-hidden="true" />
              <span className="font-mono tabular-nums font-bold text-foreground">{mio.abrio}</span> abriste
            </span>
            {mio.salto > 0 && (
              <span
                className="inline-flex items-center gap-1.5 text-warning"
                title="Los abriste y pasaste al siguiente sin registrar ninguna gestión. Queda anotado."
              >
                <SkipForward size={12} aria-hidden="true" />
                <span className="font-mono tabular-nums font-bold">{mio.salto}</span> pasaste sin gestionar
              </span>
            )}
          </>
        )}
        {meta != null && (
          <span
            className={`inline-flex items-center gap-1.5 ml-auto ${metaTono}`}
            title="La meta se calcula sobre lo que va del turno, no sobre el día entero."
          >
            <Target size={12} aria-hidden="true" />
            Vas <span className="font-mono tabular-nums font-bold">{stats.myActions}</span>
            {' '}de <span className="font-mono tabular-nums font-bold">{meta}</span> esperadas a esta hora
          </span>
        )}
      </div>
    ) : null}
    </div>
  );
}
