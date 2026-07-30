import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';

/**
 * Reporta qué versión del CRM tiene cargada esta sesión (sello del build,
 * inyectado por vite.config.ts). Guardian es UNA sola app, pero el navegador de
 * cada usuario puede quedarse con un bundle viejo hasta que recargue — típico
 * en una operadora que deja la pestaña abierta días. El panel /plataforma lo
 * muestra para poder decirle "recargá".
 *
 * Barato a propósito: UN upsert al montar y luego uno cada 6 h (una pestaña
 * abierta toda la jornada se sigue viendo "viva"). Best-effort: si falla, no
 * se reintenta ni se muestra nada — es telemetría, no operación.
 */
const REPORT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function useReportAppVersion() {
  const { user, loading } = useAuth();
  const { activeStoreId } = useStore();
  // Evita re-reportar en cada render por cambio de tienda: solo importa que el
  // par (usuario, versión) quede sellado; el store_id viaja como contexto.
  const lastSentRef = useRef(0);

  useEffect(() => {
    if (loading || !user) return;
    const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

    const send = () => {
      lastSentRef.current = Date.now();
      // El binding directo pierde `this` (ver memoria rpc_supabase_binding_pattern).
      type Rpc = (fn: string, p: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
      const rpc = supabase.rpc.bind(supabase) as unknown as Rpc;
      void rpc('report_app_version', { p_version: version, p_store_id: activeStoreId ?? null })
        .then(({ error }) => {
          // Silencioso a propósito: si la migración no está aplicada todavía
          // (PGRST202) o hay red caída, el CRM no debe mostrarle nada al usuario.
          if (error) console.debug('[app-version] no se pudo reportar:', error.message);
        });
    };

    if (Date.now() - lastSentRef.current > REPORT_INTERVAL_MS) send();
    const id = setInterval(send, REPORT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [user, loading, activeStoreId]);
}
