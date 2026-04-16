import { useState } from 'react';
import { OrderData } from '@/lib/orderUtils';
import { calcPriority, getPriorityLevel, PRIORITY_CONFIG } from '@/lib/alertSystem';
import { CheckCircle2, XCircle, PhoneOff, MapPin, Package, RotateCcw } from 'lucide-react';
import { TruncatedText } from '@/components/TruncatedText';

interface Props {
  items: OrderData[];
  onOpenCall: (idx: number) => void;
}

export default function WorkList({ items, onOpenCall }: Props) {
  const [visibleCount, setVisibleCount] = useState(50);

  if (!items.length) {
    return (
      <div className="text-center py-10 text-muted-foreground">
        <CheckCircle2 size={40} className="mx-auto mb-3 text-green" />
        <p className="text-sm">No hay pedidos en este filtro</p>
      </div>
    );
  }

  return (
    <div className="grid md:grid-cols-2 gap-2">
      {items.slice(0, visibleCount).map((o, i) => {
        const pClass = o.dias >= 7 ? 'bg-red' : o.dias >= 4 ? 'bg-yellow' : 'bg-green';
        const pLevel = getPriorityLevel(calcPriority(o));
        const pCfg = PRIORITY_CONFIG[pLevel];
        return (
          <div
            key={`${o.phone}-${o.idx}`}
            onClick={() => onOpenCall(i)}
            className={`flex items-center gap-3 p-3.5 bg-card border border-border rounded-lg cursor-pointer transition-all hover:bg-card2 active:scale-[0.99] ${
              o.result ? 'opacity-50' : o.dias >= 7 ? 'urgent-pulse' : ''
            }`}
          >
            <div className={`w-1.5 h-9 rounded-sm flex-shrink-0 ${pClass}`} />
            <div className="flex-1 min-w-0">
              <TruncatedText
                text={o.nombre}
                cssTruncate
                className="block text-sm font-semibold truncate"
              />
              <div className="text-[11px] text-muted-foreground flex gap-2 mt-0.5 items-center">
                <span className="inline-flex items-center gap-0.5"><MapPin size={10} /> {o.ciudad || '—'}</span>
                <span className="inline-flex items-center gap-0.5">
                  <Package size={10} />
                  <TruncatedText text={o.producto || '—'} maxChars={15} />
                </span>
              </div>
            </div>
            {pLevel !== 'low' && (
              <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded border ${pCfg.bgClass} ${pCfg.color}`}>{pCfg.label}</span>
            )}
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${o.dias >= 7 ? 'bg-red/15 text-red' : o.dias >= 4 ? 'bg-yellow/15 text-yellow' : 'bg-green/15 text-green'}`}>D{o.dias}</span>
            {o.retryCount && !o.result && (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-orange-500/15 text-orange-500 inline-flex items-center gap-0.5">
                <RotateCcw size={10} /> {o.retryCount}/3
              </span>
            )}
            {o.result && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold inline-flex items-center ${
                o.result === 'conf' ? 'bg-green/15 text-green' :
                o.result === 'canc' ? 'bg-red/15 text-red' :
                'bg-muted text-muted-foreground'
              }`}>
                {o.result === 'conf' ? <CheckCircle2 size={12} /> : o.result === 'canc' ? <XCircle size={12} /> : <PhoneOff size={12} />}
              </span>
            )}
          </div>
        );
      })}
      {items.length > visibleCount && (
        <div className="text-center py-3 col-span-full space-y-2">
          <p className="text-sm text-muted-foreground">Mostrando {visibleCount} de {items.length}</p>
          <button
            onClick={() => setVisibleCount(prev => prev + 50)}
            className="text-xs px-4 py-1.5 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors"
          >
            Ver más
          </button>
        </div>
      )}
    </div>
  );
}
