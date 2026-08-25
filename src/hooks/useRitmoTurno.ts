import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { bogotaToday } from '@/lib/utils';
import { calcularRitmo, type Ritmo } from '@/lib/ritmoTurno';

/**
 * El ritmo del turno del asesor, EN VIVO. Alimenta el velocímetro que lo apura.
 *
 * - `gestionados` y `faltan` los pasa la pantalla (ya los tiene en memoria, en
 *   vivo). Este hook solo aporta el arranque del turno y el reloj que corre.
 * - `desdeMs` = la PRIMERA gestión de hoy del asesor. Se lee UNA vez de
 *   order_results; si todavía no marcó nada, el evento local `guardian:mi-gestion`
 *   (que despacha markResult) lo siembra en la primera marca — sin re-consultar.
 * - Un tick cada 30 s recalcula: así el ritmo BAJA solo si el asesor se detiene,
 *   y la proyección de fin se corre. Esa caída en vivo ES la presión.
 */
export function useRitmoTurno(
  storeId: string | null,
  userId: string | null,
  gestionados: number,
  faltan: number,
): Ritmo & { desdeMs: number | null; nowMs: number } {
  const [desdeMs, setDesdeMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!storeId || !userId) { setDesdeMs(null); return; }
    let vivo = true;
    const startIso = new Date(`${bogotaToday()}T00:00:00-05:00`).toISOString();
    void supabase
      .from('order_results')
      .select('created_at')
      .eq('store_id', storeId)
      .eq('operator_id', userId)
      .eq('module', 'confirmar')
      .in('result', ['conf', 'canc', 'noresp'])
      .gte('created_at', startIso)
      .order('created_at', { ascending: true })
      .limit(1)
      .then(({ data }) => {
        if (!vivo) return;
        const t = data?.[0]?.created_at ? Date.parse(data[0].created_at as string) : null;
        if (t && Number.isFinite(t)) setDesdeMs(t);
      });
    return () => { vivo = false; };
  }, [storeId, userId]);

  // Primera marca del día sin re-consultar: si aún no hay arranque, la fija ahora.
  useEffect(() => {
    const onMark = () => setDesdeMs((prev) => prev ?? Date.now());
    window.addEventListener('guardian:mi-gestion', onMark);
    return () => window.removeEventListener('guardian:mi-gestion', onMark);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const ritmo = calcularRitmo({ gestionados, desdeMs, nowMs, faltan });
  return { ...ritmo, desdeMs, nowMs };
}
