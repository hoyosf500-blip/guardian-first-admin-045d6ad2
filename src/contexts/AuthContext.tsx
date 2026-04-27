import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

interface AuthState {
  user: User | null;
  session: Session | null;
  profile: { display_name: string } | null;
  isAdmin: boolean;
  loading: boolean;
  signUp: (email: string, password: string, displayName: string) => Promise<{ error: string | null }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<{ display_name: string } | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  // Prevents fetchProfile from running twice when onAuthStateChange and
  // getSession fire near-simultaneously (race that caused double DB queries
  // and occasional stale isAdmin on fast connections).
  const profileFetchedFor = useRef<string | null>(null);

  async function fetchProfile(userId: string) {
    if (profileFetchedFor.current === userId) return;
    profileFetchedFor.current = userId;

    const { data: p, error: profileErr } = await supabase.from('profiles').select('display_name').eq('user_id', userId).single();
    if (profileErr) console.error('Error loading profile:', profileErr.message);
    if (p) setProfile(p);

    const { data: roles, error: rolesErr } = await supabase.from('user_roles').select('role').eq('user_id', userId);
    if (rolesErr) console.error('Error loading roles:', rolesErr.message);
    setIsAdmin(roles?.some(r => r.role === 'admin') ?? false);
  }

  useEffect(() => {
    // Set up the auth listener first (Supabase recommended pattern).
    // getSession() is only needed as a fallback for the initial load —
    // onAuthStateChange fires INITIAL_SESSION on mount in supabase-js v2,
    // but we keep getSession as a safety net in case it doesn't.
    let initialDone = false;

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        setTimeout(() => fetchProfile(session.user.id), 0);
      } else {
        setProfile(null);
        setIsAdmin(false);
        profileFetchedFor.current = null;
      }
      initialDone = true;
      setLoading(false);
    });

    // Fallback: if onAuthStateChange hasn't fired after a short delay,
    // use getSession to unblock the loading state.
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (initialDone) return; // onAuthStateChange already handled it
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) fetchProfile(session.user.id);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signUp = async (email: string, password: string, displayName: string) => {
    const { error } = await supabase.auth.signUp({
      email, password,
      options: { data: { display_name: displayName }, emailRedirectTo: window.location.origin }
    });
    return { error: error?.message ?? null };
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, session, profile, isAdmin, loading, signUp, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
