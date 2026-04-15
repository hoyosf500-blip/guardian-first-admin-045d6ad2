import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { getTrackingUrl } from '@/lib/orderUtils';
import { toast } from 'sonner';
import {
  ArrowLeft, Copy, ExternalLink, MapPin, Truck, Tag, Phone, User,
  Package, Clock, Calendar, DollarSign, FileText, AlertTriangle, RefreshCw,
  MessageSquare, Send
} from 'lucide-react';
import { motion } from 'framer-motion';

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
  created_at: string;
}

interface Touchpoint {
  id: string;
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

export default function OrderDetailPage() {
  const { externalId } = useParams<{ externalId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [order, setOrder] = useState<OrderRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [touchpoints, setTouchpoints] = useState<Touchpoint[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [noteText, setNoteText] = useState('');
  const [notes, setNotes] = useState<{ id: string; note_text: string; operator_id: string; created_at: string }[]>([]);

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

      // Load touchpoints & notes & profiles in parallel
      const [tpRes, notesRes, profilesRes] = await Promise.all([
        supabase.from('touchpoints').select('*').eq('phone', o.phone).order('created_at', { ascending: false }).limit(50),
        supabase.from('notes').select('*').eq('phone', o.phone).order('created_at', { ascending: false }).limit(50),
        supabase.from('profiles').select('user_id, display_name'),
      ]);

      if (tpRes.data) setTouchpoints(tpRes.data as Touchpoint[]);
      if (notesRes.data) setNotes(notesRes.data);
      if (profilesRes.data) setProfiles(profilesRes.data);
      setLoading(false);
    };

    load();
  }, [externalId]);

  const getOperatorName = (opId: string) => profiles.find(p => p.user_id === opId)?.display_name || 'Operador';

  const addNote = async () => {
    if (!noteText.trim() || !user || !order) return;
    const { data, error } = await supabase.from('notes').insert({
      phone: order.phone,
      note_text: noteText.trim(),
      operator_id: user.id,
      order_id: order.id,
    }).select();
    if (!error && data) {
      setNotes(prev => [...data, ...prev]);
      setNoteText('');
      toast.success('Nota guardada');
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <RefreshCw size={32} className="text-primary animate-spin" />
        <p className="text-sm font-semibold text-foreground">Cargando pedido...</p>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <Package size={32} className="text-muted-foreground" />
        <p className="text-sm font-semibold text-foreground">Pedido no encontrado</p>
        <p className="text-xs text-muted-foreground">ID: {externalId}</p>
        <button onClick={() => navigate(-1)} className="text-xs text-primary hover:underline mt-2">← Volver</button>
      </div>
    );
  }

