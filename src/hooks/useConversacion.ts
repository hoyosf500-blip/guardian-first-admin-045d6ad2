import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import type { MensajeConversacion } from '@/lib/conversacion';
import { motivoEdge, cuerpoDelError } from '@/lib/errorEdge';

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

/**
 * Lovable NO redespliega edge functions con un push: `importchat-chat` puede
 * seguir sin existir en el servidor aunque el código esté en GitHub. Sin esto,
 * la asesora veía el texto crudo en inglés de supabase-js al abrir una tarjeta.
 */
const FALTA_LEER =
  'La lectura del chat todavía no está activada en el servidor. Abrí ImporChat para ver la conversación y avisá para que la activen.';

/**
 * Caché del hilo, compartido entre montajes.
 *
 * ⛔ Antes NO había ninguno: cada vez que la asesora abría el cuadro de un
 * pedido salía un viaje entero a ImporChat, incluso reabriendo el MISMO chat
 * que acababa de cerrar. Con la cola en la mano eso es abrir y cerrar decenas
 * de veces por turno, y cada apertura empezaba en blanco.
 *
 * El TTL es corto a propósito y **nunca reemplaza a la lectura**: lo cacheado
 * se pinta al instante para que el cuadro abra lleno, y en paralelo se revalida
 * contra ImporChat. Si llegó un mensaje nuevo, aparece un segundo después; lo
 * que se elimina es la pantalla vacía mientras tanto.
 */
const CHAT_TTL_MS = 60_000;
const cacheHilo = new Map<string, { at: number; mensajes: MensajeConversacion[]; ventana: VentanaHilo | null }>();

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
    // Lo último que se leyó de ESTE chat se pinta YA, y la lectura sigue por
    // detrás. `'ok'` y no `'cargando'`: son mensajes reales, no un placeholder.
    const guardado = cacheHilo.get(`${activeStoreId}|${externalId}`);
    if (guardado && Date.now() - guardado.at < CHAT_TTL_MS) {
      setMensajes(guardado.mensajes);
      setVentana(guardado.ventana);
      setEstado('ok');
      setError('');
    } else {
      setEstado('cargando');
      setError('');
    }
    try {
      const { data, error: err } = await supabase.functions.invoke('importchat-chat', {
        body: { store_id: activeStoreId, external_id: externalId },
      });
      if (turno !== turnoRef.current) return;

      if (err) {
        // El motivo REAL viaja en el cuerpo (sin configurar, token vencido,
        // sin chat todavía). Y si la función NO está desplegada, supabase-js
        // devuelve un texto en inglés sin cuerpo ("non-2xx"/"Failed to send"):
        // `motivoEdge` lo traduce a algo accionable, igual que hace el envío.
        const cuerpo = await cuerpoDelError(err);
        if (turno !== turnoRef.current) return;
        if (cuerpo?.sin_config) { setEstado('sin_config'); return; }
        if ((cuerpo as { sin_chat?: boolean } | null)?.sin_chat) {
          setEstado('sin_chat'); setError(cuerpo?.error ?? ''); return;
        }
        const { detalle } = motivoEdge(err, cuerpo, FALTA_LEER, 'No se pudo leer la conversación');
        setEstado('error');
        setError(detalle);
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
      const msgs = r.mensajes ?? [];
      const vent = r.ventana ?? null;
      cacheHilo.set(`${activeStoreId}|${externalId}`, { at: Date.now(), mensajes: msgs, ventana: vent });
      setMensajes(msgs);
      setVentana(vent);
      setEstado('ok');
    } catch (e) {
      if (turno !== turnoRef.current) return;
      const { detalle } = motivoEdge(e, null, FALTA_LEER, 'No se pudo leer la conversación');
      setEstado('error');
      setError(detalle);
    }
  }, [activeStoreId, externalId]);

  useEffect(() => {
    if (!activo || !externalId) return;
    void cargar();
  }, [activo, externalId, cargar]);

  return { mensajes, estado, error, ventana, recargar: cargar, setMensajes };
}
