import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * useAdvisorRoster — el ROSTER completo de asesores de la tienda (no solo los que
 * trabajaron en el rango), con su ÚLTIMA gestión absoluta.
 *
 * Por qué existe (pedido del dueño 26-ago-2026): "siempre mostrame a los asesores".
 * El panel de Productividad arma las tarjetas desde operator_productivity_stats,
 * que SOLO devuelve a quien tuvo actividad en el rango. Resultado: el que dejó de
 * trabajar (María José, 41 días sin gestionar — medido en producción) DESAPARECE
 * justo cuando el dueño más quiere verlo. Este hook trae al equipo entero para que
 * el panel pueda pintar "sin trabajar hace X días · última vez DD mmm".
 *
 * Roster = miembros con rol operator/supervisor (se excluye 'owner' a propósito:
 * el dueño-admin no es un asesor a vigilar, y así NO dependemos de leer user_roles
 * bajo RLS). Un owner que SÍ trabaja igual aparece —viene en las filas de
 * productividad— solo que no se lo agrega como inactivo si deja de gestionar.
 *
 * Honestidad: `ok=false` si la consulta base falla → el panel NO inventa un roster
 * incompleto, simplemente no agrega inactivos (degrada al comportamiento previo).
 * Range-independiente: la "última vez" es absoluta, así que se pide UNA vez por
 * tienda, no por rango.
 */

export interface RosterAdvisor {
  operator_id: string;
  display_name: string;
  role: 'operator' | 'supervisor';
  /** Última gestión (order_results o touchpoints), la más reciente. null si nunca. */
  lastActivityIso: string | null;
}

export interface AdvisorRosterState {
  roster: RosterAdvisor[];
  /** false = falló la consulta base → no agregar inactivos (no inventar roster). */
  ok: boolean;
}

export function useAdvisorRoster(storeId: string | null): AdvisorRosterState {
  const [state, setState] = useState<AdvisorRosterState>({ roster: [], ok: true });

  useEffect(() => {
    if (!storeId) { setState({ roster: [], ok: true }); return; }
    let cancelled = false;

    (async () => {
      const { data: members, error: memErr } = await supabase
        .from('store_members')
        .select('user_id, role')
        .eq('store_id', storeId)
        .in('role', ['operator', 'supervisor']);
      if (cancelled) return;
      if (memErr) { setState({ roster: [], ok: false }); return; }
      const list = (members as { user_id: string; role: 'operator' | 'supervisor' }[] | null) ?? [];
      if (list.length === 0) { setState({ roster: [], ok: true }); return; }

      const ids = list.map((m) => m.user_id);
      const { data: profs } = await supabase
        .from('profiles')
        .select('user_id, display_name')
        .in('user_id', ids);
      if (cancelled) return;
      const nameOf = (id: string) =>
        (profs as { user_id: string; display_name: string | null }[] | null)
          ?.find((p) => p.user_id === id)?.display_name || 'Operador';

      // Última actividad por miembro: máximo entre su último order_result y su
      // último touchpoint, EN ESTA TIENDA. En paralelo — equipos son chicos.
      const lasts = await Promise.all(
        ids.map(async (id) => {
          const [orr, tpr] = await Promise.all([
            supabase.from('order_results').select('created_at')
              .eq('store_id', storeId).eq('operator_id', id)
              .order('created_at', { ascending: false }).limit(1),
            supabase.from('touchpoints').select('created_at')
              .eq('store_id', storeId).eq('operator_id', id)
              .order('created_at', { ascending: false }).limit(1),
          ]);
          const a = orr.data?.[0]?.created_at ? Date.parse(orr.data[0].created_at) : 0;
          const b = tpr.data?.[0]?.created_at ? Date.parse(tpr.data[0].created_at) : 0;
          const maxMs = Math.max(Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0);
          return { id, iso: maxMs > 0 ? new Date(maxMs).toISOString() : null };
        }),
      );
      if (cancelled) return;
      const lastById = new Map(lasts.map((l) => [l.id, l.iso]));

      setState({
        roster: list.map((m) => ({
          operator_id: m.user_id,
          display_name: nameOf(m.user_id),
          role: m.role,
          lastActivityIso: lastById.get(m.user_id) ?? null,
        })),
        ok: true,
      });
    })();

    return () => { cancelled = true; };
  }, [storeId]);

  return state;
}
