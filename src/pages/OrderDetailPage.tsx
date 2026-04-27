import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { dbToOrderData, OrderData, getTrackingUrl, getWhatsAppPhone, isPendiente, isNovedad, getErrorMessage } from '@/lib/orderUtils';
import { toast } from 'sonner';
import { copyToClipboard } from '@/lib/clipboard';
import {
  ArrowLeft, Copy, ExternalLink, MapPin, Truck, Tag, Phone, User,
  Package, Clock, Calendar, DollarSign, FileText, AlertTriangle, RefreshCw,
  MessageSquare, Send, PhoneCall, RotateCcw, Undo2, Sparkles,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { buildTimeline } from '@/lib/timelineBuilder';
import { sanitizeNote, sanitizeAction } from '@/lib/sanitize';
import { bogotaToday } from '@/lib/utils';
import { useAiInsight } from '@/hooks/useAiInsight';
import SlaAlertCard from '@/components/order-detail/SlaAlertCard';
import CustomerHistoryCard from '@/components/order-detail/CustomerHistoryCard';
import Timeline from '@/components/order-detail/Timeline';
import CommunicationLog from '@/components/order-detail/CommunicationLog';

interface OrderRow {
  id: string;
  external_id: string | null;
  nombre: string;
  phone: string;
  ciudad: string | null;
  departamento: string | null;
  direccion: string | null;
  producto: string | null;
  estado: string | null;
  fecha: string | null;
  fecha_conf: string | null;
  dias: number | null;
  dias_conf: number | null;
  valor: number | null;
  flete: number | null;
  costo_prod: number | null;
  costo_dev: number | null;
  cantidad: number | null;
  novedad: string | null;
  guia: string | null;
  transportadora: string | null;
  tags: string | null;
  tienda: string | null;
  novedad_sol: boolean | null;
  upload_date: string | null;
  created_at: string;
}

interface Touchpoint {
  id: string;
  phone: string;
  action: string;
  action_date: string | null;
  action_time: string | null;
  operator_id: string;
  created_at: string;
}

interface OrderResultRow {
  id: string;
  order_id: string;
  result: string;
  reason: string | null;
  operator_id: string;
  result_date: string | null;
  result_time: string | null;
  created_at: string;
}

interface NoteRow {
  id: string;
  note_text: string;
  operator_id: string;
  created_at: string;
}

interface Profile {
  user_id: string;
  display_name: string;
}

/** Minimum seconds between successive touchpoints of the same kind (debounce). */
const COMMUNICATION_DEBOUNCE_MS = 30_000;

export default function OrderDetailPage() {
  const { externalId } = useParams<{ externalId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [order, setOrder] = useState<OrderRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [touchpoints, setTouchpoints] = useState<Touchpoint[]>([]);
  const [orderResults, setOrderResults] = useState<OrderResultRow[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [noteText, setNoteText] = useState('');
  const [notes, setNotes] = useState<NoteRow[]>([]);

  // Novedad resolution state (F3)
  const [showReofferInput, setShowReofferInput] = useState(false);
  const [solutionText, setSolutionText] = useState('');
  const [resolving, setResolving] = useState(false);

  // AI insights
  const { ask: askAi, get: getAi } = useAiInsight();

  useEffect(() => {
    if (!externalId) return;
    setLoading(true);

    const load = async () => {
      const { data: orders, error } = await supabase
        .from('orders')
        .select('*')
        .eq('external_id', externalId)
        .limit(1);

      if (error || !orders?.length) {
        setLoading(false);
        return;
      }

      const o = orders[0] as OrderRow;
      setOrder(o);

      // Load touchpoints, notes, order_results & profiles in parallel
      const [tpRes, notesRes, orRes, profilesRes] = await Promise.all([
        supabase.from('touchpoints').select('*').eq('phone', o.phone).order('created_at', { ascending: false }).limit(100),
        supabase.from('notes').select('*').eq('phone', o.phone).order('created_at', { ascending: false }).limit(50),
        supabase.from('order_results').select('*').eq('order_id', o.id).order('created_at', { ascending: false }).limit(50),
        supabase.from('profiles').select('user_id, display_name'),
      ]);

      if (tpRes.data) setTouchpoints(tpRes.data as Touchpoint[]);
      if (notesRes.data) setNotes(notesRes.data as NoteRow[]);
      if (orRes.data) setOrderResults(orRes.data as OrderResultRow[]);
      if (profilesRes.data) setProfiles(profilesRes.data as Profile[]);
      setLoading(false);
    };

    load();
  }, [externalId]);

  // Map operator_id → display_name for the timeline
  const operatorNames = useMemo(() => {
    const map: Record<string, string> = {};
    profiles.forEach((p) => { map[p.user_id] = p.display_name; });
    return map;
  }, [profiles]);

  // Build unified timeline
  const timelineEvents = useMemo(() => {
    if (!order) return [];
    return buildTimeline({
      order,
      touchpoints,
      notes,
      orderResults,
      operatorNames,
    });
  }, [order, touchpoints, notes, orderResults, operatorNames]);

  // Derived OrderData shape for cards that expect it
  const orderData: OrderData | null = useMemo(
    () => (order ? dbToOrderData(order, 0) : null),
    [order],
  );

  const addNote = async () => {
    if (!noteText.trim() || !user || !order) return;
    const cleanNote = sanitizeNote(noteText);
    if (!cleanNote) return;
    const { data, error } = await supabase.from('notes').insert({
      phone: order.phone,
      note_text: cleanNote,
      operator_id: user.id,
      order_id: order.id,
    }).select();
    if (!error && data) {
      setNotes((prev) => [...(data as NoteRow[]), ...prev]);
      setNoteText('');
      toast.success('Nota guardada');
    } else if (error) {
      toast.error('Error guardando nota: ' + error.message);
    }
  };

  /**
   * Registers a communication touchpoint (call/whatsapp) with debounce — avoids
   * spamming the bitácora if the operator accidentally clicks twice.
   */
  const logCommunication = async (channel: 'CALL' | 'WHATSAPP', detail: string) => {
    if (!user || !order) return;

    // Debounce: check the most recent touchpoint of the same channel for this phone
    const now = Date.now();
    const recent = touchpoints.find(
      (tp) => tp.action.startsWith(`${channel}:`) && (now - new Date(tp.created_at).getTime()) < COMMUNICATION_DEBOUNCE_MS,
    );
    if (recent) return; // skip, still within debounce window

    const today = bogotaToday();
    const time = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

    const cleanAction = sanitizeAction(`${channel}: ${detail}`);
    const { data, error } = await supabase.from('touchpoints').insert({
      phone: order.phone,
      action: cleanAction,
      operator_id: user.id,
      action_date: today,
      action_time: time,
    }).select();

    if (!error && data) {
      setTouchpoints((prev) => [...(data as Touchpoint[]), ...prev]);
    }
  };

  /** Resolve a novedad directly from the order detail page (F3). */
  const handleResolveNovedad = async (action: 'reoffer' | 'return') => {
    if (!user || !order || resolving) return;

    const cleanSolution = solutionText.trim();
    if (action === 'reoffer' && cleanSolution.length < 3) {
      toast.error('Escribe la solución (mín. 3 caracteres)');
      return;
    }

    setResolving(true);
    const today = bogotaToday();
    const time = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

    const touchAction = action === 'reoffer'
      ? `NOVEDAD: Volver a ofrecer — ${cleanSolution.slice(0, 180)}`
      : 'NOVEDAD: Devolver al remitente';

    // 1. Insert touchpoint
    const { data: tpData } = await supabase.from('touchpoints').insert({
      phone: order.phone,
      action: sanitizeAction(touchAction),
      operator_id: user.id,
      action_date: today,
      action_time: time,
    }).select();
    if (tpData) setTouchpoints(prev => [...(tpData as Touchpoint[]), ...prev]);

    // 2. Update local DB
    const { error: updateError } = await supabase
      .from('orders')
      .update({ novedad_sol: true, estado: 'NOVEDAD SOLUCIONADA' })
      .eq('id', order.id);

    if (updateError) {
      toast.error('Error guardando: ' + updateError.message);
      setResolving(false);
      return;
    }

    setOrder(prev => prev ? { ...prev, novedad_sol: true, estado: 'NOVEDAD SOLUCIONADA' } : prev);

    // 3. Call Dropi Edge Function if there's an external ID
    if (order.external_id) {
      const toastId = `novedad-detail-${order.external_id}`;
      toast.loading('Dropi: reportando solución…', { id: toastId });

      try {
        const res = await supabase.functions.invoke('dropi-resolve-incidence', {
          body: action === 'reoffer'
            ? { externalId: order.external_id, action, solution: cleanSolution }
            : { externalId: order.external_id, action },
        });
        const data = res?.data as { ok?: boolean; error?: string } | null | undefined;
        if (res?.error || data?.ok === false) {
          const msg = res?.error?.message || data?.error || 'Error desconocido';
          toast.error(`Dropi falló: ${msg}. Novedad revertida.`, { id: toastId, duration: 8000 });
          // Rollback
          await supabase.from('orders').update({ novedad_sol: false, estado: 'NOVEDAD' }).eq('id', order.id);
          setOrder(prev => prev ? { ...prev, novedad_sol: false, estado: 'NOVEDAD' } : prev);
        } else {
          toast.success('Novedad resuelta en Dropi', { id: toastId, duration: 2500 });
        }
      } catch (err: unknown) {
        const msg = getErrorMessage(err);
        toast.error(`Dropi red: ${msg}. Novedad revertida.`, { duration: 8000 });
        await supabase.from('orders').update({ novedad_sol: false, estado: 'NOVEDAD' }).eq('id', order.id);
        setOrder(prev => prev ? { ...prev, novedad_sol: false, estado: 'NOVEDAD' } : prev);
      }
    } else {
      toast.success('Novedad marcada como resuelta');
    }

    setShowReofferInput(false);
    setSolutionText('');
    setResolving(false);
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4" role="status" aria-live="polite">
        <RefreshCw size={32} className="text-accent animate-spin" aria-hidden="true" />
        <p className="text-sm font-semibold text-foreground">Cargando pedido...</p>
      </div>
    );
  }

  if (!order || !orderData) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4" role="alert">
        <Package size={32} className="text-muted-foreground" />
        <p className="text-sm font-semibold text-foreground">Pedido no encontrado</p>
        <p className="text-xs text-muted-foreground">ID: {externalId}</p>
        <button onClick={() => navigate(-1)} className="text-xs text-accent hover:underline mt-2 cursor-pointer">← Volver</button>
      </div>
    );
  }

  const trackUrl = getTrackingUrl(order.transportadora || '', order.guia || '');
  const waMsg = encodeURIComponent(`Hola ${order.nombre}, le escribo sobre su pedido${order.guia ? ` (guía ${order.guia})` : ''}. ¿Cómo va la entrega?`);
  const valor = Number(order.valor) || 0;
  const flete = Number(order.flete) || 0;
  const costoProd = Number(order.costo_prod) || 0;

  const estadoUpper = (order.estado || '').toUpperCase();
  const showConfirmShortcut = isPendiente(estadoUpper);
  const showNovedadShortcut = isNovedad(estadoUpper) && !order.novedad_sol;

  return (
    <main className="max-w-4xl mx-auto space-y-6" aria-label="Detalle del pedido">
      {/* Back + header */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-4 flex-wrap">
        <button onClick={() => navigate(-1)} aria-label="Volver atrás" className="p-2 rounded-lg bg-card border border-border text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-bold text-foreground truncate">{order.nombre}</h2>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">ID: {order.external_id}</span>
            <button onClick={() => { void copyToClipboard(order.external_id || '', 'ID copiado'); }} aria-label="Copiar ID del pedido">
              <Copy size={10} />
            </button>
          </div>
        </div>
        <span className={`px-3 py-1.5 rounded-xl text-xs font-bold border ${
          estadoUpper.includes('ENTREGADO') ? 'bg-success/12 text-success border-success/30' :
          estadoUpper.includes('DEVOL') ? 'bg-danger/12 text-danger border-danger/30' :
          estadoUpper.includes('NOVEDAD') ? 'bg-warning/12 text-warning border-warning/30' :
          'bg-info/12 text-info border-info/30'
        }`}>
          {order.estado}
        </span>

        {/* Quick action shortcuts */}
        {showConfirmShortcut && (
          <button
            onClick={() => navigate('/confirmar')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-accent/12 text-accent border border-accent/30 text-xs font-semibold hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
          >
            <PhoneCall size={12} /> Ir a Confirmar
          </button>
        )}
        {showNovedadShortcut && !showReofferInput && (
          <div className="inline-flex items-center gap-1.5">
            <button
              onClick={() => setShowReofferInput(true)}
              disabled={resolving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-info/12 text-info border border-info/30 text-xs font-semibold hover:bg-info/20 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <RotateCcw size={12} /> Reprogramar
            </button>
            <button
              onClick={() => {
                if (window.confirm('¿Devolver este pedido al remitente? Esta acción se reportará a Dropi.')) {
                  handleResolveNovedad('return');
                }
              }}
              disabled={resolving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-danger/12 text-danger border border-danger/30 text-xs font-semibold hover:bg-danger/20 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <Undo2 size={12} /> Devolver
            </button>
          </div>
        )}
      </motion.div>

      {/* Reoffer solution input (F3) */}
      {showReofferInput && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
          className="bg-info/5 border border-info/25 rounded-xl p-4 flex flex-col gap-2">
          <p className="text-xs font-semibold text-info">Solución para reprogramar entrega:</p>
          <input
            value={solutionText}
            onChange={(e) => setSolutionText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleResolveNovedad('reoffer')}
            placeholder="Ej: Cliente pide enviar el martes, nueva dirección Cra 45 #12-30"
            disabled={resolving}
            autoFocus
            className="bg-card border border-border rounded-lg px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 transition-colors"
          />
          <div className="flex gap-2">
            <button
              onClick={() => handleResolveNovedad('reoffer')}
              disabled={resolving || solutionText.trim().length < 3}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-accent text-accent-foreground text-xs font-bold hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer"
            >
              {resolving ? <RefreshCw size={12} className="animate-spin" /> : <Send size={12} />}
              {resolving ? 'Enviando…' : 'Enviar a Dropi'}
            </button>
            <button
              onClick={() => { setShowReofferInput(false); setSolutionText(''); }}
              disabled={resolving}
              className="px-3 py-2 rounded-lg bg-card border border-border text-muted-foreground text-xs font-semibold hover:text-foreground hover:border-border-strong transition-colors disabled:opacity-50 cursor-pointer"
            >
              Cancelar
            </button>
          </div>
        </motion.div>
      )}

      {/* SLA Alert Card */}
      <SlaAlertCard order={orderData} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Info card */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}
          className="bg-surface border border-border rounded-xl p-5 space-y-4 hover:border-border-strong transition-colors duration-200">
          <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <User size={13} aria-hidden="true" /> Información del cliente
          </h3>

          <div className="space-y-3">
            <InfoRow icon={<Phone size={13} />} label="Teléfono" value={order.phone} copyable />
            <InfoRow icon={<MapPin size={13} />} label="Ciudad" value={`${order.ciudad || ''}${order.departamento ? `, ${order.departamento}` : ''}`} />
            <InfoRow icon={<FileText size={13} />} label="Dirección" value={order.direccion || '—'} />
            <InfoRow icon={<Package size={13} />} label="Producto" value={`${order.producto || '—'} (x${order.cantidad || 1})`} />
            <InfoRow icon={<Tag size={13} />} label="Tienda" value={order.tienda || '—'} />
          </div>

          <div className="flex gap-2 pt-1">
            <a
              href={`https://wa.me/${getWhatsAppPhone(order.phone)}?text=${waMsg}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => logCommunication('WHATSAPP', 'Mensaje enviado al cliente')}
              aria-label="Enviar WhatsApp al cliente"
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-accent text-accent-foreground text-xs font-bold py-2.5 hover:opacity-90 transition-opacity duration-200 no-underline cursor-pointer"
            >
              <MessageSquare size={13} aria-hidden="true" /> WhatsApp
            </a>
            <a
              href={`tel:${order.phone}`}
              onClick={() => logCommunication('CALL', 'Llamada saliente')}
              aria-label="Llamar al cliente"
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-card border border-border text-foreground text-xs font-bold py-2.5 hover:bg-surface hover:border-border-strong transition-colors duration-200 no-underline cursor-pointer"
            >
              <Phone size={13} aria-hidden="true" /> Llamar
            </a>
          </div>
        </motion.div>

        {/* Shipping card */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
          className="bg-surface border border-border rounded-xl p-5 space-y-4 hover:border-border-strong transition-colors duration-200">
          <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <Truck size={13} aria-hidden="true" /> Envío y seguimiento
          </h3>

          <div className="space-y-3">
            <InfoRow icon={<Truck size={13} />} label="Transportadora" value={order.transportadora || '—'} />
            <InfoRow icon={<Tag size={13} />} label="Guía" value={order.guia || '—'} copyable={!!order.guia} />
            <InfoRow icon={<Calendar size={13} />} label="Fecha pedido" value={order.fecha || '—'} />
            <InfoRow icon={<Calendar size={13} />} label="Fecha confirmación" value={order.fecha_conf || '—'} />
            <InfoRow icon={<Clock size={13} />} label="Días" value={`${order.dias || 0}d desde pedido · ${order.dias_conf || 0}d desde conf.`} />
          </div>

          {order.novedad && (
            <div className="space-y-2">
              <div className="flex items-start gap-2 p-3 rounded-xl bg-danger/8 border border-danger/25">
                <AlertTriangle size={13} className="text-danger mt-0.5 flex-shrink-0" aria-hidden="true" />
                <div>
                  <div className="text-[10px] font-semibold text-danger uppercase tracking-wider mb-0.5">Novedad</div>
                  <div className="text-xs text-foreground">{order.novedad}</div>
                </div>
              </div>
              {/* AI novedad action suggestion */}
              {!order.novedad_sol && (() => {
                const aiKey = `novedad-${order.id}`;
                const ai = getAi(aiKey);
                const buildCtx = () => [
                  `Novedad: ${order.novedad}`,
                  `Estado: ${order.estado}`,
                  `Días sin movimiento: ${order.dias_conf || order.dias || 0}`,
                  `Transportadora: ${order.transportadora || 'N/A'}`,
                  `Valor: $${(Number(order.valor) || 0).toLocaleString()}`,
                  `Ciudad: ${order.ciudad || 'N/A'}`,
                  `Dirección: ${order.direccion || 'N/A'}`,
                ].join('\n');
                return (
                  <>
                    {!ai.reply && !ai.loading && (
                      <button
                        type="button"
                        onClick={() => askAi(aiKey, 'novedad_action', buildCtx())}
                        className="w-full inline-flex items-center justify-center gap-1.5 py-2 rounded-lg bg-accent/10 border border-accent/30 text-accent text-[11px] font-semibold hover:bg-accent hover:text-accent-foreground transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                      >
                        <Sparkles size={11} aria-hidden="true" /> Sugerencia IA
                      </button>
                    )}
                    {ai.loading && (
                      <div className="flex items-center gap-1.5 py-2 px-3 rounded-lg bg-accent/5 border border-accent/20 text-[11px] text-accent">
                        <RefreshCw size={11} className="animate-spin" aria-hidden="true" /> Analizando...
                      </div>
                    )}
                    {ai.reply && (
                      <div className="p-2.5 rounded-lg bg-accent/5 border border-accent/25 text-[11px] text-foreground whitespace-pre-line leading-relaxed">
                        <span className="text-accent font-semibold inline-flex items-center gap-1 mb-1"><Sparkles size={10} aria-hidden="true" /> Sugerencia IA</span>
                        <br />{ai.reply}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {trackUrl && (
            <a
              href={trackUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Rastrear envío en sitio de la transportadora"
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-accent/40 bg-accent/10 text-accent text-xs font-bold py-3 hover:bg-accent hover:text-accent-foreground transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none no-underline cursor-pointer"
            >
              <ExternalLink size={14} aria-hidden="true" /> Rastrear envío
            </a>
          )}
        </motion.div>

        {/* Financial card */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
          className="bg-surface border border-border rounded-xl p-5 space-y-4 md:col-span-2 hover:border-border-strong transition-colors duration-200">
          <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <DollarSign size={13} aria-hidden="true" /> Financiero
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <InfoRow icon={<DollarSign size={13} />} label="Valor total" value={`$${valor.toLocaleString()}`} />
            <InfoRow icon={<Truck size={13} />} label="Flete" value={`$${flete.toLocaleString()}`} />
            <InfoRow icon={<Package size={13} />} label="Costo producto" value={`$${costoProd.toLocaleString()}`} />
            <InfoRow icon={<DollarSign size={13} />} label="Ganancia est." value={`$${(valor - flete - costoProd).toLocaleString()}`} highlight />
          </div>
        </motion.div>
      </div>

      {/* Customer history */}
      <CustomerHistoryCard currentPhone={order.phone} currentOrderId={order.id} />

      {/* Timeline + Communication log */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
          className="bg-surface border border-border rounded-xl p-5 hover:border-border-strong transition-colors duration-200">
          <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2 mb-4">
            <Clock size={13} aria-hidden="true" /> Historial del pedido
          </h3>
          <Timeline events={timelineEvents} emptyText="Sin eventos registrados todavía" />
        </motion.div>

        <CommunicationLog events={timelineEvents} />
      </div>

      {/* Notes */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}
        className="bg-surface border border-border rounded-xl p-5 space-y-4 hover:border-border-strong transition-colors duration-200">
        <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
          <MessageSquare size={13} aria-hidden="true" /> Notas
        </h3>

        <div className="flex gap-2">
          <input
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addNote()}
            placeholder="Agregar nota..."
            aria-label="Escribir una nota sobre el pedido"
            className="flex-1 bg-card border border-border rounded-lg px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-accent/40 hover:border-border-strong transition-colors duration-200"
          />
          <button
            onClick={addNote}
            aria-label="Guardar nota"
            className="p-2 rounded-lg bg-accent text-accent-foreground hover:opacity-90 transition-opacity duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <Send size={13} aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-2 max-h-48 overflow-y-auto">
          {notes.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">Sin notas</p>}
          {notes.map((n) => {
            const operatorName = profiles.find((p) => p.user_id === n.operator_id)?.display_name || 'Operador';
            return (
              <div key={n.id} className="text-xs bg-card border border-border/50 rounded-lg px-3 py-2">
                <div className="flex justify-between mb-1">
                  <span className="font-semibold text-foreground">{operatorName}</span>
                  <span className="text-subtle">{new Date(n.created_at).toLocaleDateString('es-CO')}</span>
                </div>
                <p className="text-muted-foreground">{n.note_text}</p>
              </div>
            );
          })}
        </div>
      </motion.div>
    </main>
  );
}

function InfoRow({ icon, label, value, copyable, highlight }: { icon: React.ReactNode; label: string; value: string; copyable?: boolean; highlight?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className="text-muted-foreground/60 flex-shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] text-muted-foreground">{label}</div>
        <div className={`text-xs truncate ${highlight ? 'font-bold text-success' : 'text-foreground'}`}>{value}</div>
      </div>
      {copyable && (
        <button onClick={() => { void copyToClipboard(value, 'Copiado'); }}
          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors">
          <Copy size={10} />
        </button>
      )}
    </div>
  );
}
