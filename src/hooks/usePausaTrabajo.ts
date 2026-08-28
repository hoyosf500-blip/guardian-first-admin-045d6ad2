import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { isRpcMissing } from '@/lib/rpcError';
import { pausaVigente, PAUSA_MAX_MS, type Pausa } from '@/lib/pausaTrabajo';

// `operator_pausas` todavía no está en los tipos generados (la migración se
// aplica aparte) → cast puntual, mismo patrón que `useOrderLabels`.
// Se castea el CLIENTE, no un método suelto: desestructurar `from`/`rpc` le
// quita el `this` y revienta en runtime (ver la prueba `rpcBinding`).
const sb = supabase as unknown as SupabaseClient;

/**
 * La pausa declarada por el asesor ("estoy en la agencia"), en la base.
 *
 * Ver `src/lib/pausaTrabajo.ts` para el por qué. Acá solo está la plomería:
 * leer la abierta al entrar, abrir una, cerrarla.
 *
 * ⛔ Nunca lanza y nunca bloquea la pantalla. Si la migración todavía no se
 * aplicó —Lovable NO las aplica solas— la tabla no existe, `disponible` queda
 * en false y el botón simplemente no se dibuja. Un botón que existe y falla al
 * tocarlo es peor que un botón ausente: el asesor cree que declaró su pausa,
 * sigue trabajando tranquilo, y el sistema lo acusa igual.
 */
const MS_MINUTO = 60_000;

export function usePausaTrabajo(enabled: boolean) {
  const { user } = useAuth();
  const { activeStoreId } = useStore();
  const [pausa, setPausa] = useState<Pausa | null>(null);
  const [disponible, setDisponible] = useState(true);
  const [trabajando, setTrabajando] = useState(false);
  // Reloj propio: sin esto los minutos de la pausa se quedan congelados en el
  // número que había cuando se abrió, y el tope de vigencia no se nota hasta
  // que algo más provoque un render.
  const [ahora, setAhora] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled || !pausa || pausa.fin != null) return;
    const id = window.setInterval(() => setAhora(Date.now()), MS_MINUTO);
    return () => window.clearInterval(id);
  }, [enabled, pausa]);

  // La pausa abierta que haya quedado (recargó la página, cambió de pantalla).
  useEffect(() => {
    if (!enabled || !user || !activeStoreId) { setPausa(null); return; }
    let vivo = true;
    void (async () => {
      const { data, error } = await sb
        .from('operator_pausas')
        .select('id, motivo, nota, inicio, fin')
        .eq('operator_id', user.id)
        .eq('store_id', activeStoreId)
        .is('fin', null)
        .order('inicio', { ascending: false })
        .limit(1);
      if (!vivo) return;
      if (error) {
        // Migración sin aplicar → se apaga la función entera, en silencio.
        // Cualquier otro error (red, RLS) también deja `pausa` en null: sin
        // dato NO se asume que hay una pausa abierta. Fail-closed: la excusa se
        // demuestra, no se presume.
        if (isRpcMissing(error)) setDisponible(false);
        setPausa(null);
        return;
      }
      const fila = (data as { id: string; motivo: string; nota: string | null; inicio: string; fin: string | null }[] | null)?.[0];
      setDisponible(true);
      setPausa(fila ? { id: fila.id, motivo: fila.motivo, nota: fila.nota, inicio: Date.parse(fila.inicio), fin: null } : null);
    })();
    return () => { vivo = false; };
  }, [enabled, user, activeStoreId]);

  const iniciar = useCallback(async (motivo: string, nota?: string): Promise<boolean> => {
    if (!user || !activeStoreId || !motivo) return false;
    setTrabajando(true);
    const { data, error } = await sb
      .from('operator_pausas')
      .insert({ operator_id: user.id, store_id: activeStoreId, motivo, nota: nota?.trim() || null })
      .select('id, motivo, nota, inicio')
      .limit(1);
    setTrabajando(false);
    if (error) { if (isRpcMissing(error)) setDisponible(false); return false; }
    const fila = (data as { id: string; motivo: string; nota: string | null; inicio: string }[] | null)?.[0];
    // Sin fila confirmada NO se prende la pausa: el asesor tiene que saber que
    // el sistema no se enteró, en vez de creerse cubierto.
    if (!fila) return false;
    setPausa({ id: fila.id, motivo: fila.motivo, nota: fila.nota, inicio: Date.parse(fila.inicio), fin: null });
    setAhora(Date.now());
    return true;
  }, [user, activeStoreId]);

  const terminar = useCallback(async (): Promise<void> => {
    const id = pausa?.id;
    // Se apaga en la pantalla SIEMPRE, aunque el UPDATE falle: dejarla prendida
    // por un error de red le seguiría tapando huecos reales. La fila colgada la
    // vence sola `PAUSA_MAX_MS`.
    setPausa(null);
    if (!id) return;
    setTrabajando(true);
    await sb.from('operator_pausas').update({ fin: new Date().toISOString() }).eq('id', id);
    setTrabajando(false);
  }, [pausa]);

  const vigente = pausaVigente(pausa, ahora);

  // Vencida por tiempo: se cierra sola en la base para que el panel del dueño
  // vea "45 min" y no una pausa abierta desde el martes.
  useEffect(() => {
    if (!enabled || !pausa || pausa.fin != null || vigente) return;
    void terminar();
  }, [enabled, pausa, vigente, terminar]);

  return {
    pausa,
    /** ¿Hay una pausa que cubra AHORA? Es lo que mira el guard. */
    vigente,
    /** false = la migración no está aplicada. No dibujar el botón. */
    disponible,
    trabajando,
    /** Cuánto falta para que la pausa venza sola, en ms (0 si no hay). */
    restanteMs: pausa && pausa.fin == null ? Math.max(0, pausa.inicio + PAUSA_MAX_MS - ahora) : 0,
    ahora,
    iniciar,
    terminar,
  };
}
