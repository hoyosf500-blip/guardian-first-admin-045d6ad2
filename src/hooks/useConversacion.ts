import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import type { MensajeConversacion } from '@/lib/conversacion';

/**
 * La conversación de WhatsApp de un pedido, leída en vivo de ImporChat
 * (edge `importchat-chat`).
 *
 * ── La regla que ordena todo este archivo ──────────────────────────────────
 * **Vacío mientras carga NO es "no hay conversación".** Por eso el estado es
 * explícito y `'cargando'` es distinto de `'ok'` con lista vacía: una pantalla
 * que afirma un cero sobre datos que todavía no llegaron se lee como una buena
 * noticia falsa, y eso ya costó caro en este proyecto.
 *
 * Tampoco se mezcla "esta tienda no usa ImporChat" (`sin_config`, el caso de
 * los otros dueños que usan otras IA) con "algo falló": en el primero la
 * pantalla no dibuja nada y en el segundo dice qué pasó.
 *
 * Nunca lanza. La credencial y el chat_id los resuelve el servidor.
 */
export type EstadoHilo = 'inicial' | 'cargando' | 'ok' | 'sin_config' | 'sin_chat' | 'error';

export interface VentanaHilo { estado: string; restanteMs: number | null }

interface Respuesta {
  ok?: boolean;
  error?: string;
  sin_config?: boolean;
  sin_chat?: boolean;
  mensajes?: MensajeConversacion[];
  ventana?: VentanaHilo;
}

export function useConversacion(externalId: string | null | undefined, activo: boolean) {
  const { activeStoreId } = useStore();
  const [mensajes, setMensajes] = useState<MensajeConversacion[]>([]);
  const [estado, setEstado] = useState<EstadoHilo>('inicial');
  const [error, setError] = useState('');
  const [ventana, setVentana] = useState<VentanaHilo | null>(null);
  // Cada carga lleva su número. Si el usuario cierra y abre otra tarjeta, la
  // respuesta de la anterior llega tarde y NO puede pisar la nueva: sería
  // mostrarle a la asesora la conversación de otro cliente.
  const turnoRef = useRef(0);

  const cargar = useCallback(async () => {
    if (!activeStoreId || !externalId) return;
    const turno = ++turnoRef.current;
    setEstado('cargando');
    setError('');
    try {
      const { data, error: err } = await supabase.functions.invoke('importchat-chat', {
        body: { store_id: activeStoreId, external_id: externalId },
      });
      if (turno !== turnoRef.current) return;

      if (err) {
        // El motivo REAL viaja en el cuerpo (sin configurar, token vencido,
        // sin chat todavía). Sin esto la asesora solo vería "falló".
        let cuerpo: Respuesta | null = null;
        try {
          const ctx = (err as { context?: { json?: () => Promise<Respuesta> } }).context;
          cuerpo = ctx?.json ? await ctx.json() : null;
        } catch { /* el cuerpo no era JSON */ }
        if (turno !== turnoRef.current) return;
        if (cuerpo?.sin_config) { setEstado('sin_config'); return; }
        if (cuerpo?.sin_chat) { setEstado('sin_chat'); setError(cuerpo.error ?? ''); return; }
        setEstado('error');
        setError(cuerpo?.error || err.message || 'No se pudo leer la conversación');
        return;
      }

      const r = (data ?? null) as Respuesta | null;
      if (!r?.ok) {
        if (r?.sin_config) { setEstado('sin_config'); return; }
        if (r?.sin_chat) { setEstado('sin_chat'); setError(r.error ?? ''); return; }
        setEstado('error');
        setError(r?.error || 'No se pudo leer la conversación');
        return;
      }
      setMensajes(r.mensajes ?? []);
      setVentana(r.ventana ?? null);
      setEstado('ok');
    } catch (e) {
      if (turno !== turnoRef.current) return;
      setEstado('error');
      setError(e instanceof Error ? e.message : 'No se pudo leer la conversación');
    }
  }, [activeStoreId, externalId]);

  useEffect(() => {
    if (!activo || !externalId) return;
    void cargar();
  }, [activo, externalId, cargar]);

  return { mensajes, estado, error, ventana, recargar: cargar, setMensajes };
}
