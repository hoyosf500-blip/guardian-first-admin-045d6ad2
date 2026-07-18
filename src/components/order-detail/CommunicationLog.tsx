import { motion } from 'framer-motion';
import { MessageSquare } from 'lucide-react';
import { TimelineEvent } from '@/lib/timelineBuilder';
import Timeline from './Timeline';

interface Props {
  events: TimelineEvent[];
}

/**
 * Bitácora de comunicaciones — filtra la timeline a las categorías de
 * comunicación (llamadas, WhatsApp, SMS) y las renderiza con Timeline
 * en modo compacto. Si no hay comunicaciones aún, muestra un empty
 * state explicando qué hacer.
 */
export default function CommunicationLog({ events }: Props) {
  const commEvents = events.filter(
    (e) => e.category === 'call' || e.category === 'whatsapp' || e.category === 'sms',
  );

  return (
    <motion.div
      role="log"
      aria-live="polite"
      aria-label="Bitácora de comunicaciones"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d"
    >
      <h3 className="text-sm font-bold text-foreground flex items-center gap-2 mb-4">
        <MessageSquare size={14} className="text-accent" /> Bitácora de comunicaciones
      </h3>

      {commEvents.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 gap-2 text-center">
          <div className="w-12 h-12 rounded-2xl bg-accent/14 border border-accent/30 text-accent flex items-center justify-center">
            <MessageSquare size={20} />
          </div>
          <p className="text-xs text-muted-foreground max-w-[240px]">
            Aún no hay comunicaciones registradas. Los botones <strong>Llamar</strong> y{' '}
            <strong>WhatsApp</strong> de arriba quedarán registrados automáticamente aquí.
          </p>
        </div>
      ) : (
        <Timeline events={commEvents} compact />
      )}
    </motion.div>
  );
}
