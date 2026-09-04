import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { CheckCircle2, ListChecks, Hourglass, Users, AlertTriangle, Eye, SkipForward, Target } from 'lucide-react';
import { bogotaToday } from '@/lib/utils';
import { isSegCloser } from '@/lib/segDailyReview';
import { useBitacoraDia } from '@/hooks/useBitacoraDia';
import { pollWhenVisible } from '@/lib/pollWhenVisible';
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
  const { resumen: bitacora, estado: estadoBitacora, recargar: recargarBitacora } = useBitacoraDia(activeStoreId, bogotaToday(), user?.id ?? null);
  const mio = bitacora[0] ?? null;
  // "N abriste · N pasaste sin gestionar" quedaba congelado desde la carga de
  // la pestaña (revisión 3-sep-2026): la bitácora no tiene realtime. Cada 3 min
  // con la pestaña visible, y al volver a ella.
  useEffect(
    () => pollWhenVisible(() => { void recargarBitacora(); }, 3 * 60_000, { runOnVisible: true }),
    [recargarBitacora],
  );

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
    // UNA sola fila (rediseño, 4-sep-2026). Eran dos renglones con cajitas de
    // ícono de 24 px y 90 px de alto encima del tablero: la asesora bajaba
    // media pantalla antes de ver un pedido. Mismos números, misma honestidad,
    // en una línea que se envuelve solo si no cabe.
    <div className="bg-surface border border-border rounded-xl px-3 py-2 mb-3 flex items-center gap-x-4 gap-y-1 flex-wrap text-xs text-muted-foreground">
      <span className="hud-label shrink-0 hidden sm:inline">Hoy</span>
      <span className="inline-flex items-center gap-1.5" title="Gestiones que registraste hoy en Seguimiento.">
        <ListChecks size={13} className="text-info" aria-hidden="true" />
        <span className="font-mono text-sm font-bold text-foreground tabular-nums">{stats.myActions}</span> acciones
      </span>
      <span className="inline-flex items-center gap-1.5">
        <CheckCircle2 size={13} className="text-success" aria-hidden="true" />
        <span className="font-mono text-sm font-bold text-foreground tabular-nums">{stats.myResolved}</span> resueltos
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Hourglass size={13} className="text-warning" aria-hidden="true" />
        <span className="font-mono text-sm font-bold text-foreground tabular-nums">{pendientes}</span> pendientes
      </span>
      <span
        className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border tabular-nums ${tasaTone}`}
        title={tasa === null ? 'Todavía no registraste acciones hoy: no hay tasa que calcular.' : undefined}
      >
        Resolución {tasa === null ? '—' : `${tasa}%`}
      </span>
      <span className="hidden sm:inline-flex items-center gap-1.5 border-l border-border pl-3">
        <Users size={12} aria-hidden="true" />
        Equipo
        <span className="font-mono font-bold text-foreground tabular-nums">{stats.teamActions}</span>
        /
        <span className="font-mono text-success tabular-nums">{stats.teamResolved}</span>
        resueltos
      </span>

    {/* ── Su propio registro, donde trabaja ─────────────────────────────────
        Pedido del dueño: que la asesora sepa que cada acción queda anotada.
        No es una amenaza: es su registro, el mismo que ve él, y lo puede
        mirar entero en Actividad.

        ⛔ Solo se dibuja con `estado === 'ok'`. Mientras carga —o si la
        migración de la bitácora todavía no corrió— NO se pinta un "0 abiertos
        · 0 pasaste sin gestionar", que sería un veredicto sobre datos que no
        existen. Es la misma regla que ya rige los contadores de arriba. */}
    {(estadoBitacora === 'ok' && mio) || meta != null ? (
      <div className="ml-auto flex items-center gap-x-4 gap-y-1 flex-wrap text-[11px] text-muted-foreground sm:border-l sm:border-border sm:pl-3">
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
