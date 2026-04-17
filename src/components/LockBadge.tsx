import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Module-level cache of user_id -> display name so we don't hit profiles
 * for every row in a 500-row table. Cache is process-scoped (no TTL) — a
 * full refresh re-fetches.
 */
const nameCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

async function resolveName(userId: string): Promise<string> {
  const cached = nameCache.get(userId);
  if (cached) return cached;
  const pending = inFlight.get(userId);
  if (pending) return pending;
  const promise = (async () => {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('display_name')
        .eq('user_id', userId)
        .maybeSingle();
      const name = data?.display_name?.trim() || 'Operadora';
      nameCache.set(userId, name);
      return name;
    } catch {
      return 'Operadora';
    } finally {
      inFlight.delete(userId);
    }
  })();
  inFlight.set(userId, promise);
  return promise;
}

interface Props {
  lockedBy?: string | null;
  lockedAt?: string | null;
  className?: string;
}

/**
 * Small lock indicator shown on orders being actively worked by another
 * operator. Hidden when the lock belongs to the current user, when there
 * is no lock, or when the lock is older than 15 minutes (server cron will
 * release it but we don't want stale UI).
 */
export default function LockBadge({ lockedBy, lockedAt, className = '' }: Props) {
  const { user } = useAuth();
  const [name, setName] = useState<string | null>(null);

  // Treat locks older than 15 minutes as expired so the badge fades out
  // even before the server-side cron clears the row.
  const isStale = lockedAt
    ? Date.now() - new Date(lockedAt).getTime() > 15 * 60 * 1000
    : true;

  const shouldShow = !!lockedBy && lockedBy !== user?.id && !isStale;

  useEffect(() => {
    if (!shouldShow || !lockedBy) return;
    let cancelled = false;
    void resolveName(lockedBy).then(n => {
      if (!cancelled) setName(n);
    });
    return () => { cancelled = true; };
  }, [lockedBy, shouldShow]);

  if (!shouldShow) return null;

  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md border bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30 flex-shrink-0 ${className}`}
      title={`En atención por ${name || 'otra operadora'}`}
      aria-label={`Pedido en atención por ${name || 'otra operadora'}`}
    >
      <Lock size={9} aria-hidden="true" />
      <span className="hidden sm:inline">{name || 'En atención'}</span>
    </span>
  );
}
