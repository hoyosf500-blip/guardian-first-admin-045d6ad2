import { OrderData, truncate } from '@/lib/orderUtils';

interface Props {
  items: OrderData[];
  onOpenCall: (idx: number) => void;
}

export default function WorkList({ items, onOpenCall }: Props) {
  if (!items.length) {
    return (
      <div className="text-center py-10 text-muted-foreground">
        <div className="text-5xl mb-3">✅</div>
        <p className="text-sm">No hay pedidos en este filtro</p>
      </div>
    );
  }

  return (
    <div className="grid md:grid-cols-2 gap-2">
      {items.slice(0, 50).map((o, i) => {
        const pClass = o.dias >= 6 ? 'bg-red' : o.dias === 5 ? 'bg-orange' : o.dias >= 3 ? 'bg-yellow' : 'bg-green';
        return (
          <div
            key={o.phone + o.idx}
            onClick={() => onOpenCall(i)}
            className={`flex items-center gap-3 p-3.5 bg-card border border-border rounded-lg cursor-pointer transition-all hover:bg-card2 active:scale-[0.99] ${
              o.result ? 'opacity-50' : o.dias >= 6 ? 'urgent-pulse' : ''
            }`}
          >
            <div className={`w-1.5 h-9 rounded-sm flex-shrink-0 ${pClass}`} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold truncate">{o.nombre}</div>
              <div className="text-[11px] text-muted-foreground flex gap-2 mt-0.5">
                <span>📍 {o.ciudad || '—'}</span>
                <span>📦 {truncate(o.producto || '—', 15)}</span>
              </div>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-bold">D{o.dias}</span>
            {o.result && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                o.result === 'conf' ? 'bg-green/15 text-green' :
                o.result === 'canc' ? 'bg-red/15 text-red' :
                'bg-muted text-muted-foreground'
              }`}>
                {o.result === 'conf' ? '✅' : o.result === 'canc' ? '❌' : '📵'}
              </span>
            )}
          </div>
        );
      })}
      {items.length > 50 && (
        <div className="text-center py-3 text-sm text-muted-foreground col-span-full">
          Mostrando 50 de {items.length}
        </div>
      )}
    </div>
  );
}
