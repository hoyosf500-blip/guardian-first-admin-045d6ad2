import { useEffect, useRef, useState } from 'react';
import { siguienteRacha, RACHA_UMBRAL_SEG } from '@/lib/rachaRapida';

/**
 * La racha de pedidos rápidos del asesor, en vivo. Escucha el evento local
 * `guardian:mi-gestion` (que dispara markResult en la acción optimista) y mide el
 * hueco contra la marca anterior: ≤3 min = rápido, sube; si no, reinicia.
 *
 * Session-local a propósito (se reinicia al recargar): es una racha del RUN actual,
 * como en un juego — no un histórico. La lógica pura vive en `rachaRapida`.
 */
export function useRachaRapida(umbralSeg: number = RACHA_UMBRAL_SEG) {
  const [racha, setRacha] = useState(0);
  const [mejor, setMejor] = useState(0);
  const lastMarkRef = useRef<number | null>(null);
  const rachaRef = useRef(0);

  useEffect(() => {
    const onMark = () => {
      const now = Date.now();
      const nueva = siguienteRacha(rachaRef.current, lastMarkRef.current, now, umbralSeg);
      lastMarkRef.current = now;
      rachaRef.current = nueva;
      setRacha(nueva);
      setMejor((m) => Math.max(m, nueva));
    };
    window.addEventListener('guardian:mi-gestion', onMark);
    return () => window.removeEventListener('guardian:mi-gestion', onMark);
  }, [umbralSeg]);

  return { racha, mejor };
}
