import { useEffect, useRef, useState } from 'react';
import { Timer } from 'lucide-react';
import { formatMMSS, seDemora } from '@/lib/tiempoEnPedido';

/**
 * Reloj del pedido actual: cuánto lleva el asesor en el que tiene abierto.
 * Apura a no demorarse. Se REINICIA al cambiar de pedido (prop `pedidoId`).
 *
 * SELF-CONTAINED a propósito: lleva su propio tick de 1 s, así re-renderiza
 * SOLO este chip y NO todo CallView (que es pesado y frágil). Por eso vive en
 * su componente y no como un hook dentro de CallView.
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
  const demora = seDemora(seg);

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-xs font-bold tabular-nums transition-colors ${
        demora ? 'border-danger/50 bg-danger/15 text-danger' : 'border-border bg-muted/40 text-muted-foreground'
      }`}
      title={demora
        ? 'Llevás más de 5 minutos en este pedido — dale, hay cola esperando.'
        : 'Tiempo en este pedido.'}
    >
      <Timer size={12} aria-hidden="true" />
      {formatMMSS(seg)}
      {demora && <span className="ml-0.5">· dale</span>}
    </span>
  );
}
