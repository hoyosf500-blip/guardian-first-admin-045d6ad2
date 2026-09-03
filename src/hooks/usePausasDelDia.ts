import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { rangoDiaBogota } from '@/lib/diaBitacora';

/**
 * Las pausas que el equipo declaró un día ("estoy en la agencia", "almuerzo").
 *
 * `operator_pausas` existe desde el 27-ago-2026 y hasta el 4-sep NINGÚN panel
 * la leía: el dueño no podía ver "declaró 4 pausas de 25 min cada una". La RLS
 * deja leer al dueño y al supervisor; la asesora ve solo las suyas.
 *
 * ⛔ `estado` explícito: un equipo sin pausas y una consulta caída no son lo
 * mismo, y sobre esto se le habla a una persona.
 */
export type EstadoPausas = 'cargando' | 'ok' | 'error';

export interface PausaDelDia {
  id: string;
  operatorId: string;
  motivo: string;
  nota: string | null;
  inicioIso: string;
  finIso: string | null;
}

export interface PausasPorPersona {
  operatorId: string;
  cantidad: number;
  /** Minutos sumados de las pausas CERRADAS. Una abierta no suma: no se sabe. */
  minutos: number;
  /** Hay una pausa sin cerrar ahora mismo. */
  abierta: boolean;
  pausas: PausaDelDia[];
}

export function usePausasDelDia(storeId: string | null, ymd: string) {
  const [pausas, setPausas] = useState<PausaDelDia[]>([]);
  const [estado, setEstado] = useState<EstadoPausas>('cargando');

  const cargar = useCallback(async () => {
    if (!storeId) { setPausas([]); setEstado('cargando'); return; }
    const rango = rangoDiaBogota(ymd);
    if (!rango) { setPausas([]); setEstado('error'); return; }
    setEstado('cargando');
    const { data, error } = await supabase
      .from('operator_pausas')
      .select('id, operator_id, motivo, nota, inicio, fin')
      .eq('store_id', storeId)
      .gte('inicio', rango.desdeIso)
      .lt('inicio', rango.hastaIso)
      .order('inicio', { ascending: true })
      .limit(1000);
    if (error) { setPausas([]); setEstado('error'); return; }
    type Cruda = { id: string; operator_id: string; motivo: string; nota: string | null; inicio: string; fin: string | null };
    setPausas(((data ?? []) as unknown as Cruda[]).map((r) => ({
      id: String(r.id),
      operatorId: String(r.operator_id),
      motivo: r.motivo || '',
      nota: r.nota,
      inicioIso: r.inicio,
      finIso: r.fin,
    })));
    setEstado('ok');
  }, [storeId, ymd]);

  useEffect(() => { void cargar(); }, [cargar]);

  const porPersona = useMemo<PausasPorPersona[]>(() => {
    const m = new Map<string, PausasPorPersona>();
    for (const p of pausas) {
      let r = m.get(p.operatorId);
      if (!r) { r = { operatorId: p.operatorId, cantidad: 0, minutos: 0, abierta: false, pausas: [] }; m.set(p.operatorId, r); }
      r.cantidad += 1;
      r.pausas.push(p);
      if (p.finIso) {
        const ms = Date.parse(p.finIso) - Date.parse(p.inicioIso);
        if (Number.isFinite(ms) && ms > 0) r.minutos += Math.round(ms / 60_000);
      } else {
        r.abierta = true;
      }
    }
    return [...m.values()].sort((a, b) => b.minutos - a.minutos || b.cantidad - a.cantidad);
  }, [pausas]);

  return { pausas, porPersona, estado, recargar: cargar };
}
