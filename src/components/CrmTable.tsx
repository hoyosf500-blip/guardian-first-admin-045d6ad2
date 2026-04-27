import { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { OrderData, getTrackingUrl, getWhatsAppPhone, calcDias, calcBusinessDays } from '@/lib/orderUtils';
import { calcPriority, getPriorityLevel, PRIORITY_CONFIG } from '@/lib/alertSystem';
import { getAlertLevel } from '@/lib/alertSystem';
import { toast } from 'sonner';
import {
  AlertTriangle, ExternalLink,
  MessageSquare, Phone as PhoneIcon, Clock, User, Copy,
  Package, Truck, MapPin, RotateCcw, Layers, DollarSign,
  Send, Tag, CheckCircle, ChevronDown, Search, List,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSessionState } from '@/hooks/useSessionState';
import { useSegAssignment } from '@/hooks/useSegAssignment';
import CrmCallView from './CrmCallView';
import { TruncatedText } from '@/components/TruncatedText';
import LockBadge from '@/components/LockBadge';
import { getActionSLA } from '@/lib/actionSla';
import { bogotaToday } from '@/lib/utils';

/**
 * Acciones que liberan la asignación del pedido (assigned_to = NULL).
 * El resto de acciones mantiene al pedido asignado a la operadora que las
 * ejecutó para que pueda darle continuidad al día siguiente.
 */
const RESOLVING_ACTIONS = new Set(['Resuelto', 'Devolucion solicitada', 'Solicite devolucion']);

interface Touchpoint {
  id: string;
  phone: string;
  action: string;
  action_date: string;
  action_time: string | null;
  operator_id: string;
  created_at: string;
}

interface Profile {
  user_id: string;
  display_name: string;
}

interface CrmTableProps {
  data: OrderData[];
  actions: string[];
  module: 'SEG' | 'RESCUE';
  emptyIcon: React.ReactNode;
  emptyTitle: string;
  emptyDesc: string;
  initialDelayed?: boolean;
  stalledCategoryFilter?: string | null;
  /**
   * When provided, the parent owns the status filter (e.g. via the Seguimiento
   * stat cards) and the internal filter pills row is hidden. Passing `null`
   * means "no filter active".
   */
  controlledStatusFilter?: string | null;
  onControlledStatusFilterChange?: (key: string | null) => void;
}

/**
 * Unified tone system — only 5 tones across 14 statuses so the CRM stops looking
 * like a rainbow. Amber is only for the primary "in route" state so it carries
 * real signal instead of being random decoration.
 */
type Tone = 'neutral' | 'accent' | 'warning' | 'danger' | 'success' | 'muted';

interface StatusColumn {
  key: string;
  label: string;
  icon: React.ReactNode;
  tone: Tone;
  match: (estado: string) => boolean;
}

const TONE_STYLES: Record<Tone, {
  dot: string;
  headerBg: string;
  headerBorder: string;
  headerText: string;
  headerCount: string;
  pillIdle: string;
  pillActive: string;
  activeCountBg: string;
  idleCountBg: string;
}> = {
  neutral: {
    dot: 'bg-foreground/60',
    headerBg: 'bg-surface',
    headerBorder: 'border-border',
    headerText: 'text-foreground',
    headerCount: 'bg-card text-foreground border border-border',
    pillIdle: 'bg-surface border-border text-foreground hover:border-border-strong',
    pillActive: 'bg-card border-border-strong text-foreground',
    activeCountBg: 'bg-accent text-accent-foreground',
    idleCountBg: 'bg-card text-muted-foreground border border-border',
  },
  accent: {
    dot: 'bg-accent',
    headerBg: 'bg-accent/10',
    headerBorder: 'border-accent/30',
    headerText: 'text-accent',
    headerCount: 'bg-accent text-accent-foreground',
    pillIdle: 'bg-accent/5 border-accent/20 text-accent hover:bg-accent/10 hover:border-accent/40',
    pillActive: 'bg-accent text-accent-foreground border-accent',
    activeCountBg: 'bg-black/20 text-accent-foreground',
    idleCountBg: 'bg-accent/15 text-accent',
  },
  warning: {
    dot: 'bg-orange-500',
    headerBg: 'bg-orange-500/8',
    headerBorder: 'border-orange-500/30',
    headerText: 'text-orange-500',
    headerCount: 'bg-orange-500/15 text-orange-500 border border-orange-500/30',
    pillIdle: 'bg-orange-500/5 border-orange-500/20 text-orange-500 hover:bg-orange-500/10 hover:border-orange-500/40',
    pillActive: 'bg-orange-500 text-white border-orange-500',
    activeCountBg: 'bg-black/25 text-white',
    idleCountBg: 'bg-orange-500/15 text-orange-500',
  },
  danger: {
    dot: 'bg-red-500',
    headerBg: 'bg-red-500/8',
    headerBorder: 'border-red-500/30',
    headerText: 'text-red-500',
    headerCount: 'bg-red-500/15 text-red-500 border border-red-500/30',
    pillIdle: 'bg-red-500/5 border-red-500/20 text-red-500 hover:bg-red-500/10 hover:border-red-500/40',
    pillActive: 'bg-red-500 text-white border-red-500',
    activeCountBg: 'bg-black/25 text-white',
    idleCountBg: 'bg-red-500/15 text-red-500',
  },
  success: {
    dot: 'bg-emerald-500',
    headerBg: 'bg-emerald-500/8',
    headerBorder: 'border-emerald-500/30',
    headerText: 'text-emerald-500',
    headerCount: 'bg-emerald-500/15 text-emerald-500 border border-emerald-500/30',
    pillIdle: 'bg-emerald-500/5 border-emerald-500/20 text-emerald-500 hover:bg-emerald-500/10 hover:border-emerald-500/40',
    pillActive: 'bg-emerald-500 text-white border-emerald-500',
    activeCountBg: 'bg-black/25 text-white',
    idleCountBg: 'bg-emerald-500/15 text-emerald-500',
  },
  muted: {
    dot: 'bg-muted-foreground/60',
    headerBg: 'bg-muted/40',
    headerBorder: 'border-border',
    headerText: 'text-muted-foreground',
    headerCount: 'bg-card text-muted-foreground border border-border',
    pillIdle: 'bg-muted/40 border-border text-muted-foreground hover:border-border-strong hover:text-foreground',
    pillActive: 'bg-muted-foreground/20 border-border-strong text-foreground',
    activeCountBg: 'bg-foreground/15 text-foreground',
    idleCountBg: 'bg-card text-muted-foreground border border-border',
  },
};

const STATUS_COLUMNS: StatusColumn[] = [
  { key: 'procesamiento', label: 'En Procesamiento', icon: <Package size={14} />, tone: 'neutral',
    match: (e) => ['PENDIENTE', 'EN PROCESAMIENTO', 'EN PUNTO DROOP', 'ALISTAMIENTO', 'EN BODEGA DROPI', 'RECOGIDO POR DROPI'].includes(e) },
  { key: 'guia', label: 'Guía Generada', icon: <Tag size={14} />, tone: 'neutral',
    match: (e) => ['GUIA GENERADA', 'GUIA_GENERADA', 'PREPARADO PARA TRANSPORTADORA', 'ENTREGADO A TRANSPORTADORA'].includes(e) },
  { key: 'bodega_trans', label: 'Bodega Transportadora', icon: <Package size={14} />, tone: 'neutral',
    match: (e) => ['EN BODEGA TRANSPORTADORA', 'ADMITIDA'].includes(e) },
  { key: 'transito', label: 'En Tránsito', icon: <Truck size={14} />, tone: 'neutral',
    match: (e) => ['EN TRANSPORTE', 'EN DESPACHO', 'EN TRASLADO NACIONAL', 'EN TERMINAL ORIGEN', 'EN TERMINAL DESTINO', 'ENTREGADA A CONEXIONES'].includes(e) },
  { key: 'reparto', label: 'En Reparto', icon: <Truck size={14} />, tone: 'accent',
    match: (e) => ['EN REPARTO', 'TELEMERCADEO', 'REENVÍO', 'REENVIO', 'EN DISTRIBUCION', 'EN REEXPEDICION'].includes(e) },
  { key: 'novedad', label: 'Novedad', icon: <AlertTriangle size={14} />, tone: 'warning',
    match: (e) => e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA' },
  { key: 'oficina', label: 'Reclame en Oficina', icon: <MapPin size={14} />, tone: 'warning',
    match: (e) => e.includes('OFICINA') || e.includes('RECLAME') },
  { key: 'rechazado', label: 'Rechazado', icon: <AlertTriangle size={14} />, tone: 'danger',
    match: (e) => e === 'RECHAZADO' },
  { key: 'novedad_sol', label: 'Novedad Solucionada', icon: <CheckCircle size={14} />, tone: 'success',
    match: (e) => e === 'NOVEDAD SOLUCIONADA' },
  { key: 'devolucion_transito', label: 'Devolución en Tránsito', icon: <RotateCcw size={14} />, tone: 'danger',
    match: (e) => e === 'DEVOLUCION EN TRANSITO' },
  { key: 'devolucion', label: 'Devolución', icon: <RotateCcw size={14} />, tone: 'danger',
    match: (e) => e === 'DEVOLUCION' },
  { key: 'indemnizada', label: 'Indemnizada', icon: <DollarSign size={14} />, tone: 'muted',
    match: (e) => e.includes('INDEMNIZADA') },
  { key: 'entregado', label: 'Entregado', icon: <CheckCircle size={14} />, tone: 'success',
    match: (e) => e === 'ENTREGADO' },
  { key: 'cancelado', label: 'Cancelado', icon: <Layers size={14} />, tone: 'muted',
    match: (e) => e === 'CANCELADO' },
  { key: 'otros', label: 'Otros', icon: <Layers size={14} />, tone: 'muted',
    match: () => true },
];

function classifyOrder(estado: string): string {
  const e = estado.toUpperCase();
  for (const col of STATUS_COLUMNS) {
    if (col.key !== 'otros' && col.match(e)) return col.key;
  }
  return 'otros';
}

function getOrderStatusAgeDays(order: OrderData): number {
  const fechaConf = (order.fechaConf || '').trim();
  if (fechaConf && fechaConf !== 'undefined') {
    return calcBusinessDays(fechaConf);
  }
  return order.diasConf || 0;
}

function isExcludedFromDelay(estado: string): boolean {
  const e = estado.toUpperCase();
  return e === 'ENTREGADO' || e.includes('DEVOL') || e === 'CANCELADO' || e === 'RECHAZADO';
}

const STALLED_LABEL_TO_MATCH: Record<string, (e: string) => boolean> = {
  'Guía Generada': (e) => ['GUIA GENERADA', 'GUIA_GENERADA', 'PREPARADO PARA TRANSPORTADORA', 'ENTREGADO A TRANSPORTADORA'].includes(e),
  'En Procesamiento': (e) => ['PENDIENTE', 'EN PROCESAMIENTO', 'EN PUNTO DROOP', 'ALISTAMIENTO', 'EN BODEGA DROPI', 'RECOGIDO POR DROPI'].includes(e),
  'Oficina': (e) => e.includes('OFICINA') || e.includes('RECLAME'),
  'Novedad': (e) => e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA',
  'En Tránsito': (e) => ['EN TRANSPORTE', 'EN DESPACHO', 'EN TRASLADO NACIONAL', 'EN TERMINAL ORIGEN', 'EN TERMINAL DESTINO', 'ENTREGADA A CONEXIONES'].includes(e),
  'Reparto': (e) => ['EN REPARTO', 'TELEMERCADEO', 'REENVÍO', 'REENVIO', 'EN DISTRIBUCION', 'EN REEXPEDICION'].includes(e),
};

/**
 * Wrapper que preserva scrollTop por columna entre re-renders.
 * Si React remonta el contenedor (p. ej. tras smartMerge que cambió el array),
 * useLayoutEffect restaura la posición ANTES del paint, evitando el "salto al tope".
 */
function ColumnBody({
  columnKey,
  scrollPositionsRef,
  children,
}: {
  columnKey: string;
  scrollPositionsRef: React.MutableRefObject<Map<string, number>>;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!scrollRef.current) return;
    const saved = scrollPositionsRef.current.get(columnKey);
    if (saved !== undefined && scrollRef.current.scrollTop !== saved) {
      scrollRef.current.scrollTop = saved;
    }
  });
  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        scrollPositionsRef.current.set(columnKey, (e.target as HTMLDivElement).scrollTop);
      }}
      className="bg-surface/60 rounded-b-xl border border-border/50 border-t-0 flex-1 p-2 space-y-2 max-h-[70vh] overflow-y-auto"
    >
      {children}
    </div>
  );
}

