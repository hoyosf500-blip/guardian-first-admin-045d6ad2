import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { useOrders } from '@/contexts/OrderContext';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { supabase } from '@/integrations/supabase/client';
import { truncate, formatDateES } from '@/lib/orderUtils';
import { bogotaToday } from '@/lib/utils';
import { computeDailyCounter, computeDailyCounterByDay } from '@/lib/computeDailyCounter';
import { deriveDeliveryMaturity, isRatePreliminary } from '@/lib/logisticsRates';
import { confRateBySample, CONF_TARGET_PCT, MATURITY_MIN_RESUELTOS } from '@/lib/confirmationRate';
import { TruncatedText } from '@/components/TruncatedText';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import { copyToClipboard } from '@/lib/clipboard';
import {
  CheckCircle2, XCircle, PhoneOff, Clock, Send, Copy, MessageSquare,
  Download, TrendingUp, TrendingDown, Minus, Package, ChevronDown,
  BarChart3, Activity, Layers, CloudOff, CloudDownload, RefreshCw,
  Trophy, Calendar as CalendarIcon,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { motion } from 'framer-motion';
import { TiltCard, StatTile, CountUp, GaugeRing, StackedDayBars } from '@/components/ui3d';

interface DailyResult { result_date: string; result: string; order_id: string | null; }
interface SyncLog { status: string; created_at: string; synced_count: number; error_message: string | null; source: string; }

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

export default function DashboardTab() {
  const { allOrders, counter, workQueue } = useOrders();
  const { user, profile } = useAuth();
  const { activeStoreId, isManagerOfActive } = useStore();
  const [period, setPeriod] = useState(7);
  const [historyData, setHistoryData] = useState<DailyResult[]>([]);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [dbOrders, setDbOrders] = useState<Array<{ producto: string; estado: string; valor: number; ciudad: string; transportadora: string }>>([]);
  // El fetch pagina de a 1000 y cortaba con `break` silencioso ante cualquier
  // error, dejando lo acumulado hasta ahí. Si fallaba la página 3 de 6, la
  // pantalla rotulaba "Total pedidos" sobre una muestra truncada; si fallaba la
  // página 1, mostraba 0 y todos los KPIs en cero. Se recuerda qué pasó para
  // poder decirlo en pantalla en vez de hacer pasar el corte por un total.
  const [dbOrdersCarga, setDbOrdersCarga] = useState<'ok' | 'parcial' | 'error'>('ok');
  const [lastSync, setLastSync] = useState<SyncLog | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [resyncing, setResyncing] = useState(false);

  // F5: operator ranking — today's results for ALL operators
  // `tasa` es number|NULL a propósito: una operadora cuyo día fue todo N/R
  // (conf=0, canc=0) NO tiene tasa de confirmación — nadie decidió nada. Pintarla
  // "0% en rojo" la deja indistinguible de quien confirmó 0 de 30 resueltos, y es
  // el dueño quien mira esta tabla para comparar rendimiento. `inmaduro` viaja
  // aparte para no dar por concluyente un 100% sacado de 1 sola gestión.
  interface OperatorStat { name: string; operatorId: string; conf: number; canc: number; noresp: number; total: number; tasa: number | null; inmaduro: boolean; resueltos: number; }
  const [operatorRanking, setOperatorRanking] = useState<OperatorStat[]>([]);

  // ─────────────────────────────────────────────────────────────
  // ALCANCE: equipo vs. yo
  //
  // Este panel nació midiendo SOLO al usuario que lo mira (today_call_stats y
  // el historial filtran por operator_id = auth.uid()). Para una asesora está
  // bien: es su tablero. Para el dueño o un supervisor que no atiende llamadas
  // da 0 en todo — y un tablero en cero se lee como "la app está rota" cuando
  // en realidad el equipo trabajó: en Ecuador había 497 gestiones en 7 días
  // mientras el dueño veía ceros.
  //
  // Managers arrancan en "equipo" (es lo que necesitan) y pueden volver a "yo".
  // A las asesoras no se les muestra el control: su panel sigue siendo el suyo.
  // ─────────────────────────────────────────────────────────────
  type Alcance = 'equipo' | 'yo';
  const [alcance, setAlcance] = useState<Alcance>('yo');
  useEffect(() => { setAlcance(isManagerOfActive ? 'equipo' : 'yo'); }, [isManagerOfActive]);
  const verEquipo = isManagerOfActive && alcance === 'equipo';

  interface DiaEquipo { fecha: string; conf: number; canc: number; noresp: number; }
  const [equipoDiario, setEquipoDiario] = useState<DiaEquipo[]>([]);
  // 'error' existe a propósito y NO se colapsa a lista vacía: una lista vacía
  // pinta ceros, y un cero que en realidad significa "no pude leer la base" es
  // una cifra inventada. Si falla, la pantalla lo dice.
  const [equipoEstado, setEquipoEstado] = useState<'idle' | 'cargando' | 'ok' | 'error'>('idle');

  useEffect(() => {
    if (!isManagerOfActive || !activeStoreId) { setEquipoEstado('idle'); return; }
    let cancelado = false;
    setEquipoEstado('cargando');
    const hasta = new Date().toISOString().split('T')[0];
    const desde = new Date(Date.now() - 30 * 864e5).toISOString().split('T')[0];
    // admin_daily_reports_range agrega POR DÍA en el servidor. Leer order_results
    // crudo acá sería un error: PostgREST corta en 1000 filas y las tasas
    // saldrían calculadas sobre una muestra truncada sin avisar.
    // Se nombra la fn antes de llamarla: dejar el `(` de la llamada en la línea
    // siguiente al cast dispara no-unexpected-multiline, y con razón — es el
    // patrón que la inserción automática de punto y coma puede romper.
    type RpcDiario = (fn: string, p: Record<string, unknown>) => Promise<{
      data: Array<Record<string, unknown>> | null;
      error: { message: string } | null;
    }>;
    const rpcDiario = supabase.rpc as unknown as RpcDiario;
    rpcDiario('admin_daily_reports_range', { p_from: desde, p_to: hasta })
      .then(({ data, error }) => {
        if (cancelado) return;
        if (error || !Array.isArray(data)) {
          console.error('No se pudo leer el resumen diario del equipo:', error?.message);
          setEquipoDiario([]);
          setEquipoEstado('error');
          return;
        }
        setEquipoDiario(data.map(f => ({
          fecha: String(f.fecha ?? '').slice(0, 10),
          conf: Number(f.confirmados) || 0,
          canc: Number(f.cancelados) || 0,
          noresp: Number(f.noresp) || 0,
        })));
        setEquipoEstado('ok');
      });
    return () => { cancelado = true; };
  }, [isManagerOfActive, activeStoreId]);

  // Audit M3: cancellation guards — evitan setState en componente desmontado.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const today = bogotaToday();
    // El scope por tienda lo resuelve la RPC server-side vía
    // _resolve_scope_store() (admin → su tienda activa). No pasamos p_store_id
    // para no depender de que la migration del parámetro esté aplicada (PGRST202).
    supabase.rpc('get_daily_operator_stats', { p_date: today }).then(({ data, error }) => {
      if (cancelled || error || !data) return;
      const ranking = (data as Array<{ operator_id: string; display_name: string; conf: number; canc: number; noresp: number }>)
        .map(r => {
          const total = Number(r.conf) + Number(r.canc) + Number(r.noresp);
          // Tasa MADURA conf÷(conf+canc), igual que toda la app (no ÷total).
          // Se conserva el null y el flag `inmaduro` que devuelve el helper: el
          // `?? 0` que había acá los aplastaba y la tabla emitía un veredicto
          // rojo sobre una medición que no existía.
          const rate = confRateBySample(Number(r.conf), Number(r.canc));
          return {
            operatorId: r.operator_id,
            name: r.display_name || 'Operador',
            conf: Number(r.conf),
            canc: Number(r.canc),
            noresp: Number(r.noresp),
            total,
            tasa: rate.tasa,
            inmaduro: rate.inmaduro,
            resueltos: rate.resueltos,
          };
        });
      ranking.sort((a, b) => b.total - a.total);
      if (!cancelled) setOperatorRanking(ranking);
    });
    return () => { cancelled = true; };
  }, [user, counter]); // re-fetch when counter changes (user marked something)

  // Load orders from DB for dashboard stats (filtrado por tienda activa)
  useEffect(() => {
    if (!user || !activeStoreId) return;
    let cancelled = false;
    const fetchAllOrders = async () => {
      const allData: Array<{ producto: string; estado: string; valor: number; ciudad: string; transportadora: string }> = [];
      let from = 0;
      const pageSize = 1000;
      let fallo = false;
      while (true) {
        if (cancelled) return;
        const { data, error } = await supabase.from('orders').select('producto, estado, valor, ciudad, transportadora')
          .eq('store_id', activeStoreId)
          .order('created_at', { ascending: false })
          .range(from, from + pageSize - 1);
        if (error) { console.error('Error loading orders:', error.message); fallo = true; break; }
        if (!data || data.length === 0) break;
        allData.push(...data.map(o => ({
          producto: o.producto || 'Sin producto',
          estado: o.estado || '',
          valor: Number(o.valor) || 0,
          ciudad: o.ciudad || '',
          transportadora: o.transportadora || '',
        })));
        if (data.length < pageSize) break;
        from += pageSize;
      }
      if (!cancelled) {
        setDbOrders(allData);
        setDbOrdersCarga(!fallo ? 'ok' : allData.length > 0 ? 'parcial' : 'error');
      }
    };
    fetchAllOrders();
    return () => { cancelled = true; };
  }, [user, activeStoreId]);

  useEffect(() => {
    if (!user || !activeStoreId) return;
    let cancelled = false;
    const since = new Date(); since.setDate(since.getDate() - 30);
    // store_id agregado: sin él, un usuario con gestiones en Colombia Y Ecuador
    // veía las dos tiendas sumadas en el mismo gráfico, sin poder notarlo.
    supabase.from('order_results').select('result_date, result, order_id')
      .eq('operator_id', user.id).eq('store_id', activeStoreId)
      .gte('result_date', since.toISOString().split('T')[0])
      .order('result_date', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.error('Error loading history:', error.message);
        if (data) setHistoryData(data);
      });
    return () => { cancelled = true; };
  }, [user, activeStoreId]);

  // Sync health — poll the latest entry in sync_logs every 30s. Only
  // admins have SELECT permission on sync_logs, so non-admin users just
  // see an empty response and the widget stays hidden. This is the first
  // line of defense against "Dropi se cayó y nadie se enteró" — if the
  // cron stops producing rows, the banner immediately turns red.
  const loadSyncLog = useCallback(async () => {
    if (!activeStoreId) return;
    const { data, error } = await supabase
      .from('sync_logs')
      .select('status, created_at, synced_count, error_message, source')
      .eq('store_id', activeStoreId)
      // 'dropi' (no 'dropi-sync'): la edge function dropi-sync escribe
      // source:'dropi' — NADA escribe 'dropi-sync'. El filtro viejo hacía
      // invisibles los syncs/fallos manuales para este chip de salud.
      .in('source', ['dropi-cron', 'dropi'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) console.error('Error loading sync log:', error.message);
    if (data) setLastSync(data);
  }, [activeStoreId]);

  // COST-2 2026-07-10: sync log 2 → 15 min, tick visual 30s → 2 min.
  useEffect(() => {
    if (!user) return;
    loadSyncLog();
    const stopPoll = pollWhenVisible(loadSyncLog, 15 * 60 * 1000, { runOnVisible: false });
    const stopTick = pollWhenVisible(() => setNowTick(Date.now()), 2 * 60 * 1000, { runOnVisible: false });
    return () => { stopPoll(); stopTick(); };
  }, [user, loadSyncLog]);

  const resyncNow = async () => {
    if (resyncing) return;
    if (!activeStoreId) { toast.error('Sin tienda activa'); return; }
    setResyncing(true);
    try {
      // dropi-sync ahora responde 200 con {rateLimited|error} en vez de colapsar
      // en el genérico "non-2xx". Leemos el body para mostrar la causa REAL:
      // throttle de Dropi (común en EC, alto volumen) → aviso, no error.
      const res = await supabase.functions.invoke('dropi-sync', { body: { store_id: activeStoreId } });
      if (res.error) throw res.error;
      const data = res.data as { rateLimited?: boolean; error?: string; message?: string } | null;
      if (data?.rateLimited) {
        toast.warning(data.message || 'Dropi está limitando las peticiones. El sync automático igual mantiene tus pedidos al día.');
      } else if (data?.error) {
        toast.error(data.error);
      } else {
        toast.success('Sincronización disparada');
      }
      // Refresh the health card after a short delay so the new row appears
      setTimeout(loadSyncLog, 1500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error('Error disparando sync: ' + msg);
    } finally {
      setResyncing(false);
    }
  };

  const syncStatus = useMemo(() => {
    if (!lastSync) return null;
    const ageMs = nowTick - new Date(lastSync.created_at).getTime();
    const ageMin = Math.floor(ageMs / 60000);
    const isError = lastSync.status !== 'success';
    const healthy = !isError && ageMin < 15;
    const warning = !isError && ageMin >= 15 && ageMin < 60;
    const broken = isError || ageMin >= 60;
    const ageLabel = ageMin < 1 ? 'ahora' : ageMin < 60 ? `${ageMin}m` : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m`;
    return { ageMin, ageLabel, isError, healthy, warning, broken };
  }, [lastSync, nowTick]);

  // ─────────────────────────────────────────────────────────────
  // FECHAS: siempre calendario BOGOTÁ, nunca UTC.
  //
  // `new Date().toISOString()` da la fecha UTC. Entre las 19:00 y la medianoche
  // de Bogotá la fecha UTC ya es la del día siguiente, así que:
  //   · "hoy" apuntaba a MAÑANA → un bucket que por definición tiene 0 filas se
  //     dibujaba como dato real y la operadora leía un desplome en su sparkline
  //     justo cuando cierra la jornada;
  //   · "ayer" (UTC − 1 día) apuntaba a HOY en Bogotá → el badge comparaba el día
  //     contra sí mismo y siempre decía "sin cambio".
  // counter / order_results / today_call_stats son todos hora Bogotá, igual que
  // bogotaToday() (utils.ts). Se desplaza sobre la fecha CALENDARIO, sin volver
  // a pasar por toISOString() de una hora local.
  const shiftDiasISO = (iso: string, dias: number): string => {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + dias);
    return dt.toISOString().split('T')[0];
  };
  const hoyISO = bogotaToday();

  const chartData = useMemo(() => {
    // Generamos las N fechas (incluyendo hoy) y delegamos la dedup al
    // helper compartido — misma fuente de verdad que CounterBar y el RPC
    // operator_productivity_stats v20260505184140. Si la regla cambia, se
    // toca un solo lugar (computeDailyCounter) y el chart la hereda.
    const dates: string[] = [];
    for (let i = 0; i < period; i++) {
      dates.push(shiftDiasISO(hoyISO, -(period - 1 - i)));
    }
    // Dos fuentes según el alcance, pero UN solo formato de salida para que
    // todo lo de abajo (gráficos, sparklines, KPIs) no sepa de dónde vino.
    const porDia: Record<string, { conf: number; canc: number; noresp: number }> = verEquipo
      ? Object.fromEntries(dates.map(f => {
          const r = equipoDiario.find(e => e.fecha === f);
          return [f, { conf: r?.conf ?? 0, canc: r?.canc ?? 0, noresp: r?.noresp ?? 0 }];
        }))
      : computeDailyCounterByDay(historyData, dates);
    return dates.map(date => {
      const d = porDia[date];
      const t = d.conf + d.canc + d.noresp;
      return {
        date: new Date(date + 'T12:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short' }),
        // Marca el día de hoy para poder resaltarlo en el gráfico. Con 30 días
        // seleccionados, sin esto la operadora no sabe cuál barra es la suya.
        esHoy: date === hoyISO,
        // tasa NULLABLE a propósito: un domingo, un festivo o un día sin cola no
        // tiene tasa — nadie resolvió nada. El `?? 0` lo graficaba como 0%,
        // visualmente idéntico a un día catastrófico donde se canceló todo, y el
        // dueño leía desplomes de rendimiento que nunca ocurrieron. Con null,
        // recharts corta la línea (connectNulls={false}) y el hueco dice la verdad.
        ...d, tasa: confRateBySample(d.conf, d.canc).tasa, total: t
      };
    });
  }, [historyData, equipoDiario, verEquipo, period, hoyISO]);

  // Comparativo de ayer. Usa la MISMA fn que CounterBar (computeDailyCounter)
  // para que "ayer" en el dashboard nunca diverja del cierre real del día.
  const yesterdayData = useMemo(() => {
    const yd = shiftDiasISO(hoyISO, -1);
    const r = verEquipo ? equipoDiario.find(e => e.fecha === yd) : null;
    const { conf, canc, noresp } = verEquipo
      ? { conf: r?.conf ?? 0, canc: r?.canc ?? 0, noresp: r?.noresp ?? 0 }
      : computeDailyCounter(historyData, yd);
    const total = conf + canc + noresp;
    // tasa NULLABLE: si ayer no hubo NINGÚN resuelto (domingo, festivo, franco,
    // primer día de la operadora) no existe base contra la cual comparar.
    // TrendBadge ya trae el guard correcto (`previous === null` → no dibuja
    // nada); el `?? 0` que había acá era justamente lo que lo desactivaba, y la
    // píldora terminaba anunciando "+85% vs ayer" contra un 0% que nadie midió.
    return { conf, canc, noresp, total, tasa: confRateBySample(conf, canc).tasa };
  }, [historyData, equipoDiario, verEquipo, hoyISO]);

  const sparkData = useMemo(() => {
    const last7 = chartData.slice(-7);
    return {
      conf: last7.map(d => d.conf),
      canc: last7.map(d => d.canc),
      noresp: last7.map(d => d.noresp),
      total: last7.map(d => d.total),
    };
  }, [chartData]);

  // Cifras de HOY que se MUESTRAN. Ojo: `counter` (personal) se sigue usando
  // tal cual para el cierre de turno más abajo — ese reporte es de la operadora
  // que lo firma y no puede cambiar según lo que esté mirando en pantalla.
  const hoy = useMemo(() => {
    if (!verEquipo) return counter;
    const r = equipoDiario.find(e => e.fecha === hoyISO);
    return { conf: r?.conf ?? 0, canc: r?.canc ?? 0, noresp: r?.noresp ?? 0 };
  }, [verEquipo, equipoDiario, hoyISO, counter]);

  const total = hoy.conf + hoy.canc + hoy.noresp;
  // `inmaduro` (resueltos < 5) ya lo calcula confRateBySample y el Dashboard lo
  // estaba tirando. Importa: con 1 confirmado y 0 cancelados la fórmula da
  // 100%, que es aritméticamente cierto y operativamente una mentira — nadie
  // tiene 100% de confirmación, tiene UNA gestión. Otras 5 pantallas del CRM
  // ya marcan este caso; acá se hacía pasar por medición concluyente.
  const tasaInfo = confRateBySample(hoy.conf, hoy.canc);
  const tasa = tasaInfo.tasa ?? 0;
  const tasaSinBase = tasaInfo.tasa === null || tasaInfo.inmaduro;
  // `sinResueltos` es MÁS FUERTE que `tasaSinBase`: no es "muestra chica", es que
  // NO HAY MEDICIÓN (conf+canc === 0). Con muestra chica el aro sigue mostrando
  // un número que sí se midió (y el chip avisa que no concluye); sin resueltos,
  // cualquier cifra en el aro es inventada — va "—".
  const sinResueltos = tasaInfo.tasa === null;
  // Cierre de turno: SIEMPRE personal (counter), nunca el alcance en pantalla.
  // El mensaje ya lista counter.conf/canc/noresp, pero la tasa y el total salían
  // de `hoy`, que en modo Equipo es la tienda entera: el jefe recibía "Conf: 5 …
  // Tasa: 78%" mezclando dos universos. Nullable para no firmar un 0% inventado.
  const cierreInfo = confRateBySample(counter.conf, counter.canc);
  const cierreTotal = counter.conf + counter.canc + counter.noresp;
  const cierreTasaTexto = cierreInfo.tasa === null ? 'sin resueltos aún' : `${cierreInfo.tasa}%`;
  const pendLeft = workQueue.filter(o => !o.result).length;
  // Cuando NO se pudo leer al equipo, las cifras de arriba son ceros de relleno.
  // Se usa para no pintarlas como si fueran una medición.
  const datosIncompletos = verEquipo && equipoEstado !== 'ok';

  // Meta del día — MISMA fórmula que CounterBar (src/components/CounterBar.tsx):
  // gestionados hoy / (gestionados hoy + lo que queda en cola). Se replica en
  // vez de inventar otra para que la barra de Confirmar y la del Dashboard no
  // puedan mostrarle números distintos a la misma operadora.
  const metaDia = (() => {
    const goal = total + workQueue.length;
    return { goal, pct: goal > 0 ? Math.min(100, Math.round(total / goal * 100)) : 0 };
  })();

  // Memoized so downstream useMemo (statusBreakdown, prods) gets a stable reference.
  // Without this, every render creates a new array → defeats all memoization.
  const ordersForStats = useMemo(() =>
    allOrders.length > 0 ? allOrders.map(o => ({
      producto: o.producto || 'Sin producto', estado: o.estado || '', valor: o.valor, ciudad: o.ciudad, transportadora: o.transportadora
    })) : dbOrders,
  [allOrders, dbOrders]);

  const totalOrders = ordersForStats.length;
  // `allOrders` NO es "todos los pedidos de la tienda": OrderContext lo llena
  // con la cola de PENDIENTE CONFIRMACION (o con lo que se subió por Excel).
  // Mientras esa cola exista, `totalOrders` cuenta la COLA — llamarlo "Total
  // pedidos" le dice al dueño que su tienda tiene 53 pedidos cuando tiene 53
  // SIN CONFIRMAR. Solo es el universo cuando sale de `dbOrders` y la
  // paginación no se cortó; en cualquier otro caso es una muestra y se rotula
  // como tal.
  const totalEsUniverso = allOrders.length === 0 && dbOrdersCarga === 'ok';

  const prods = useMemo(() => {
    // `devol` es nuevo y NO cambia ninguna cifra existente: se usa solo para
    // saber cuántos pedidos del producto llegaron a un desenlace FINAL, y así
    // poder decir cuándo la columna "Efect." todavía no concluye nada.
    const byProd: Record<string, { total: number; entreg: number; canc: number; nov: number; devol: number }> = {};
    ordersForStats.forEach(o => {
      const p = o.producto || 'Sin producto';
      if (!byProd[p]) byProd[p] = { total: 0, entreg: 0, canc: 0, nov: 0, devol: 0 };
      byProd[p].total++;
      const e = (o.estado || '').toUpperCase();
      if (e.includes('ENTREGAD')) byProd[p].entreg++;
      else if (e.includes('CANCEL')) byProd[p].canc++;
      else if (e.includes('NOVEDAD')) byProd[p].nov++;
      else if (e.includes('DEVOL')) byProd[p].devol++;
    });
    return Object.entries(byProd).sort((a, b) => b[1].total - a[1].total);
  }, [ordersForStats]);

  // Status breakdown from DB
  const statusBreakdown = useMemo(() => {
    const s = { entregados: 0, cancelados: 0, novedades: 0, oficina: 0, devoluciones: 0, transito: 0, pendientes: 0, otros: 0, valorTotal: 0, valorEntregado: 0 };
    ordersForStats.forEach(o => {
      const e = (o.estado || '').toUpperCase();
      s.valorTotal += o.valor;
      if (e.includes('ENTREGAD')) { s.entregados++; s.valorEntregado += o.valor; }
      else if (e.includes('CANCEL')) s.cancelados++;
      else if (e.includes('NOVEDAD') || e === 'INTENTO DE ENTREGA') s.novedades++;
      else if (e.includes('OFICINA') || e.includes('RECLAME')) s.oficina++;
      else if (e.includes('DEVOL')) s.devoluciones++;
      else if (e.includes('DESPACHAD') || e.includes('TRANSPORTE') || e.includes('REPARTO') || e.includes('DISTRIBUCION') || e === 'ADMITIDA' || e === 'EN DESPACHO') s.transito++;
      else if (e === 'PENDIENTE CONFIRMACION') s.pendientes++;
      else s.otros++;
    });
    return s;
  }, [ordersForStats]);

  const downloadCsv = (filename: string, headers: string[], rows: string[][]) => {
    const csv = '\uFEFF' + [headers.join(','), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))].join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = filename; a.click(); toast.success('CSV descargado');
  };
  const exportarResultadosHoy = () => {
    const managed = workQueue.filter(o => o.result);
    if (!managed.length) { toast.error('No hay resultados hoy'); return; }
    downloadCsv(`resultados_${new Date().toISOString().split('T')[0]}.csv`,
      ['Teléfono', 'Nombre', 'Producto', 'Ciudad', 'Resultado', 'Razón', 'Valor'],
      managed.map(o => [o.phone, o.nombre, o.producto, o.ciudad, o.result === 'conf' ? 'Confirmado' : o.result === 'canc' ? 'Cancelado' : 'No respondió', o.reason || '', String(o.valor)]));
  };
  const exportarHistorico = async () => {
    if (!user) return;
    const since = new Date(); since.setDate(since.getDate() - period);
    const sinceStr = since.toISOString().split('T')[0];
    const { data, error } = await supabase.from('order_results').select('result_date, result_time, phone, result, reason, module')
      .eq('operator_id', user.id).gte('result_date', sinceStr).order('result_date', { ascending: false });
    if (error || !data?.length) { toast.error(error ? 'Error' : 'Sin datos'); return; }
    downloadCsv(`historico_${sinceStr}.csv`, ['Fecha', 'Hora', 'Teléfono', 'Resultado', 'Razón', 'Módulo'],
      data.map(r => [r.result_date, r.result_time || '', r.phone, r.result === 'conf' ? 'Confirmado' : r.result === 'canc' ? 'Cancelado' : 'No respondió', r.reason || '', r.module]));
  };
  const handleCierre = async () => {
    if (!user) return;
    const today = new Date().toISOString().split('T')[0];
    const { error } = await supabase.from('daily_reports').insert({ operator_id: user.id, report_date: today, report_type: 'cierre',
      data: { confirmados: counter.conf, cancelados: counter.canc, no_respondio: counter.noresp, total_gestionados: total, tasa_confirmacion: tasa, pendientes_manana: pendLeft } });
    if (error) toast.error(error.code === '23505' ? 'Ya enviaste el cierre de hoy' : 'Error');
    else toast.success('Cierre enviado correctamente');
  };
  const copiarResumen = () => {
    void copyToClipboard(
      `Cierre — ${formatDateES(hoyISO)}\n\nConfirmados: ${counter.conf}\nCancelados: ${counter.canc}\nNo respondió: ${counter.noresp}\nTasa: ${cierreTasaTexto}\nPendientes: ${pendLeft}\nTotal: ${cierreTotal}`,
      'Copiado al portapapeles',
    );
  };
  const enviarWA = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(`Cierre — ${formatDateES(hoyISO)}\n\nConf: ${counter.conf} | Canc: ${counter.canc} | N/R: ${counter.noresp}\nTotal: ${cierreTotal} | Tasa: ${cierreTasaTexto}\nPendientes: ${pendLeft}`)}`, '_blank');
  };

  // Chart theming uses HSL CSS vars so dark/light modes adapt automatically.
  const hsl = (v: string) => `hsl(var(${v}))`;
  const tickStyle = { fontSize: 10, fill: hsl('--muted-foreground') };

  /**
   * Tick del eje X que escribe "HOY" en cian sobre la columna del día actual,
   * en vez de la fecha. Con 30 días en pantalla es la única forma de que la
   * operadora encuentre su jornada de un vistazo.
   */
  const hoyTick = (props: { x?: number; y?: number; index?: number; payload?: { value?: string } }) => {
    const { x = 0, y = 0, index = 0, payload } = props;
    const esHoy = chartData[index]?.esHoy;
    return (
      <text
        x={x}
        y={y + 10}
        textAnchor="middle"
        fontSize={esHoy ? 9 : 10}
        fontWeight={esHoy ? 700 : 400}
        letterSpacing={esHoy ? '0.1em' : undefined}
        fill={esHoy ? hsl('--cyan') : hsl('--muted-foreground')}
      >
        {esHoy ? 'HOY' : payload?.value}
      </text>
    );
  };
  const tooltipStyle = {
    backgroundColor: hsl('--card'),
    border: `1px solid ${hsl('--border')}`,
    borderRadius: '10px',
    fontSize: '12px',
    color: hsl('--foreground'),
    boxShadow: 'var(--shadow-md)',
  };
  const CHART_ACCENT  = hsl('--accent');
  const CHART_SUCCESS = hsl('--success');
  const CHART_DANGER  = hsl('--danger');
  const CHART_WARNING = hsl('--warning');
  const CHART_INFO    = hsl('--info');
  const CHART_AI      = hsl('--ai');
  const CHART_CYAN    = hsl('--cyan');
  const CHART_MUTED   = hsl('--muted-foreground');
  const CHART_GRID    = hsl('--border');
  const COLORS = [CHART_ACCENT, CHART_INFO, CHART_SUCCESS, CHART_DANGER, CHART_AI, CHART_CYAN, CHART_MUTED];

  // Meta oficial del dueño = CONF_TARGET_PCT (85%), fuente única. Verde en meta;
  // ámbar en la banda "cerca" (5 pts por debajo); rojo debajo de eso.
  const tasaColor  = tasa >= CONF_TARGET_PCT ? 'text-success' : tasa >= CONF_TARGET_PCT - 5 ? 'text-warning' : 'text-danger';
  const tasaStroke = tasa >= CONF_TARGET_PCT ? CHART_SUCCESS : tasa >= CONF_TARGET_PCT - 5 ? CHART_WARNING : CHART_DANGER;
  const tasaBg     = tasa >= CONF_TARGET_PCT ? 'bg-success/10 border border-success/25' : tasa >= CONF_TARGET_PCT - 5 ? 'bg-warning/10 border border-warning/25' : 'bg-danger/10 border border-danger/25';

  // Píldora de tendencia. Se llamaba "badge" pero era texto suelto sin fondo ni
  // borde: en la card hero quedaba como contrapeso del rótulo "Tasa personal"
  // sin ningún peso visual. El handoff la pide como chip con tinte semántico.
  // `previous` acepta null A PROPÓSITO: sin dato de ayer NO se dibuja nada.
  // Antes el tipo era `number` y "Total pedidos" pasaba un 0 fijo, así que la
  // píldora habría mostrado "+2385 vs ayer" — un número inventado presentado
  // como medición. Hoy esa rama no se ve (esa tarjeta muestra otra cosa), pero
  // el 0 quedaba de mina para el próximo que reordene el código. El CRM no
  // muestra cifras que no salgan de la base: si no hay con qué comparar, no
  // hay píldora.
  function TrendBadge({ current, previous, suffix = '' }: { current: number; previous: number | null; suffix?: string }) {
    if (previous === null || previous === undefined || !Number.isFinite(previous)) return null;
    const base = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border text-[10px] font-semibold whitespace-nowrap';
    const diff = current - previous;
    if (diff === 0) {
      return (
        <span className={`${base} bg-muted/50 border-border text-muted-foreground`}>
          <Minus size={10} aria-hidden="true" /> sin cambio
        </span>
      );
    }
    const up = diff > 0;
    return (
      <span className={`${base} ${up ? 'bg-success/14 border-success/30 text-success' : 'bg-danger/14 border-danger/30 text-danger'}`}>
        {up ? <TrendingUp size={10} aria-hidden="true" /> : <TrendingDown size={10} aria-hidden="true" />}
        <span className="font-mono tabular-nums">{up ? '+' : ''}{diff}{suffix}</span> vs ayer
      </span>
    );
  }

  const greeting = (() => {
    const h = new Date().getHours();
    const franja = h < 12 ? 'Buenos días' : h < 18 ? 'Buenas tardes' : 'Buenas noches';
    // Solo el primer nombre: "Buenos días, María Fernanda Ríos" no entra en el
    // header y el apellido no aporta nada acá.
    const nombre = (profile?.display_name || '').trim().split(/\s+/)[0];
    return nombre ? `${franja}, ${nombre}` : franja;
  })();

  const hasData = total > 0 || totalOrders > 0;

  return (
    <div className="max-w-6xl mx-auto">
      {/* Page header — patrón pro coherente con Logística/Rescate */}
      <motion.header {...fadeUp(0)} className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div className="min-w-0 space-y-1.5">
          <div className="hud-label mb-1 truncate">
            Resumen · Operadora
          </div>
          {/* Avatar con la inicial + punto de "en línea", como el mockup: es la
              pantalla personal de la operadora, así que el header lleva su cara,
              no un ícono genérico de gráfico. */}
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-3">
            <span className="relative flex-shrink-0" aria-hidden="true">
              <span className="w-11 h-11 rounded-2xl bg-accent-gradient shadow-glow flex items-center justify-center text-accent-foreground text-base font-bold">
                {(profile?.display_name || 'U')[0].toUpperCase()}
              </span>
              <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-success border-2 border-background glow-success" />
            </span>
            {greeting}
          </h1>
          <p className="text-sm text-muted-foreground">
            {/* hoyISO, no toISOString(): a partir de las 19:00 de Bogotá el
                encabezado anunciaba la fecha de MAÑANA sobre las cifras de hoy. */}
            {formatDateES(hoyISO)} · Tu progreso del día y tendencia reciente.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Chip de fecha del mockup, antes del selector de período. */}
          <span className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-card/40 border border-border text-xs text-muted-foreground">
            <CalendarIcon size={13} className="text-accent" aria-hidden="true" />
            <span className="font-mono tabular-nums">
              {new Date().toLocaleDateString('es-CO', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Bogota' })}
            </span>
          </span>
          {/* Alcance: solo para quien manda en la tienda. La asesora no lo ve
              porque su tablero es el suyo y no hay nada que elegir. */}
          {isManagerOfActive && (
            <div className="inline-flex flex-wrap gap-[2px] p-[3px] rounded-xl bg-card/40 border border-border" role="group" aria-label="Qué se muestra en el tablero">
              {([{ v: 'equipo', l: 'Equipo' }, { v: 'yo', l: 'Yo' }] as Array<{ v: Alcance; l: string }>).map(a => (
                <button key={a.v} onClick={() => setAlcance(a.v)} aria-pressed={alcance === a.v}
                  className={`px-4 py-2 rounded-[9px] text-sm transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                    alcance === a.v
                      ? 'font-semibold bg-accent/16 border border-accent/40 text-accent shadow-glow3d'
                      : 'font-medium border border-transparent text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}>{a.l}</button>
              ))}
            </div>
          )}
          {/* Period tabs */}
          <div className="inline-flex flex-wrap gap-[2px] p-[3px] rounded-xl bg-card/40 border border-border">
            {[{ n: 7, l: '7d' }, { n: 15, l: '15d' }, { n: 30, l: '30d' }].map(p => (
              <button key={p.n} onClick={() => setPeriod(p.n)}
                className={`px-4 py-2 rounded-[9px] text-sm transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                  period === p.n
                    ? 'font-semibold bg-accent/16 border border-accent/40 text-accent shadow-glow3d'
                    : 'font-medium border border-transparent text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}>{p.l}</button>
            ))}
          </div>
          <div className="h-5 w-px bg-border hidden sm:block" />
          {/* Action buttons */}
          <button onClick={exportarResultadosHoy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-card/40 border border-border text-muted-foreground text-sm font-medium hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
            <Download size={13} aria-hidden="true" /> CSV
          </button>
          <button onClick={handleCierre} className="btn-accent-3d inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
            <Send size={13} aria-hidden="true" /> Enviar cierre
          </button>
          {/* More actions dropdown */}
          <div className="relative">
            <button onClick={() => setActionsOpen(!actionsOpen)}
              aria-expanded={actionsOpen}
              aria-label="Más acciones"
              className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-card/40 border border-border text-muted-foreground text-sm font-medium hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
              <ChevronDown size={13} className={`transition-transform duration-200 ${actionsOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            {actionsOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setActionsOpen(false)} aria-hidden="true" />
                <div className="absolute right-0 top-full mt-2 z-50 bg-card border border-border rounded-2xl shadow-card3d-lg py-1 min-w-[168px]">
                  <button onClick={() => { exportarHistorico(); setActionsOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-foreground hover:bg-surface transition-colors duration-200 cursor-pointer">
                    <Download size={13} aria-hidden="true" /> Exportar histórico
                  </button>
                  <button onClick={() => { copiarResumen(); setActionsOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-foreground hover:bg-surface transition-colors duration-200 cursor-pointer">
                    <Copy size={13} aria-hidden="true" /> Copiar resumen
                  </button>
                  <button onClick={() => { enviarWA(); setActionsOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-success hover:bg-surface transition-colors duration-200 cursor-pointer">
                    <MessageSquare size={13} aria-hidden="true" /> Enviar por WhatsApp
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </motion.header>

      {/* Sync health — only renders when we have at least one sync_logs row
          (i.e. the user is admin and the table is readable). Turns red if
          the cron hasn't produced a fresh entry in over an hour. */}
      {syncStatus && (
        <motion.div {...fadeUp(0.03)} className={`relative mb-5 flex flex-col sm:flex-row sm:items-center gap-3 rounded-2xl border px-4 pl-5 py-3 shadow-card3d ${
          syncStatus.broken
            ? 'border-danger/30 bg-danger/10'
            : syncStatus.warning
              ? 'border-warning/30 bg-warning/10'
              : 'border-success/30 bg-success/10'
        }`}>
          <span className={`absolute left-0 top-3 bottom-3 w-1 rounded-full ${
            syncStatus.broken ? 'bg-danger' : syncStatus.warning ? 'bg-warning' : 'bg-success'
          }`} aria-hidden="true" />
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${
            syncStatus.broken ? 'bg-danger/20 glow-danger' : syncStatus.warning ? 'bg-warning/20 glow-warning' : 'bg-success/20 glow-success'
          }`}>
            {syncStatus.broken ? <CloudOff size={18} className="text-danger" aria-hidden="true" />
              : syncStatus.warning ? <Clock size={18} className="text-warning" aria-hidden="true" />
              : <CloudDownload size={18} className="text-success" aria-hidden="true" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-xs font-semibold ${
              syncStatus.broken ? 'text-danger' : syncStatus.warning ? 'text-warning' : 'text-success'
            }`}>
              {syncStatus.broken
                ? (syncStatus.isError ? `Sync caído: ${lastSync?.error_message || 'error'}` : `Sin sincronización hace ${syncStatus.ageLabel}`)
                : syncStatus.warning
                  ? `Sincronizado hace ${syncStatus.ageLabel} (lento)`
                  : `Dropi sincronizado hace ${syncStatus.ageLabel}`}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5 font-mono tabular-nums">
              Fuente: {lastSync?.source} · {lastSync?.synced_count ?? 0} pedidos · {lastSync ? new Date(lastSync.created_at).toLocaleString('es-CO') : ''}
            </div>
          </div>
          <button
            onClick={resyncNow}
            disabled={resyncing}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-card/40 border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors duration-200 disabled:opacity-50 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <RefreshCw size={12} className={resyncing ? 'animate-spin' : ''} />
            {resyncing ? 'Sincronizando...' : 'Forzar sync'}
          </button>
        </motion.div>
      )}

      {/* La base de "Total pedidos", "Detalle por producto" y el desglose por
          estado se pagina de a 1000. Si una página falla, el conteo deja de ser
          un total y pasa a ser una muestra cortada — y sin este aviso la
          pantalla la presentaba como si fuera el universo completo. Solo aplica
          cuando esas cifras SALEN de `dbOrders` (con `allOrders` en memoria, la
          fuente es otra y el corte no las afecta). */}
      {allOrders.length === 0 && dbOrdersCarga !== 'ok' && (
        <motion.div {...fadeUp(0.04)} className={`mb-5 flex items-start gap-3 rounded-2xl border px-4 py-3 ${
          dbOrdersCarga === 'error' ? 'border-danger/30 bg-danger/10' : 'border-warning/30 bg-warning/10'
        }`}>
          <CloudOff size={16} className={`mt-0.5 flex-shrink-0 ${dbOrdersCarga === 'error' ? 'text-danger' : 'text-warning'}`} aria-hidden="true" />
          <div className="text-[11px] leading-relaxed">
            <span className={`font-semibold ${dbOrdersCarga === 'error' ? 'text-danger' : 'text-warning'}`}>
              {dbOrdersCarga === 'error'
                ? 'No se pudieron cargar los pedidos.'
                : 'Datos parciales: no se pudieron cargar todos los pedidos.'}
            </span>{' '}
            <span className="text-muted-foreground">
              {dbOrdersCarga === 'error'
                ? 'Los ceros de "Pedidos cargados", el detalle por producto y el desglose por estado NO significan que no haya pedidos: significan que no se pudo leer la base. Recargá la página.'
                : 'Las cifras de "Pedidos cargados", el detalle por producto y el desglose por estado salen de una muestra cortada, no del total. Recargá la página para verlas completas.'}
            </span>
          </div>
        </motion.div>
      )}

      {!hasData ? (
        /* Empty state */
        <motion.div {...fadeUp(0.05)} className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-16 h-16 rounded-2xl bg-card/40 border border-border shadow-card3d flex items-center justify-center mb-4">
            <BarChart3 size={28} className="text-muted-foreground" aria-hidden="true" />
          </div>
          <h3 className="text-base font-semibold text-foreground mb-1">Sin datos todavía</h3>
          <p className="text-sm text-muted-foreground max-w-xs">
            Sube un archivo Excel o comienza a gestionar pedidos para ver tus estadísticas aquí.
          </p>
        </motion.div>
      ) : (
        <>
          {/* Hero KPI + Compact KPIs */}
          <motion.div {...fadeUp(0.05)} className="grid grid-cols-1 md:grid-cols-12 gap-4 mb-5">
            {/* Hero: Tasa de confirmación */}
            <TiltCard
              sheen
              brackets
              wrapperClassName="md:col-span-6"
              className="bg-card/40 border border-border rounded-3xl p-6 shadow-card3d-lg h-full flex flex-col"
            >
              <div className="flex items-center justify-between gap-3 tilt-layer-2">
                {/* El rótulo CAMBIA con el alcance. Dejarlo fijo en "Tasa
                    personal" mientras el aro muestra al equipo sería mentir con
                    la etiqueta en vez de con el número. */}
                <div
                  className="hud-label"
                  title={verEquipo
                    ? 'Tasa del equipo: confirmados de toda la tienda / los que tuvieron respuesta hoy (conf+canc, SIN noresp). Es la confirmación madura estándar COD.'
                    : 'Tasa personal: tus confirmados / los que tuvieron respuesta hoy (conf+canc, SIN noresp). Es la confirmación madura estándar COD. NO sobre el inflow total del día — eso lo ves en /admin → Productividad.'}
                >
                  {verEquipo ? 'Tasa del equipo' : 'Tasa personal'}
                </div>
                {/* Sin resueltos HOY no hay `current` que comparar: el delta
                    sería tan inventado como el que producía el `?? 0` de ayer. */}
                <TrendBadge current={tasa} previous={sinResueltos ? null : yesterdayData.tasa} suffix="%" />
              </div>

              <div className="flex justify-center py-4 tilt-layer-3">
                {/* Sin un solo pedido resuelto, el aro marcaba 0% — una cifra que
                    nadie midió, con el mismo peso visual que un 0% real. Va "—"
                    en tono neutro: no sabemos nada todavía, y eso no es un mal
                    resultado. Mismo patrón que el gauge de CustomerHistoryCard. */}
                {sinResueltos ? (
                  <div
                    className="flex flex-col items-center justify-center rounded-full border border-dashed border-border bg-muted/20 text-center px-6"
                    style={{ width: 190, height: 190 }}
                    role="img"
                    aria-label={datosIncompletos
                      ? 'Tasa de confirmación: no se pudieron leer los datos del equipo'
                      : 'Tasa de confirmación sin datos todavía'}
                  >
                    <span className="text-5xl font-bold text-muted-foreground leading-none">—</span>
                    <span className="hud-label mt-3">confirmación</span>
                    {/* Cuando la consulta del equipo falló, `hoy` son ceros de
                        relleno: decir "Sin pedidos resueltos hoy" sería afirmar
                        un hecho sobre la operación que NO se midió. Son dos
                        cosas distintas y la leyenda tiene que distinguirlas. */}
                    <span className="text-[11px] text-muted-foreground mt-1.5 leading-snug">
                      {!datosIncompletos
                        ? 'Sin pedidos resueltos hoy'
                        : equipoEstado === 'error'
                          ? 'No se pudieron leer los datos del equipo'
                          : 'Datos del equipo sin cargar'}
                    </span>
                  </div>
                ) : (
                  <GaugeRing value={tasa} label="confirmación" size={190} />
                )}
              </div>

              {/* Este panel mide la tasa PERSONAL del usuario que está mirando
                  (today_call_stats filtra por operator_id = auth.uid()). Para un
                  dueño o supervisor que no atiende llamadas siempre da 0, y ver
                  ceros sin explicación se lee como "la pantalla está rota".
                  Se dice explícitamente y se apunta a dónde están los del equipo. */}
              {total === 0 && isManagerOfActive && !verEquipo && (
                <div className="rounded-xl border border-border bg-muted/20 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                  Estás en <span className="text-foreground font-semibold">0</span> porque estás
                  viendo <span className="text-foreground font-semibold">tus</span> llamadas y hoy no
                  registraste ninguna. Cambiá a{' '}
                  <span className="text-accent font-semibold">Equipo</span> para ver a toda la tienda.
                </div>
              )}

              {/* No se pudo leer al equipo. Es CRÍTICO decirlo: sin este aviso
                  el aro y las tarjetas muestran ceros que parecen una medición
                  ("hoy no se confirmó nada") cuando en realidad significan
                  "no pude preguntarle a la base". */}
              {verEquipo && equipoEstado === 'error' && (
                <div className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-[11px] leading-relaxed text-danger">
                  <span className="font-semibold">No se pudieron cargar los datos del equipo.</span>{' '}
                  Los ceros de esta pantalla NO significan que no se trabajó: significan que no se
                  pudo leer la base. Recargá la página; si sigue igual, avisá.
                </div>
              )}
              {verEquipo && equipoEstado === 'cargando' && (
                <div className="rounded-xl border border-border bg-muted/20 px-3 py-2.5 text-[11px] text-muted-foreground">
                  Cargando los datos del equipo…
                </div>
              )}

              <div className="tilt-layer-1 space-y-3">
                {/* Con menos de 5 resueltos NO se emite veredicto: decir "en
                    meta" con una sola gestión es darle estatus de conclusión a
                    un dato que no concluye nada. Se dice cuántas hay y ya. */}
                {tasaSinBase ? (
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-muted/50 border border-border text-muted-foreground">
                    {/* Con la consulta del equipo caída, "0 gestiones resueltas
                        hoy" es una afirmación sobre la operación que nadie midió
                        — y contradice el banner rojo de acá arriba. */}
                    {!datosIncompletos
                      ? <>Muestra insuficiente · {tasaInfo.resueltos} {tasaInfo.resueltos === 1 ? 'gestión resuelta' : 'gestiones resueltas'} hoy</>
                      : equipoEstado === 'error'
                        ? 'Sin medición · no se pudieron leer los datos del equipo'
                        : 'Sin medición · datos del equipo sin cargar'}
                  </div>
                ) : (
                  <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold ${tasaBg} ${tasaColor}`}>
                    {tasa >= CONF_TARGET_PCT ? `En meta (${CONF_TARGET_PCT}%)` : tasa >= CONF_TARGET_PCT - 5 ? 'Cerca de la meta' : 'Por debajo de la meta'}
                  </div>
                )}

                {/* Meta del día — mismo cálculo que CounterBar (gestionados sobre
                    la cola del día), para que el Dashboard y la barra de
                    Confirmar nunca muestren números distintos.
                    SOLO en alcance personal, y SOLO si la cola está cargada:
                      · La meta es "lo que YO gestioné sobre MI cola". Con el
                        numerador del equipo y la cola de quien mira, el
                        cociente no significa nada (se veía "1 / 1").
                      · Si workQueue está vacío no se puede distinguir "terminé"
                        de "todavía no cargó la cola", y el cartel gritaba
                        "¡Cola al día!" con 53 pedidos sin confirmar. */}
                {!verEquipo && workQueue.length > 0 && metaDia.goal > 0 && (
                  <div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
                      <span>Meta del día</span>
                      <span className="font-mono tabular-nums text-foreground">
                        <b>{total}</b> / {metaDia.goal}
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-valuenow={metaDia.pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label="Avance de la meta del día"
                      className="h-2 rounded-full bg-foreground/10 overflow-hidden"
                    >
                      <div
                        className="h-full rounded-full bg-accent-gradient transition-[width] duration-700"
                        style={{ width: `${metaDia.pct}%` }}
                      />
                    </div>
                    <div className={`mt-2.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[13px] font-semibold border ${
                      pendLeft === 0
                        ? 'bg-success/10 border-success/28 text-success'
                        : 'bg-accent/10 border-accent/28 text-accent'
                    }`}>
                      {pendLeft === 0
                        ? '✓ ¡Cola al día! No te queda nada pendiente'
                        : <>Te faltan <span className="font-mono tabular-nums">{pendLeft}</span></>}
                    </div>
                  </div>
                )}
              </div>
            </TiltCard>

            {/* Compact KPIs */}
            {/* 2x2 como el mockup, pero solo desde 390px de viewport. Medido en
                vivo a 360px: la columna deja 151px, y el TrendBadge ("+128 vs
                ayer", whitespace-nowrap, 95px) se come los 16px de padding de la
                tarjeta y lo recorta el overflow-hidden del TiltCard. Debajo de
                ese ancho se apilan, que es como estaba antes del rediseño. */}
            <div className="md:col-span-6 grid grid-cols-1 min-[390px]:grid-cols-2 gap-4">
            {[
              { icon: CheckCircle2, label: 'Confirmados', value: hoy.conf, prev: yesterdayData.conf, tone: 'success' as const, spark: sparkData.conf },
              { icon: XCircle, label: 'Cancelados', value: hoy.canc, prev: yesterdayData.canc, tone: 'danger' as const, spark: sparkData.canc },
              { icon: PhoneOff, label: 'No respondió', value: hoy.noresp, prev: yesterdayData.noresp, tone: 'neutral' as const, spark: sparkData.noresp },
              // prev: null — no hay conteo de "total de pedidos de ayer" en los
              // datos que carga esta pantalla. Antes decía 0, que no es "sin
              // dato": es un dato FALSO que produciría un delta inventado.
              // El rótulo solo dice "Total" cuando la cifra ES el total: si la
              // fuente es la cola en memoria, o la paginación se cortó, lo que
              // se ve es una muestra y se llama por su nombre.
              { icon: Package, label: totalEsUniverso ? 'Total pedidos' : 'Pedidos cargados', value: totalOrders, prev: null, tone: 'accent' as const, spark: sparkData.total, extra: `${statusBreakdown.pendientes} pendientes` },
            ].map((k) => (
              <StatTile
                key={k.label}
                icon={k.icon}
                label={k.label}
                value={k.value}
                tone={k.tone}
                spark={k.spark}
                extra={k.extra
                  ? <span className="text-[11px] font-medium text-accent">{k.extra}</span>
                  : <TrendBadge current={k.value} previous={k.prev} />}
              />
            ))}
            </div>
          </motion.div>

          {/* Charts */}
          <motion.div {...fadeUp(0.12)} className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
            <TiltCard className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d h-full">
              <div className="flex items-center justify-between mb-4 tilt-layer-1">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Activity size={14} className="text-accent" aria-hidden="true" /> Tasa de confirmación
                </h3>
                <span className="text-[10px] text-muted-foreground" title="Los días sin ningún pedido resuelto (domingos, festivos, días sin cola) no tienen tasa: la línea se corta en vez de caer a 0%.">
                  días sin resueltos = sin línea
                </span>
              </div>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                    <defs>
                      <linearGradient id="tGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={CHART_ACCENT} stopOpacity={0.45} />
                        <stop offset="100%" stopColor={CHART_ACCENT} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="tGradLine" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor={CHART_ACCENT} />
                        <stop offset="100%" stopColor={CHART_CYAN} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
                    <XAxis dataKey="date" tick={tickStyle} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tick={tickStyle} axisLine={false} tickLine={false} unit="%" />
                    {/* "sin datos" y no "0%": ese día no hubo nada que medir.
                        filterNull={false} es OBLIGATORIO: recharts descarta por
                        defecto las entradas con valor null, así que el formatter
                        de abajo nunca llegaba a correr y al pasar el mouse por
                        un hueco no aparecía nada — el día quedaba sin explicar. */}
                    <Tooltip contentStyle={tooltipStyle} filterNull={false} formatter={(v: number | null) => [v == null ? 'sin datos' : `${v}%`, 'Tasa']} />
                    {/* connectNulls={false}: el hueco de un día sin resueltos
                        queda VISIBLE. Unir los extremos dibujaría una pendiente
                        que atraviesa un día que nadie midió. */}
                    <Area type="monotone" dataKey="tasa" connectNulls={false} stroke="url(#tGradLine)" strokeWidth={3} strokeLinecap="round" fill="url(#tGrad)" style={{ filter: `drop-shadow(0 0 8px ${CHART_ACCENT})` }} dot={(p: { cx?: number; cy?: number; index?: number }) => (p.index != null && chartData[p.index]?.tasa == null)
                      // Sin dato no hay punto: un dot sobre el eje se leería como 0%.
                      ? <g key={`dot-${p.index}`} />
                      : p.index === chartData.length - 1
                      // Punto final destacado: ancla la vista en el dato más reciente.
                      // El mockup usa fill:#fff, pero en tema claro la card es casi
                      // blanca y el punto desaparecería: se usa --background + aro cian.
                      ? <circle key={`dot-${p.index}`} cx={p.cx} cy={p.cy} r={5} fill={hsl('--background')} stroke={CHART_CYAN} strokeWidth={2} style={{ filter: `drop-shadow(0 0 8px ${CHART_CYAN})` }} />
                      : <circle key={`dot-${p.index}`} cx={p.cx} cy={p.cy} r={2} fill={CHART_ACCENT} />
                    } activeDot={{ r: 4, strokeWidth: 2, stroke: hsl('--background') }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </TiltCard>

            <TiltCard className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d h-full">
              <div className="flex items-center justify-between gap-3 flex-wrap mb-4 tilt-layer-1">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Layers size={14} className="text-success" aria-hidden="true" /> Gestiones por día
                </h3>
                {/* A 7d la leyenda de recharts no existe: se dibuja acá con los
                    MISMOS textos, para no perder qué significa cada color. */}
                {period === 7 && (
                  <div className="flex items-center gap-3 flex-wrap">
                    {[
                      { c: 'bg-success', t: 'Confirmados' },
                      { c: 'bg-danger', t: 'Cancelados' },
                      { c: 'bg-muted-foreground/45', t: 'No respondió' },
                    ].map(l => (
                      <span key={l.t} className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span className={`w-2.5 h-2.5 rounded-[3px] ${l.c}`} aria-hidden="true" />
                        {l.t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {/* A 7 días van las barras del handoff: gruesas, con el número
                  IMPRESO adentro de cada segmento y la columna de hoy con
                  contorno cian. La operadora lee su semana sin pasar el mouse
                  por ningún lado.
                  A 15 y 30 días no hay ancho para meter números adentro (se
                  recortarían), así que cae al BarChart de recharts, que aporta
                  ejes y tooltip. Misma serie, misma leyenda. */}
              {period === 7 ? (
                <div className="h-52 flex flex-col justify-end pb-1">
                  <StackedDayBars data={chartData} height={150} />
                </div>
              ) : (
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
                    <XAxis dataKey="date" tick={hoyTick} axisLine={false} tickLine={false} />
                    <YAxis tick={tickStyle} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '6px' }} formatter={(v: string) => v === 'conf' ? 'Confirmados' : v === 'canc' ? 'Cancelados' : 'No respondió'} />
                    {/* Las barras de HOY van con contorno cian: con 30 días
                        seleccionados, sin esta marca la operadora no distingue
                        cuál columna es la de su jornada. */}
                    <Bar dataKey="conf" stackId="a" fill={CHART_SUCCESS} name="conf" radius={[0, 0, 0, 0]} style={{ filter: `drop-shadow(0 0 6px ${CHART_SUCCESS})` }}>
                      {chartData.map((d, i) => (
                        <Cell key={`c-${i}`} stroke={d.esHoy ? CHART_CYAN : 'transparent'} strokeWidth={d.esHoy ? 1.5 : 0} />
                      ))}
                    </Bar>
                    <Bar dataKey="canc" stackId="a" fill={CHART_DANGER} name="canc">
                      {chartData.map((d, i) => (
                        <Cell key={`x-${i}`} stroke={d.esHoy ? CHART_CYAN : 'transparent'} strokeWidth={d.esHoy ? 1.5 : 0} />
                      ))}
                    </Bar>
                    <Bar dataKey="noresp" stackId="a" fill={CHART_MUTED} radius={[6, 6, 0, 0]} name="noresp">
                      {chartData.map((d, i) => (
                        <Cell key={`n-${i}`} stroke={d.esHoy ? CHART_CYAN : 'transparent'} strokeWidth={d.esHoy ? 1.5 : 0} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              )}
            </TiltCard>
          </motion.div>

          {/* F5: Operator ranking */}
          {operatorRanking.length > 1 && (
            <motion.div {...fadeUp(0.15)} className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d mb-5">
              <div className="flex items-center gap-2 mb-4">
                <Trophy size={14} className="text-warning" aria-hidden="true" />
                <h3
                  className="text-sm font-semibold text-foreground"
                  title="Tasa personal de cada operadora: confirmados / lo gestionado (conf+canc+noresp). NO sobre el inflow total del día."
                >
                  Ranking del equipo hoy
                </h3>
              </div>
              {/* Tabla REAL, no divs con role="table": las cifras tienen que
                  quedar asociadas a su encabezado para un lector de pantalla,
                  y con columnas de verdad los rótulos se alinean solos.
                  RankRow no sirve acá — es una fila de ranking de 3 datos, no
                  una tabla de 7 columnas. */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="px-5 py-2.5 text-left hud-label font-normal">#</th>
                      <th className="px-3 py-2.5 text-left hud-label font-normal">Operador(a)</th>
                      <th className="px-3 py-2.5 text-center hud-label font-normal">Conf.</th>
                      <th className="px-3 py-2.5 text-center hud-label font-normal">Canc.</th>
                      <th className="px-3 py-2.5 text-center hud-label font-normal">N/R</th>
                      <th className="px-3 py-2.5 text-center hud-label font-normal">Total</th>
                      <th
                        className="px-3 py-2.5 text-center hud-label font-normal"
                        title="Tasa personal de cada operadora: confirmados / lo gestionado (conf+canc+noresp). NO sobre el inflow total del día."
                      >
                        Tasa pers.
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {operatorRanking.map((op, idx) => {
                      const isMe = op.operatorId === user?.id;
                      // Sin resueltos (día entero de N/R) NO hay tasa que juzgar:
                      // ni color ni cifra. Con muestra chica hay cifra pero no
                      // veredicto — un 100% sacado de 1 gestión no es un 100%.
                      const sinBase = op.tasa === null;
                      const prelim = !sinBase && op.inmaduro;
                      // El umbral es de negocio (CONF_TARGET_PCT), no de
                      // presentación: verde en meta, ámbar en la banda "cerca",
                      // rojo debajo. Sin esto una tasa de 20% se ve igual que 90%.
                      const tasaC = sinBase || prelim
                        ? 'text-muted-foreground'
                        : op.tasa >= CONF_TARGET_PCT ? 'text-success' : op.tasa >= CONF_TARGET_PCT - 5 ? 'text-warning' : 'text-danger';
                      return (
                        <tr
                          key={op.operatorId}
                          className={`border-b border-border last:border-0 transition-colors duration-200 ${
                            isMe ? 'bg-accent/8' : 'hover:bg-card/60'
                          }`}
                        >
                          <td className="px-5 py-2.5 font-mono tabular-nums text-muted-foreground">
                            {idx === 0
                              ? <Trophy size={14} className="text-accent" aria-label="1er lugar" />
                              : idx + 1}
                          </td>
                          <td className="px-3 py-2.5 font-medium text-foreground">
                            {op.name}
                            {isMe && <span className="ml-1.5 text-[10px] text-accent font-semibold">(tú)</span>}
                          </td>
                          <td className="px-3 py-2.5 text-center font-mono tabular-nums text-success">{op.conf}</td>
                          <td className="px-3 py-2.5 text-center font-mono tabular-nums text-danger">{op.canc}</td>
                          <td className="px-3 py-2.5 text-center font-mono tabular-nums text-muted-foreground">{op.noresp}</td>
                          <td className="px-3 py-2.5 text-center font-mono tabular-nums text-foreground">{op.total}</td>
                          <td
                            className={`px-3 py-2.5 text-center font-mono tabular-nums font-bold ${tasaC}`}
                            title={sinBase
                              ? 'Sin pedidos resueltos hoy (solo no respondió) — no hay tasa de confirmación que medir. Es contactabilidad, no calidad de venta.'
                              : prelim
                                ? `Preliminar: solo ${op.resueltos} ${op.resueltos === 1 ? 'pedido resuelto' : 'pedidos resueltos'} hoy — la tasa todavía no es concluyente`
                                : undefined}
                          >
                            {sinBase ? '—' : `${op.tasa}%${prelim ? '·pr' : ''}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {/* Sin esta línea, "—" y "·pr" son ruido. Con ella, la tabla dice
                  cuándo NO está midiendo — que es la mitad de la verdad. */}
              <p className="mt-3 text-[10px] text-muted-foreground leading-relaxed">
                <span className="font-mono">—</span> sin pedidos resueltos hoy (solo no respondió): no hay tasa que medir.
                {' '}<span className="font-mono">·pr</span> preliminar: menos de {MATURITY_MIN_RESUELTOS} resueltos, la tasa aún no concluye.
              </p>
            </motion.div>
          )}

          {/* Products */}
          {prods.length > 0 && (
            <motion.div {...fadeUp(0.18)} className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-5">
              <TiltCard wrapperClassName="md:col-span-2" className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d h-full">
                <h3 className="hud-label mb-4">Distribución por producto</h3>
                <div className="h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={(() => {
                        const top = prods.slice(0, 6).map(([n, d]) => ({ name: truncate(n, 14), value: d.total }));
                        const other = prods.slice(6).reduce((s, [, d]) => s + d.total, 0);
                        if (other > 0) top.push({ name: 'Otros', value: other });
                        return top;
                      })()} cx="50%" cy="50%" innerRadius={40} outerRadius={72} paddingAngle={2} dataKey="value" stroke="none">
                        {prods.slice(0, 7).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => [`${v}`, n]} />
                      <Legend wrapperStyle={{ fontSize: '10px', color: CHART_MUTED }} layout="vertical" align="right" verticalAlign="middle" />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </TiltCard>

              <div className="md:col-span-3 bg-card/40 border border-border rounded-2xl overflow-hidden shadow-card3d hover:border-border-strong transition-colors duration-200">
                <div className="px-5 py-3.5 border-b border-border">
                  <h3 className="hud-label">Detalle por producto</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground text-[10px] uppercase tracking-wider border-b border-border bg-card/30">
                        <th className="text-left px-5 py-2.5 font-medium">Producto</th>
                        <th className="px-3 py-2.5 font-medium">Total</th>
                        <th className="px-3 py-2.5 font-medium">Entreg.</th>
                        <th className="px-3 py-2.5 font-medium">Canc.</th>
                        <th className="px-3 py-2.5 font-medium">Nov.</th>
                        <th
                          className="px-3 py-2.5 font-medium"
                          title="Entregados ÷ total del producto (incluye los que siguen en tránsito). «—» = ningún pedido concluido todavía; «·pr» = todavía queda buena parte del producto sin desenlace, la cifra puede moverse."
                        >
                          Efect.
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {prods.map(([name, d]) => {
                        const efect = d.total > 0 ? Math.round(d.entreg / d.total * 100) : 0;
                        // La FÓRMULA no cambia (sigue siendo entregados ÷ total,
                        // igual que siempre) — lo que cambia es cuándo se emite
                        // veredicto sobre ella. Un producto lanzado esta semana,
                        // con 30 despachos y ninguno cerrado, marcaba 0% en ROJO:
                        // se lee "este producto no entrega" cuando lo cierto es
                        // "todavía no se resolvió ninguno". Mismo criterio de
                        // madurez que CarrierStatsTable (deriveDeliveryMaturity).
                        const mad = deriveDeliveryMaturity(d.entreg, d.devol, d.total);
                        const sinConcluidos = mad.resueltos === 0;
                        const prelim = !sinConcluidos && isRatePreliminary(mad);
                        const ec = sinConcluidos || prelim
                          ? 'text-muted-foreground'
                          : efect >= 55 ? 'text-success' : efect >= 40 ? 'text-warning' : 'text-danger';
                        return (
                          <tr key={name} className="border-b border-border last:border-0 hover:bg-card transition-colors duration-200">
                            <td className="px-5 py-2.5 font-medium max-w-[160px]">
                              <TruncatedText text={name} maxChars={22} className="block" />
                            </td>
                            <td className="px-3 py-2.5 text-center font-mono tabular-nums">{d.total}</td>
                            <td className="px-3 py-2.5 text-center font-mono tabular-nums text-success">{d.entreg}</td>
                            <td className="px-3 py-2.5 text-center font-mono tabular-nums text-danger">{d.canc}</td>
                            <td className="px-3 py-2.5 text-center font-mono tabular-nums text-warning">{d.nov}</td>
                            <td
                              className={`px-3 py-2.5 text-center font-mono tabular-nums font-bold ${ec}`}
                              title={sinConcluidos
                                ? 'Ningún pedido de este producto llegó todavía a entrega ni devolución — no hay efectividad que medir'
                                : prelim
                                  // Se dicen los HECHOS (cuántos concluyeron de
                                  // cuántos) y no un veredicto sobre la calidad
                                  // estadística: "aún no es confiable" era falso
                                  // en cohortes grandes, donde el % concluido
                                  // baja por los cancelados/pendientes y no por
                                  // falta de muestra.
                                  ? `Preliminar: ${mad.resueltos} de ${d.total} pedidos llegaron a entrega o devolución (${mad.pctConcluido}%). El resto sigue sin desenlace logístico, así que esta cifra todavía puede moverse.`
                                  : undefined}
                            >
                              {sinConcluidos ? '—' : `${efect}%${prelim ? '·pr' : ''}`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </motion.div>
          )}

          {/* Cierre summary */}
          <motion.div {...fadeUp(0.24)} className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="hud-label">Resumen del día</h3>
                <p className="text-[10px] text-muted-foreground/70 mt-1 font-mono tabular-nums">{formatDateES(hoyISO)}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { icon: CheckCircle2, label: 'Confirmados', value: hoy.conf, color: 'text-success', iconBg: 'bg-success/14 border-success/30 glow-success', iconColor: 'text-success' },
                { icon: XCircle, label: 'Cancelados', value: hoy.canc, color: 'text-danger', iconBg: 'bg-danger/14 border-danger/30 glow-danger', iconColor: 'text-danger' },
                { icon: PhoneOff, label: 'No respondió', value: hoy.noresp, color: 'text-muted-foreground', iconBg: 'bg-muted/60 border-border', iconColor: 'text-muted-foreground' },
                { icon: Clock, label: 'Pendientes', value: pendLeft, color: 'text-warning', iconBg: 'bg-warning/14 border-warning/30 glow-warning', iconColor: 'text-warning' },
              ].map(item => {
                const Icon = item.icon;
                return (
                  <div key={item.label} className="flex items-center gap-3 p-3.5 rounded-2xl bg-card/40 border border-border hover:border-border-strong transition-colors duration-200">
                    <div className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 ${item.iconBg}`}>
                      <Icon size={16} className={item.iconColor} aria-hidden="true" />
                    </div>
                    <div>
                      <div className={`text-2xl font-bold leading-none ${item.color}`}>
                        <CountUp value={item.value} />
                      </div>
                      <div className="hud-label mt-1.5">{item.label}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        </>
      )}
    </div>
  );
}
