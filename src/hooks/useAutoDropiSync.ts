import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const SYNC_DAYS_BACK = 14;

export function useAutoDropiSync(
  isAdmin: boolean,
  userId: string | undefined,
  onSyncComplete?: () => void,
) {
  const runningRef = useRef(false);
  // Mantener onSyncComplete en un ref evita que el interval se reinicie
  // en cada render del componente padre (el callback cambia de identidad).
  const onSyncCompleteRef = useRef(onSyncComplete);
  useEffect(() => { onSyncCompleteRef.current = onSyncComplete; }, [onSyncComplete]);

  useEffect(() => {
    if (!isAdmin || !userId) return;

    const runSync = async () => {
      if (runningRef.current) return;
      runningRef.current = true;
      try {
        const today = new Date();
        const fromDate = new Date(today);
        fromDate.setDate(fromDate.getDate() - SYNC_DAYS_BACK);
        const from = fromDate.toISOString().split('T')[0];
        const untill = today.toISOString().split('T')[0];

        const { error } = await supabase.functions.invoke('dropi-sync', {
          body: { from, untill },
        });
        if (error) {
          console.warn('[auto-dropi-sync] failed:', error.message);
        } else {
          onSyncCompleteRef.current?.();
        }
      } catch (err) {
        console.warn('[auto-dropi-sync] exception:', err);
      } finally {
        runningRef.current = false;
      }
    };

    runSync();
    const interval = setInterval(runSync, SYNC_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isAdmin, userId]);
}
