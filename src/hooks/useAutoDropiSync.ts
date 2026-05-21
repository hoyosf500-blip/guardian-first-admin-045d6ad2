import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { AUTO_SYNC_INTERVAL_MS } from '@/lib/constants';
import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { useStore } from '@/contexts/StoreContext';

const SYNC_DAYS_BACK = 14;

export function useAutoDropiSync(
  isAdmin: boolean,
  userId: string | undefined,
  onSyncComplete?: () => void,
) {
  const runningRef = useRef(false);
  const { activeStoreId, isOwnerOfActive } = useStore();
  const onSyncCompleteRef = useRef(onSyncComplete);
  useEffect(() => { onSyncCompleteRef.current = onSyncComplete; }, [onSyncComplete]);

  useEffect(() => {
    if (!isAdmin || !userId) return;
    // Sin tienda activa o no soy owner → no invocar (la edge function exige
    // store_id y rechaza con 403 si no soy dueño).
    if (!activeStoreId || !isOwnerOfActive) return;

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
          body: { from, untill, store_id: activeStoreId },
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
    return pollWhenVisible(runSync, AUTO_SYNC_INTERVAL_MS, { runOnVisible: false });
  }, [isAdmin, userId, activeStoreId, isOwnerOfActive]);
}
