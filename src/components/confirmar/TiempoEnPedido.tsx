import { useEffect, useRef, useState } from 'react';
import { Timer } from 'lucide-react';
import { formatMMSS, nivelTiempo } from '@/lib/tiempoEnPedido';

/**
 * Reloj del pedido actual: cuánto lleva el asesor en el que tiene abierto.
 * GRANDE y visible a propósito (pedido del dueño 25-ago): que el asesor SEPA que
 * lo estamos midiendo. Se REINICIA al cambiar de pedido (prop `pedidoId`).
 *
 * SELF-CONTAINED: lleva su propio tick de 1 s, así re-renderiza SOLO este chip y
 * NO todo CallView (que es pesado y frágil). Verde <3 min (óptimo) · ámbar 3-5 ·
 * rojo 5+ (alerta, y pulsa para que no se pueda ignorar).
 */
export default function TiempoEnPedido({ pedidoId }: { pedidoId: string | null | undefined }) {
  const [inicioMs, setInicioMs] = useState<number>(() => Date.now());
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const idRef = useRef(pedidoId);

  // Reinicio al cambiar de pedido. Guardado en ref para no depender del render.
  useEffect(() => {
    if (pedidoId !== idRef.current) {
      idRef.current = pedidoId;
      const t = Date.now();
      setInicioMs(t);
      setNowMs(t);
    }
  }, [pedidoId]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (!pedidoId) return null;
  const seg = Math.max(0, Math.floor((nowMs - inicioMs) / 1000));
  const nivel = nivelTiempo(seg);

  const estilo = nivel === 'alerta'
    ? 'border-danger bg-danger/15 text-danger motion-safe:animate-pulse'
    : nivel === 'optimo_pasado'
      ? 'border-warning/60 bg-warning/15 text-warning'
      : 'border-success/50 bg-success/10 text-success';
  const titulo = nivel === 'alerta'
    ? 'Llevás más de 5 minutos en este pedido — dale, hay cola esperando.'
    : nivel === 'optimo_pasado'
      ? 'Te pasaste del óptimo de 3 min — cerralo pronto.'
      : 'Tiempo en este pedido (óptimo: 3 min).';

  return (
    <div
      className={`inline-flex items-center gap-2 rounded-xl border-2 px-3 py-1.5 shadow-card3d transition-colors flex-shrink-0 ${estilo}`}
      title={titulo}
      aria-label={`Tiempo en este pedido: ${formatMMSS(seg)}`}
    >
      <Timer size={20} aria-hidden="true" strokeWidth={2.5} />
      <div className="flex flex-col leading-none">
        <span className="text-[9px] font-bold uppercase tracking-wider opacity-75">En este pedido</span>
        <span className="text-2xl font-black tabular-nums leading-none">{formatMMSS(seg)}</span>
      </div>
      {nivel === 'alerta' && <span className="text-sm font-black uppercase ml-0.5">· dale</span>}
    </div>
  );
}