export default function CrmTable({ data, actions, module, emptyIcon, emptyTitle, emptyDesc, initialDelayed, stalledCategoryFilter, controlledStatusFilter, onControlledStatusFilterChange }: CrmTableProps) {
  const { user, isAdmin } = useAuth();
  const [touchpoints, setTouchpoints] = useState<Touchpoint[]>([]);
  const [allTouchpoints, setAllTouchpoints] = useState<Touchpoint[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  // Lista de admins. Pedidos con assigned_to apuntando a un admin se
  // tratan como pool libre — un admin nunca debería estar reservando
  // pedidos operativos. Esto cubre histórico (Fabian trabajando como
  // operadora por error) sin necesidad de tocar la DB cada vez.
  const [adminIds, setAdminIds] = useState<string[]>([]);
  const [results, setResults] = useState<Record<string, string>>({});
  // Preservar scrollTop por columna durante refreshes (cron Dropi cada 1 min).
  // Si React remonta el contenedor, useLayoutEffect restaura antes del paint
  // para que la operadora no pierda su posición de scroll.
  const scrollPositionsRef = useRef<Map<string, number>>(new Map());
  const [expandedPhone, setExpandedPhone] = useState<string | null>(null);
  const [search, setSearch] = useSessionState<string>(`crmtable:${module}:search`, '');
  const [onlyDelayed, setOnlyDelayed] = useSessionState<boolean>(`crmtable:${module}:onlyDelayed`, false);
  const [internalActiveFilter, setInternalActiveFilter] = useSessionState<string | null>(`crmtable:${module}:activeFilter`, null);
  const isControlled = controlledStatusFilter !== undefined;
  const activeFilter = isControlled ? (controlledStatusFilter ?? null) : internalActiveFilter;
  const setActiveFilter = (next: string | null | ((prev: string | null) => string | null)) => {
    const resolved = typeof next === 'function' ? next(activeFilter) : next;
    if (isControlled) {
      onControlledStatusFilterChange?.(resolved);
    } else {
      setInternalActiveFilter(resolved);
    }
  };
  const [showManaged, setShowManaged] = useSessionState<boolean>(`crmtable:${module}:showManaged`, false);
  const [assignmentFilter, setAssignmentFilter] = useSessionState<'available' | 'all'>(`crmtable:${module}:assignmentFilter`, 'available');
  const { claimSegOrder, releaseSegOrder } = useSegAssignment();
  const [view, setView] = useSessionState<'list' | 'call'>(`crmtable:${module}:view`, 'list');
  // Guard contra doble-click: trackea dbIds en vuelo en markAction.
  const markingInFlightRef = useRef<Set<string>>(new Set());

  // Sync with parent initialDelayed prop
  useEffect(() => {
    if (initialDelayed !== undefined) {
      setOnlyDelayed(initialDelayed);
    }
  }, [initialDelayed, setOnlyDelayed]);

  useEffect(() => {
    if (!data.length) return;
    const phones = [...new Set(data.map(o => o.phone))];
    const prefix = module === 'SEG' ? 'SEG' : 'RESCUE';

    const fetchAllTouchpoints = async () => {
      const allTp: Touchpoint[] = [];
      for (let i = 0; i < phones.length; i += 100) {
        const batch = phones.slice(i, i + 100);
        // Fix 20: limitar columnas + cap por batch para evitar N+1 explosivo
        const { data: tp } = await supabase.from('touchpoints')
          .select('id, phone, action, action_date, action_time, operator_id, created_at')
          .in('phone', batch)
          .order('created_at', { ascending: false })
          .limit(20 * batch.length);
        if (tp) allTp.push(...(tp as Touchpoint[]));
      }
      return allTp;
    };

    fetchAllTouchpoints().then(allTp => {
      setAllTouchpoints(allTp);
      const moduleTp = allTp.filter(t =>
        t.action.startsWith(`${prefix}:`) || t.action.startsWith(`${module}:`)
      );
      setTouchpoints(moduleTp);

      // Último touchpoint por teléfono
      const latestByPhone: Record<string, { action: string; when: number }> = {};
      moduleTp.forEach(t => {
        const when = new Date(t.created_at).getTime();
        const prev = latestByPhone[t.phone];
        if (!prev || when > prev.when) {
          latestByPhone[t.phone] = { action: t.action, when };
        }
      });

      // Snooze vivo por pedido: según SLA de la acción usada
      const nowMs = Date.now();
      const snoozed: Record<string, string> = {};
      data.forEach(o => {
        if (!o.dbId) return;
        const hit = latestByPhone[o.phone];
        if (!hit) return;
        const slaMs = getActionSLA(hit.action) * 3600000;
        const remainingMs = slaMs - (nowMs - hit.when);
        if (remainingMs > 0) {
          const hoursLeft = Math.max(1, Math.round(remainingMs / 3600000));
          const label = hit.action.replace(/^(SEG|RESCUE):\s*/, '');
          snoozed[o.dbId] = `${label} · vuelve en ${hoursLeft}h`;
        }
      });
      setResults(snoozed);
    });

    supabase.from('profiles').select('user_id, display_name').then(({ data: p, error }) => {
      if (error) console.error('Error loading profiles:', error.message);
      if (p) setProfiles(p);
    });
  }, [data, module]);

  // C3: lista de admins. Pedidos con assigned_to apuntando a admin se
  // tratan como pool libre / sin asignar.
  useEffect(() => {
    let cancelled = false;
    supabase.from('user_roles').select('user_id').eq('role', 'admin').then(({ data: rows }) => {
      if (cancelled || !rows) return;
      setAdminIds(rows.map(r => r.user_id));
    });
    return () => { cancelled = true; };
  }, []);

  // Fix 26: Map en lugar de find lineal por cada llamada.
  const profileMap = useMemo(
    () => new Map(profiles.map(p => [p.user_id, p.display_name])),
    [profiles],
  );
  const getOperatorName = useCallback(
    (id: string) => profileMap.get(id) ?? 'Operador',
    [profileMap],
  );

  const phoneTouchpoints = useMemo(() => {
    const map: Record<string, Touchpoint[]> = {};
    touchpoints.forEach(tp => {
      if (!map[tp.phone]) map[tp.phone] = [];
      map[tp.phone].push(tp);
    });
    return map;
  }, [touchpoints]);

  // Mapa cross-modular: incluye touchpoints de Confirmar, Novedades, etc.
  // Solo se usa para el badge de contactos en la card colapsada.
  const allPhoneTouchpoints = useMemo(() => {
    const map: Record<string, Touchpoint[]> = {};
    allTouchpoints.forEach(tp => {
      if (!map[tp.phone]) map[tp.phone] = [];
      map[tp.phone].push(tp);
    });
    return map;
  }, [allTouchpoints]);

  const getLastTouchTime = useCallback((phone: string): number | null => {
    const tps = phoneTouchpoints[phone];
    if (!tps || !tps.length) return null;
    return new Date(tps[0].created_at).getTime();
  }, [phoneTouchpoints]);

  const markAction = async (order: OrderData, action: string) => {
    // D6: doble-click guard.
    if (!order.dbId || markingInFlightRef.current.has(order.dbId)) return;
    markingInFlightRef.current.add(order.dbId);
    try {
      // C4: si el "owner" actual es admin, lo tratamos como sin asignar.
      const ownerIsAdmin = order.assignedTo ? adminIds.includes(order.assignedTo) : false;
      // Bloquea la acción si el pedido pertenece a otra operadora real (no admin).
      if (!isAdmin && user && order.assignedTo && order.assignedTo !== user.id && !ownerIsAdmin) {
        const owner = getOperatorName(order.assignedTo);
        toast.error(`Pedido en atención por ${owner}`);
        return;
      }
      // C2: admin NUNCA hace claim/release. Solo registra el touchpoint
      // y aplica el efecto visual optimista.
      if (!isAdmin && user && order.dbId && (!order.assignedTo || ownerIsAdmin)) {
        const claimed = await claimSegOrder(order.dbId);
        if (!claimed) {
          toast.error('Otra operadora tomó este pedido');
          return;
        }
      }
      const slaMs = getActionSLA(action) * 3600000;
      const hoursLeft = Math.max(1, Math.round(slaMs / 3600000));
      const label = `${action} · vuelve en ${hoursLeft}h`;
      setResults(prev => ({ ...prev, [order.dbId!]: label }));
      if (user) {
        const now = new Date();
        const tp = {
          phone: order.phone,
          action: `${module}: ${action}`,
          operator_id: user.id,
          action_date: bogotaToday(),
          action_time: now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }),
        };
        const { data: inserted } = await supabase.from('touchpoints').insert(tp).select();
        if (inserted) setTouchpoints(prev => [...inserted, ...prev]);
      }
      if (!isAdmin && order.dbId && RESOLVING_ACTIONS.has(action)) {
        await releaseSegOrder(order.dbId);
      }
      toast.success(action);
    } finally {
      markingInFlightRef.current.delete(order.dbId);
    }
  };


  const managedCount = useMemo(() => data.filter(o => o.dbId && results[o.dbId]).length, [data, results]);
  const delayedCount = useMemo(() => data.filter(order => !isExcludedFromDelay(order.estado) && getOrderStatusAgeDays(order) >= 2).length, [data]);

  const filtered = useMemo(() => {
    let list = data;
    // Filtro de asignación: por defecto cada operadora ve "Disponibles"
    // (sin asignar + suyos). Toggle "Todos" lo deshabilita para auditoría.
    if (assignmentFilter === 'available' && user) {
      list = list.filter(o =>
        !o.assignedTo
        || o.assignedTo === user.id
        || adminIds.includes(o.assignedTo)
      );
    }
    // Hide managed orders unless showManaged is on
    if (!showManaged) {
      list = list.filter(o => !(o.dbId && results[o.dbId]));
    }
    if (search) {
      const s = search.toLowerCase();
      list = list.filter(o =>
        o.nombre.toLowerCase().includes(s) || o.phone.includes(s) ||
        (o.guia || '').toLowerCase().includes(s) || (o.ciudad || '').toLowerCase().includes(s)
      );
    }
    if (onlyDelayed) {
      list = list.filter(order => !isExcludedFromDelay(order.estado) && getOrderStatusAgeDays(order) >= 2);
      // Further filter by stalled category if set
      if (stalledCategoryFilter && STALLED_LABEL_TO_MATCH[stalledCategoryFilter]) {
        const matchFn = STALLED_LABEL_TO_MATCH[stalledCategoryFilter];
        list = list.filter(o => matchFn(o.estado.toUpperCase()));
      }
    }
    if (activeFilter) {
      list = list.filter(o => classifyOrder(o.estado) === activeFilter);
    }
    return list;
  }, [data, search, onlyDelayed, activeFilter, showManaged, results, stalledCategoryFilter, assignmentFilter, user, adminIds]);

  const columns = useMemo(() => {
    const groups: Record<string, OrderData[]> = {};
    STATUS_COLUMNS.forEach(c => { groups[c.key] = []; });
    filtered.forEach(o => {
      const key = classifyOrder(o.estado);
      groups[key].push(o);
    });
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => getOrderStatusAgeDays(b) - getOrderStatusAgeDays(a));
    }
    return groups;
  }, [filtered]);

  // Count all data (not filtered) for pills
  const allCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    STATUS_COLUMNS.forEach(c => { counts[c.key] = 0; });
    data.forEach(o => { counts[classifyOrder(o.estado)]++; });
    return counts;
  }, [data]);

  if (!data.length) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-16 h-16 rounded-2xl bg-secondary flex items-center justify-center mb-4">{emptyIcon}</div>
        <h3 className="text-base font-semibold text-foreground mb-1">{emptyTitle}</h3>
        <p className="text-sm text-muted-foreground max-w-xs">{emptyDesc}</p>
      </div>
    );
  }

  const activeColumns = activeFilter
    ? STATUS_COLUMNS.filter(c => c.key === activeFilter && columns[c.key].length > 0)
    : STATUS_COLUMNS.filter(c => columns[c.key].length > 0);

  return (
    <div className="space-y-5">
      {/* Search + delayed filter */}
      <div className="flex flex-col gap-3 lg:flex-row">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar nombre, teléfono, guía, ciudad..."
            aria-label="Buscar pedidos"
            className="w-full pl-10 pr-4 py-2.5 bg-surface border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-accent/40 hover:border-border-strong transition-colors duration-200"
          />
        </div>
        <button
          type="button"
          aria-pressed={onlyDelayed}
          onClick={() => setOnlyDelayed(prev => !prev)}
          className={`inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors duration-200 whitespace-nowrap cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
            onlyDelayed
              ? 'border-orange-500 bg-orange-500 text-white shadow-lg shadow-orange-500/20'
              : 'border-border bg-surface text-foreground hover:border-orange-400/50 hover:text-orange-500'
          }`}
        >
          <Clock size={14} aria-hidden="true" />
          <span>Retrasados (2d+)</span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${onlyDelayed ? 'bg-white/25 text-white' : 'bg-card text-foreground'}`}>
            {delayedCount}
          </span>
        </button>
        {managedCount > 0 && (
          <button
            type="button"
            aria-pressed={showManaged}
            onClick={() => setShowManaged(prev => !prev)}
            className={`inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors duration-200 whitespace-nowrap cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
              showManaged
                ? 'border-emerald-500 bg-emerald-500 text-white shadow-lg shadow-emerald-500/20'
                : 'border-border bg-surface text-foreground hover:border-emerald-400/50 hover:text-emerald-500'
            }`}
          >
            <CheckCircle size={14} aria-hidden="true" />
            <span>Mostrar En espera</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${showManaged ? 'bg-white/25 text-white' : 'bg-card text-foreground'}`}>
              {managedCount}
            </span>
          </button>
        )}

        {/* Disponibles / Todos — filtro de asignación.
            "Disponibles" = sin asignar + suyos (default operativo).
            "Todos" = ver toda la cola (auditoría / ver lo de la otra). */}
        <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
          <button
            type="button"
            onClick={() => setAssignmentFilter('available')}
            aria-pressed={assignmentFilter === 'available'}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-[11px] font-semibold transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
              assignmentFilter === 'available'
                ? 'bg-accent text-accent-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <User size={13} aria-hidden="true" /> Disponibles
          </button>
          <button
            type="button"
            onClick={() => setAssignmentFilter('all')}
            aria-pressed={assignmentFilter === 'all'}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-[11px] font-semibold transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
              assignmentFilter === 'all'
                ? 'bg-accent text-accent-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Layers size={13} aria-hidden="true" /> Todos
          </button>
        </div>

        {/* Lista / Llamar toggle */}
        <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
          <button
            type="button"
            onClick={() => setView('list')}
            aria-pressed={view === 'list'}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-[11px] font-semibold transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
              view === 'list'
                ? 'bg-accent text-accent-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <List size={13} aria-hidden="true" /> Lista
          </button>
          <button
            type="button"
            onClick={() => setView('call')}
            aria-pressed={view === 'call'}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-[11px] font-semibold transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
              view === 'call'
                ? 'bg-accent text-accent-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <PhoneIcon size={13} aria-hidden="true" /> Llamar
          </button>
        </div>
      </div>

      {/* Status filter pills — only render when NOT controlled by a parent
          (e.g. Rescate). In Seguimiento the stat cards ARE the filter, so we
          hide this row to avoid a duplicated status strip under the cards. */}
      {!isControlled && (
        <div className="flex gap-1.5 flex-wrap">
          {STATUS_COLUMNS.filter(c => allCounts[c.key] > 0).map(col => {
            const isActive = activeFilter === col.key;
            const t = TONE_STYLES[col.tone];
            return (
              <button
                key={col.key}
                type="button"
                aria-pressed={isActive}
                onClick={() => setActiveFilter(isActive ? null : col.key)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                  isActive ? t.pillActive : t.pillIdle
                }`}
              >
                {col.icon}
                <span>{col.label}</span>
                <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${
                  isActive ? t.activeCountBg : t.idleCountBg
                }`}>
                  {allCounts[col.key]}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {onlyDelayed && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-orange-500/20 bg-orange-500/5 px-4 py-3">
          <div className="text-sm font-semibold text-foreground flex items-center gap-2">
            <AlertTriangle size={14} className="text-orange-500" />
            Mostrando solo pedidos con 2+ días hábiles sin movimiento
          </div>
          <div className="text-xs text-muted-foreground">{filtered.length} de {data.length} pedidos</div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/40 px-6 py-16 text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
            <Search size={20} />
          </div>
          <h3 className="text-base font-semibold text-foreground">No hay pedidos para este filtro</h3>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {onlyDelayed ? 'No encontramos pedidos retrasados.' : 'Prueba ajustando la búsqueda.'}
          </p>
        </div>
      ) : view === 'call' ? (
        <CrmCallView
          items={filtered}
          actions={actions}
          managed={results}
          phoneTouchpoints={phoneTouchpoints}
          getOperatorName={getOperatorName}
          onAction={markAction}
          storageKey={module.toLowerCase()}
          module={module}
        />
      ) : (
        <div className="relative">
          {/* Scroll fade indicators */}
          <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-6 z-10 bg-gradient-to-r from-background to-transparent opacity-0 transition-opacity" id="scroll-fade-left" />
          <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-6 z-10 bg-gradient-to-l from-background to-transparent" />
          <div className="overflow-x-auto pb-4 -mx-2 px-2 scroll-hint">
            <div className="flex gap-3" style={{ minWidth: `${activeColumns.length * 300}px` }}>
            {activeColumns.map((col, colIdx) => {
              const items = columns[col.key];
              const t = TONE_STYLES[col.tone];
              return (
                <motion.div
                  key={col.key}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: colIdx * 0.04, duration: 0.25 }}
                  className="flex-1 min-w-[280px] max-w-[340px] flex flex-col"
                >
                  {/* Column header — solid surface + thin tone accent bar */}
                  <div className={`relative rounded-t-xl border border-b-0 ${t.headerBorder} ${t.headerBg} px-3.5 py-2.5 flex items-center justify-between`}>
                    <span className={`absolute left-0 top-0 bottom-0 w-[3px] rounded-tl-xl ${t.dot}`} aria-hidden="true" />
                    <div className={`flex items-center gap-2 pl-1.5 ${t.headerText}`}>
                      <span className="flex items-center justify-center w-6 h-6 rounded-md bg-card/60 border border-border/60">
                        {col.icon}
                      </span>
                      <span className="text-[13px] font-semibold tracking-tight text-foreground">{col.label}</span>
                    </div>
                    <span className={`inline-flex items-center justify-center min-w-[28px] h-6 px-2 rounded-md text-[11px] font-bold tabular-nums ${t.headerCount}`}>
                      {items.length}
                    </span>
                  </div>

                  {/* Column body */}
                  <ColumnBody columnKey={col.key} scrollPositionsRef={scrollPositionsRef}>
                    {items.map((o, i) => (
                      <OrderCard
                        key={o.dbId || o.externalId || `${o.phone}-${o.idx}`}
                        order={o}
                        managed={o.dbId ? results[o.dbId] : undefined}
                        expanded={expandedPhone === o.phone}
                        onToggle={() => setExpandedPhone(expandedPhone === o.phone ? null : o.phone)}
                        onAction={(action) => markAction(o, action)}
                        currentUserId={user?.id}
                        adminIds={adminIds}
                        actions={actions}
                        touchpoints={phoneTouchpoints[o.phone] || []}
                        allTouchpoints={allPhoneTouchpoints[o.phone] || []}
                        getOperatorName={getOperatorName}
                        getLastTouchTime={getLastTouchTime}
                        module={module}
                        index={i}
                        statusColor={col.tone}
                      />
                    ))}
                  </ColumnBody>
                </motion.div>
              );
            })}
          </div>
        </div>
        </div>
      )}
    </div>
  );
}

