import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/hooks/useTheme';
import { Sun, Moon, Lock, CheckCircle2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

// Pantalla a la que cae el usuario tras hacer click en el link del email
// de "olvidé mi contraseña". supabase-js procesa el token del hash
// automáticamente y abre una sesión "recovery" que solo permite cambiar
// la contraseña. Cuando el cambio termina, se cierra la sesión y se
// redirige a /auth para que entre con la nueva.

export default function ResetPasswordPage() {
  const { updatePassword } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  // null = checking, true = sesión recovery activa, false = no hay token válido.
  const [hasRecoverySession, setHasRecoverySession] = useState<boolean | null>(null);

  useEffect(() => {
    // Detectamos sesión recovery escuchando el evento PASSWORD_RECOVERY,
    // que supabase-js dispara cuando procesa el hash del link del email.
    // También chequeamos getSession() por si el evento ya pasó antes de
    // que montáramos el listener.
    let mounted = true;

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && session)) {
        setHasRecoverySession(true);
      }
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      if (session) {
        setHasRecoverySession(true);
      } else {
        // Si no hay sesión inmediata ni evento, asumimos token inválido
        // tras un breve margen para que onAuthStateChange dispare.
        setTimeout(() => {
          setHasRecoverySession((prev) => (prev === null ? false : prev));
        }, 1500);
      }
    });

    return () => { mounted = false; subscription.unsubscribe(); };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      toast.error('La contraseña debe tener al menos 8 caracteres');
      return;
    }
    if (password !== confirm) {
      toast.error('Las contraseñas no coinciden');
      return;
    }
    setLoading(true);
    const { error } = await updatePassword(password);
    setLoading(false);
    if (error) {
      toast.error(error);
      return;
    }
    setDone(true);
    toast.success('Contraseña actualizada. Inicia sesión con la nueva.');
    // Cerramos la sesión recovery para forzar nuevo login con la password fresca.
    await supabase.auth.signOut();
    setTimeout(() => navigate('/auth', { replace: true }), 1200);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 relative">
      <button
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
        className="absolute top-4 right-4 w-9 h-9 rounded-xl bg-card border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-accent/40 transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>

      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent to-accent/70 flex items-center justify-center text-accent-foreground shadow-ds-md">
            <Lock size={16} />
          </div>
          <span className="text-lg font-bold text-foreground tracking-tight">Nueva contraseña</span>
        </div>

        {hasRecoverySession === null && (
          <p className="text-sm text-muted-foreground">Validando enlace…</p>
        )}

        {hasRecoverySession === false && (
          <div className="rounded-xl border border-red/30 bg-red/5 p-4 text-sm text-foreground space-y-2">
            <p className="font-semibold text-red">Enlace inválido o expirado</p>
            <p className="text-muted-foreground text-xs">
              El link del correo solo dura unas horas y solo se puede usar una vez.
              Pedí uno nuevo desde la pantalla de login.
            </p>
            <button
              type="button"
              onClick={() => navigate('/auth', { replace: true })}
              className="mt-2 w-full py-2.5 rounded-xl bg-card border border-border text-xs font-semibold text-foreground hover:border-accent/40 transition-colors duration-200 cursor-pointer"
            >
              Volver al login
            </button>
          </div>
        )}

        {hasRecoverySession === true && !done && (
          <form onSubmit={handleSubmit} className="space-y-3.5">
            <p className="text-xs text-muted-foreground mb-2">
              Elegí una contraseña de al menos 8 caracteres. Idealmente larga,
              con números y símbolos.
            </p>
            <div>
              <label htmlFor="rp-password" className="block text-xs font-semibold text-foreground mb-1.5">Nueva contraseña</label>
              <input
                id="rp-password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                autoFocus
                className="w-full px-4 py-3 rounded-xl bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 transition-colors duration-200"
              />
            </div>
            <div>
              <label htmlFor="rp-confirm" className="block text-xs font-semibold text-foreground mb-1.5">Repetir contraseña</label>
              <input
                id="rp-confirm"
                type="password"
                placeholder="••••••••"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                className="w-full px-4 py-3 rounded-xl bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 transition-colors duration-200"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-accent to-accent/85 text-accent-foreground font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-glow active:scale-[0.98] transition-all duration-200 mt-1 shadow-ds-md cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {loading ? 'Guardando…' : 'Guardar contraseña'}
            </button>
          </form>
        )}

        {done && (
          <div className="rounded-xl border border-green/30 bg-green/5 p-4 flex items-start gap-3">
            <CheckCircle2 size={18} className="text-green shrink-0 mt-0.5" />
            <div className="text-sm text-foreground">
              <p className="font-semibold text-green">Contraseña actualizada</p>
              <p className="text-muted-foreground text-xs mt-1">Te llevamos al login…</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