  const trackUrl = getTrackingUrl(order.transportadora || '', order.guia || '');
  const waMsg = encodeURIComponent(`Hola ${order.nombre}, le escribo sobre su pedido${order.guia ? ` (guía ${order.guia})` : ''}. ¿Cómo va la entrega?`);
  const valor = Number(order.valor) || 0;
  const flete = Number(order.flete) || 0;
  const costoProd = Number(order.costo_prod) || 0;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Back + header */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-4">
        <button onClick={() => navigate(-1)} className="p-2 rounded-xl bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors">
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-bold text-foreground truncate">{order.nombre}</h2>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">ID: {order.external_id}</span>
            <button onClick={() => { navigator.clipboard.writeText(order.external_id || ''); toast.success('ID copiado'); }}>
              <Copy size={10} />
            </button>
          </div>
        </div>
        <span className={`px-3 py-1.5 rounded-xl text-xs font-bold ${
          (order.estado || '').toUpperCase().includes('ENTREGADO') ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20' :
          (order.estado || '').toUpperCase().includes('DEVOL') ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20' :
          (order.estado || '').toUpperCase().includes('NOVEDAD') ? 'bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20' :
          'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20'
        }`}>
          {order.estado}
        </span>
      </motion.div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Info card */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}
          className="bg-card border border-border rounded-2xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-foreground flex items-center gap-2"><User size={14} /> Información del cliente</h3>
          
          <div className="space-y-3">
            <InfoRow icon={<Phone size={13} />} label="Teléfono" value={order.phone} copyable />
            <InfoRow icon={<MapPin size={13} />} label="Ciudad" value={`${order.ciudad || ''}${order.departamento ? `, ${order.departamento}` : ''}`} />
            <InfoRow icon={<FileText size={13} />} label="Dirección" value={order.direccion || '—'} />
            <InfoRow icon={<Package size={13} />} label="Producto" value={`${order.producto || '—'} (x${order.cantidad || 1})`} />
            <InfoRow icon={<Tag size={13} />} label="Tienda" value={order.tienda || '—'} />
          </div>

          <div className="flex gap-2 pt-2">
            <a href={`https://wa.me/57${order.phone}?text=${waMsg}`} target="_blank" rel="noopener noreferrer"
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 text-white text-xs font-bold py-2.5 hover:bg-emerald-700 transition-colors no-underline">
              <MessageSquare size={13} /> WhatsApp
            </a>
            <a href={`tel:${order.phone}`}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 text-white text-xs font-bold py-2.5 hover:bg-blue-700 transition-colors no-underline">
              <Phone size={13} /> Llamar
            </a>
          </div>
        </motion.div>

        {/* Shipping card */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
          className="bg-card border border-border rounded-2xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-foreground flex items-center gap-2"><Truck size={14} /> Envío y seguimiento</h3>

          <div className="space-y-3">
            <InfoRow icon={<Truck size={13} />} label="Transportadora" value={order.transportadora || '—'} />
            <InfoRow icon={<Tag size={13} />} label="Guía" value={order.guia || '—'} copyable={!!order.guia} />
            <InfoRow icon={<Calendar size={13} />} label="Fecha pedido" value={order.fecha || '—'} />
            <InfoRow icon={<Calendar size={13} />} label="Fecha confirmación" value={order.fecha_conf || '—'} />
            <InfoRow icon={<Clock size={13} />} label="Días" value={`${order.dias || 0}d desde pedido · ${order.dias_conf || 0}d desde conf.`} />
          </div>

          {order.novedad && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/5 border border-red-500/20">
              <AlertTriangle size={13} className="text-red-500 mt-0.5 flex-shrink-0" />
              <div>
                <div className="text-[10px] font-semibold text-red-500 mb-0.5">Novedad</div>
                <div className="text-xs text-foreground">{order.novedad}</div>
              </div>
            </div>
          )}

          {trackUrl && (
            <a href={trackUrl} target="_blank" rel="noopener noreferrer"
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-orange-500 text-white text-xs font-bold py-2.5 hover:bg-orange-600 transition-colors no-underline">
              <ExternalLink size={13} /> Rastrear envío
            </a>
          )}
        </motion.div>

        {/* Financial card */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
          className="bg-card border border-border rounded-2xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-foreground flex items-center gap-2"><DollarSign size={14} /> Financiero</h3>
          <div className="space-y-3">
            <InfoRow icon={<DollarSign size={13} />} label="Valor total" value={`$${valor.toLocaleString()}`} />
            <InfoRow icon={<Truck size={13} />} label="Flete" value={`$${flete.toLocaleString()}`} />
            <InfoRow icon={<Package size={13} />} label="Costo producto" value={`$${costoProd.toLocaleString()}`} />
            <InfoRow icon={<DollarSign size={13} />} label="Ganancia est." value={`$${(valor - flete - costoProd).toLocaleString()}`} highlight />
          </div>
        </motion.div>

        {/* Notes card */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
          className="bg-card border border-border rounded-2xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-foreground flex items-center gap-2"><MessageSquare size={14} /> Notas</h3>
          
          <div className="flex gap-2">
            <input
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addNote()}
              placeholder="Agregar nota..."
              className="flex-1 bg-secondary/70 border border-border rounded-lg px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
            <button onClick={addNote} className="p-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
              <Send size={13} />
            </button>
          </div>

          <div className="space-y-2 max-h-48 overflow-y-auto">
            {notes.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">Sin notas</p>}
            {notes.map(n => (
              <div key={n.id} className="text-xs bg-secondary/50 rounded-lg px-3 py-2">
                <div className="flex justify-between mb-1">
                  <span className="font-semibold text-foreground">{getOperatorName(n.operator_id)}</span>
                  <span className="text-muted-foreground">{new Date(n.created_at).toLocaleDateString('es-CO')}</span>
                </div>
                <p className="text-muted-foreground">{n.note_text}</p>
              </div>
            ))}
          </div>
        </motion.div>
      </div>

      {/* Touchpoints timeline */}
      {touchpoints.length > 0 && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}
          className="bg-card border border-border rounded-2xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-foreground flex items-center gap-2"><Clock size={14} /> Historial de gestiones</h3>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {touchpoints.map(tp => (
              <div key={tp.id} className="flex items-start gap-3 text-xs">
                <div className="w-2 h-2 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                <div className="flex-1">
                  <span className="font-semibold text-foreground">{tp.action}</span>
                  <span className="text-muted-foreground ml-2">{getOperatorName(tp.operator_id)}</span>
                </div>
                <span className="text-muted-foreground whitespace-nowrap">{tp.action_date} {tp.action_time}</span>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </div>
  );
}

function InfoRow({ icon, label, value, copyable, highlight }: { icon: React.ReactNode; label: string; value: string; copyable?: boolean; highlight?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className="text-muted-foreground/60 flex-shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] text-muted-foreground">{label}</div>
        <div className={`text-xs truncate ${highlight ? 'font-bold text-emerald-600 dark:text-emerald-400' : 'text-foreground'}`}>{value}</div>
      </div>
      {copyable && (
        <button onClick={() => { navigator.clipboard.writeText(value); toast.success('Copiado'); }}
          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors">
          <Copy size={10} />
        </button>
      )}
    </div>
  );
}