/* ── Order Card ── */
interface OrderCardProps {
  order: OrderData;
  managed: string | undefined;
  expanded: boolean;
  onToggle: () => void;
  onAction: (action: string) => void;
  currentUserId: string | undefined;
  adminIds: string[];
  actions: string[];
  touchpoints: Touchpoint[];
  /** Todos los touchpoints del teléfono (cross-modular) — para el badge de contactos */
  allTouchpoints: Touchpoint[];
  getOperatorName: (id: string) => string;
  getLastTouchTime: (phone: string) => number | null;
  module: string;
  index: number;
  statusColor: string;
}

function OrderCard({ order: o, managed, expanded, onToggle, onAction, currentUserId, adminIds, actions, touchpoints: tps, allTouchpoints: allTps, getOperatorName, index, statusColor }: OrderCardProps) {
  const isMine = !!(
    o.assignedTo && currentUserId
    && o.assignedTo === currentUserId
    && !adminIds.includes(o.assignedTo)
  );
  const isOtherOwner = !!(
    o.assignedTo && currentUserId
    && o.assignedTo !== currentUserId
    && !adminIds.includes(o.assignedTo)
  );
  const ownerName = isOtherOwner && o.assignedTo ? getOperatorName(o.assignedTo) : '';
  const diasEnEstatus = getOrderStatusAgeDays(o);
  const alert = getAlertLevel(diasEnEstatus, o.dias, o.estado, o.transportadora);
  const trackUrl = getTrackingUrl(o.transportadora, o.guia);
  const priority = calcPriority(o);
  const pLevel = getPriorityLevel(priority);
  const pConfig = PRIORITY_CONFIG[pLevel];
  const waMsg = encodeURIComponent(`Hola ${o.nombre}, le escribo sobre su pedido${o.guia ? ` (guía ${o.guia})` : ''}. ¿Cómo va la entrega?`);

  const isDelayed = diasEnEstatus >= 2;

  return (
    <div
      className={`group bg-card rounded-xl border border-border/50 overflow-hidden transition-all duration-200 hover:border-border hover:shadow-md ${managed ? 'opacity-40' : ''}`}
    >
      {/* Card body */}
      <div className="px-3.5 pt-3.5 pb-3 cursor-pointer" onClick={onToggle}>
        {/* Name + ID + days */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <TruncatedText
              text={o.nombre}
              cssTruncate
              className="block text-[13px] font-bold text-foreground truncate"
            />
            {o.externalId && (
              <a href={`/pedido/${o.externalId}`} onClick={e => e.stopPropagation()} className="text-[10px] text-primary hover:underline font-mono mt-0.5 block truncate">
                {o.externalId}
              </a>
            )}
            {!o.externalId && <div className="text-[10px] text-muted-foreground font-mono mt-0.5">Sin ID</div>}
          </div>
          <div className="flex flex-col items-end gap-1 flex-shrink-0">
            <TruncatedText
              text={o.estado}
              cssTruncate
              className="text-[9px] font-bold px-2 py-0.5 rounded-md bg-secondary text-muted-foreground uppercase tracking-wide leading-tight max-w-[120px] truncate"
            />
            {pLevel !== 'low' && (
              <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded border ${pConfig.bgClass} ${pConfig.color}`}>
                {pConfig.label}
              </span>
            )}
            <LockBadge lockedBy={o.lockedBy} lockedAt={o.lockedAt} />
            {isMine && (
              <span
                className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-md border bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                title="Asignado a ti"
              >
                <User size={9} aria-hidden="true" /> Mío
              </span>
            )}
            {isOtherOwner && (
              <span
                className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-md border bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30"
                title={`Atendido por ${ownerName}`}
              >
                <User size={9} aria-hidden="true" /> {ownerName}
              </span>
            )}
          </div>
        </div>

        {/* Phone row */}
        <div className="flex items-center gap-1.5 mt-2.5">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground bg-secondary/70 rounded-lg px-2.5 py-1.5 flex-1 min-w-0">
            <PhoneIcon size={11} className="flex-shrink-0 text-muted-foreground/70" />
            <span className="truncate font-mono">{o.phone}</span>
          </div>
          <button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.phone); toast.success('Tel copiado'); }}
            className="p-2 rounded-lg bg-secondary/70 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
            <Copy size={11} />
          </button>
        </div>

        {/* Location & carrier */}
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          {o.ciudad && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground bg-secondary/50 rounded-md px-2 py-1">
              <MapPin size={9} className="text-muted-foreground/60" />{o.ciudad}
            </span>
          )}
          {o.transportadora && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground bg-secondary/50 rounded-md px-2 py-1">
              <Truck size={9} className="text-muted-foreground/60" />{o.transportadora}
            </span>
          )}
        </div>

        {/* Contact history badge — visibilidad cruzada entre operadoras y
            ENTRE módulos. Cuenta todos los touchpoints del teléfono
            (Confirmar, Seguimiento, Rescate, Novedades). Resuelve:
            "no sé si la otra ya llamó o cuántas veces, en cualquier
            sección de la app". */}
        {(() => {
          if (allTps.length === 0) {
            return (
              <div className="mt-2 inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-md bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/25">
                <PhoneIcon size={9} /> Sin contactar
              </div>
            );
          }
          // allTps llega ordenado desc por created_at (la query lo trae así).
          const last = allTps[0];
          const lastMs = new Date(last.created_at).getTime();
          const hoursAgo = (Date.now() - lastMs) / 3600000;
          const opName = getOperatorName(last.operator_id);
          let cls: string;
          let timeLabel: string;
          if (hoursAgo < 1) {
            cls = 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/25';
            timeLabel = `hace ${Math.max(1, Math.round(hoursAgo * 60))}min`;
          } else if (hoursAgo < 24) {
            cls = 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25';
            timeLabel = `hace ${Math.round(hoursAgo)}h`;
          } else if (hoursAgo < 72) {
            cls = 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25';
            timeLabel = `hace ${Math.round(hoursAgo / 24)}d`;
          } else {
            cls = 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/25';
            timeLabel = `hace ${Math.round(hoursAgo / 24)}d`;
          }
          return (
            <div className={`mt-2 inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-md border ${cls}`}>
              <PhoneIcon size={9} />
              <span>{allTps.length} {allTps.length === 1 ? 'contacto' : 'contactos'}</span>
              <span className="opacity-60">·</span>
              <span>{opName}</span>
              <span className="opacity-60">·</span>
              <span>{timeLabel}</span>
            </div>
          );
        })()}

        {/* Guía + tracking — Rastrear is now a proper button, amber outline that goes solid on hover */}
        {o.guia && (
          <div className="mt-2.5 flex items-center gap-2">
            <div className="flex flex-1 min-w-0 items-center gap-1.5 rounded-lg bg-muted/50 border border-border px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground">
              <Tag size={10} className="text-muted-foreground/70 flex-shrink-0" />
              <span className="truncate">{o.guia}</span>
              <button
                onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.guia); toast.success('Guía copiada'); }}
                aria-label="Copiar guía"
                className="flex-shrink-0 rounded p-0.5 transition-colors hover:text-foreground cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              >
                <Copy size={10} />
              </button>
            </div>
            {trackUrl && (
              <a
                href={trackUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(o.guia); toast.success('Guía copiada'); }}
                aria-label="Abrir rastreo de la transportadora"
                className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-[11px] font-semibold text-accent shadow-sm transition-colors duration-200 hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none no-underline cursor-pointer"
              >
                <ExternalLink size={12} aria-hidden="true" />
                <span>Rastrear</span>
              </a>
            )}
          </div>
        )}

        {/* Delay warning — collapsed to 2 tones so it doesn't fight the column tone */}
        {isDelayed && !isExcludedFromDelay(o.estado) && (
          <div className={`mt-2.5 flex items-center gap-2 rounded-lg px-3 py-2 border ${
            diasEnEstatus >= 5
              ? 'bg-red-500/10 border-red-500/25'
              : 'bg-orange-500/10 border-orange-500/25'
          }`}>
            <Clock size={12} className={diasEnEstatus >= 5 ? 'text-red-500' : 'text-orange-500'} />
            <span className={`text-[11px] font-semibold ${diasEnEstatus >= 5 ? 'text-red-500' : 'text-orange-500'}`}>
              {diasEnEstatus}d sin movimiento — {diasEnEstatus >= 5 ? 'Posible pérdida' : diasEnEstatus >= 3 ? 'Llamar + reclamar' : 'Monitorear'}
            </span>
          </div>
        )}

        {/* Alert badge */}
        {alert && alert.level !== 'ok' && alert.level !== 'watch' && (
          <div className="mt-2">
            <span className={`inline-block text-[10px] font-semibold px-2.5 py-1 rounded-md border ${
              alert.level === 'lost' ? 'bg-muted/60 text-muted-foreground border-border' :
              alert.level === 'critical' ? 'bg-red-500/10 text-red-500 border-red-500/25' :
              'bg-orange-500/10 text-orange-500 border-orange-500/25'
            }`}>
              {alert.label}
            </span>
          </div>
        )}

        {/* Managed badge */}
        {managed && (
          <div className="mt-2">
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-semibold bg-emerald-500/10 text-emerald-500 border border-emerald-500/25">
              <CheckCircle size={10} /> {managed}
            </span>
          </div>
        )}
      </div>

      {/* Expanded panel */}
      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="border-t border-border/40 overflow-hidden">
            <div className="px-3.5 py-3.5 space-y-3 bg-secondary/30">
              {/* Info grid */}
              <div className="grid grid-cols-2 gap-2">
                {([
                  { label: 'Producto', value: o.producto || '—', maxChars: 30 },
                  { label: 'Valor', value: `$${o.valor.toLocaleString()}`, maxChars: null },
                  { label: 'Dirección', value: o.direccion || '—', maxChars: 35 },
                  { label: 'Departamento', value: o.departamento || '—', maxChars: null },
                ] as const).map(d => (
                  <div key={d.label} className="bg-card rounded-lg p-2.5 border border-border/30">
                    <div className="text-[9px] text-muted-foreground uppercase tracking-wider font-medium">{d.label}</div>
                    {d.maxChars ? (
                      <TruncatedText
                        text={d.value}
                        maxChars={d.maxChars}
                        className="block text-[11px] font-semibold text-foreground mt-0.5"
                      />
                    ) : (
                      <div className="text-[11px] font-semibold text-foreground mt-0.5 truncate">{d.value}</div>
                    )}
                  </div>
                ))}
              </div>

              {/* Novedad */}
              {o.novedad && (
                <div className="flex items-start gap-2 bg-orange-500/10 border border-orange-500/25 rounded-lg px-3 py-2">
                  <AlertTriangle size={12} className="text-orange-500 mt-0.5 flex-shrink-0" />
                  <TruncatedText
                    text={o.novedad}
                    maxChars={100}
                    className="text-[11px] text-foreground/90 leading-snug"
                  />
                </div>
              )}

              {/* History */}
              {tps.length > 0 && (
                <div>
                  <h4 className="text-[10px] font-semibold text-muted-foreground mb-2 inline-flex items-center gap-1 uppercase tracking-wider">
                    <MessageSquare size={10} /> Historial ({tps.length})
                  </h4>
                  <div className="space-y-1 max-h-28 overflow-y-auto">
                    {tps.slice(0, 5).map(tp => (
                      <div key={tp.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-card border border-border/20 text-[10px]">
                        <div className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                          <User size={9} className="text-primary/70" />
                        </div>
                        <span className="font-semibold text-foreground">{getOperatorName(tp.operator_id)}</span>
                        <span className="text-muted-foreground truncate">{tp.action.replace(/^(SEG|RESCUE): ?/, '')}</span>
                        <span className="ml-auto text-muted-foreground/70 flex-shrink-0 text-[9px]">
                          {tp.action_time || ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Aviso si el pedido es de otra operadora */}
              {isOtherOwner && (
                <div className="flex items-center gap-2 rounded-lg px-3 py-2 border bg-amber-500/10 border-amber-500/25">
                  <User size={12} className="text-amber-600 dark:text-amber-400" />
                  <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                    Atendido por {ownerName} — no puedes ejecutar acciones
                  </span>
                </div>
              )}

              {/* Quick actions */}
              <div className="flex gap-2">
                {isOtherOwner ? (
                  <>
                    <button disabled className="flex-1 text-[11px] py-2.5 rounded-lg bg-emerald-500/40 text-white font-semibold inline-flex items-center justify-center gap-1.5 cursor-not-allowed opacity-60">
                      <Send size={12} /> WhatsApp
                    </button>
                    <button disabled className="flex-1 text-[11px] py-2.5 rounded-lg bg-secondary text-foreground font-semibold inline-flex items-center justify-center gap-1.5 border border-border/50 cursor-not-allowed opacity-60">
                      <PhoneIcon size={12} /> Llamar
                    </button>
                  </>
                ) : (
                  <>
                    <a href={`https://wa.me/${getWhatsAppPhone(o.phone)}?text=${waMsg}`} target="_blank" rel="noopener noreferrer"
                      onClick={() => onAction('WhatsApp enviado')}
                      className="flex-1 text-[11px] py-2.5 rounded-lg bg-emerald-500 text-white font-semibold hover:bg-emerald-600 no-underline inline-flex items-center justify-center gap-1.5 transition-colors">
                      <Send size={12} /> WhatsApp
                    </a>
                    <a href={`tel:+57${o.phone}`}
                      className="flex-1 text-[11px] py-2.5 rounded-lg bg-secondary text-foreground font-semibold hover:bg-secondary/80 no-underline inline-flex items-center justify-center gap-1.5 border border-border/50 transition-colors">
                      <PhoneIcon size={12} /> Llamar
                    </a>
                  </>
                )}
              </div>

              {/* CRM actions */}
              {!managed && !isOtherOwner && (
                <div className="flex flex-wrap gap-1.5">
                  {actions.map(a => (
                    <button key={a} onClick={() => onAction(a)}
                      className="text-[10px] px-3 py-1.5 rounded-lg bg-primary/10 text-primary font-semibold hover:bg-primary/20 border border-primary/15 whitespace-nowrap transition-colors">
                      {a}
                    </button>
                  ))}
                </div>
              )}

            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
