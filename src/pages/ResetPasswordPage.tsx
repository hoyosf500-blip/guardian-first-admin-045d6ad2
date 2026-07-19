import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/hooks/useTheme';
import { Lock, CheckCircle2, Eye, EyeOff, Info, ShieldAlert, ArrowRight } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { AuroraBackdrop, TiltCard } from '@/components/ui3d';

// Pantalla a la que cae el usuario tras hacer click en el link del email
// de "olvidé mi contraseña". supabase-js procesa el token del hash
// automáticamente y abre una sesión "recovery" que solo permite cambiar
// la contraseña. Cuando el cambio termina, se cierra la sesión y se
// redirige a /auth para que entre con la nueva.

/** Entrada escalonada: misma escala que Dashboard/Logística. */
const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

/**
 * Botón ver/ocultar contraseña (mismo patrón que las credenciales de /admin).
 * A nivel de módulo A PROPÓSITO: dentro del componente React lo remonta en cada
 * render y el botón pierde el foco justo después de apretarlo.
 */
function PasswordToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  const label = shown ? 'Ocultar contraseña' : 'Mostrar contraseña';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={shown}
      aria-label={label}
      title={label}
      className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-9 w-9 items-center justify-center rounded-xl text-muted-foreground hover:text-foreground transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {shown ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
    </button>
  );
}

export default function ResetPasswordPage() {
  const { updatePassword } = useAuth();
  // Tema único oscuro: el hook ya no togglea, solo garantiza la clase.
  useTheme();
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  // Ver/ocultar cada campo por separado.
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  // null = checking, true = sesión recovery activa, false = no hay token válido.
  const [hasRecoverySession, setHasRecoverySession] = useState<boolean | null>(null);
  // Hash del URL al momento de cargar — útil para diagnóstico cuando falla.
  const [urlDiag] = useState(() => ({
    hash: typeof window !== 'undefined' ? window.location.hash : '',
    search: typeof window !== 'undefined' ? window.location.search : '',
  }));

  useEffect(() => {
    let mounted = true;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    // Si el URL trae hash con type=recovery o code=... (PKCE), supabase-js
    // está procesando el token. NO marcar invalid hasta que termine de procesar.
    const hashHasRecovery = urlDiag.hash.includes('type=recovery') || urlDiag.hash.includes('access_token=');
    const queryHasCode = urlDiag.search.includes('code=');
    const probablyRecovering = hashHasRecovery || queryHasCode;

    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!mounted) return false;
      if (session) {
        setHasRecoverySession(true);
        return true;
      }
      return false;
    };

    // Listener que captura PASSWORD_RECOVERY o SIGNED_IN tras el procesamiento del hash.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && session) || (event === 'INITIAL_SESSION' && session)) {
        setHasRecoverySession(true);
        if (pollTimer) clearInterval(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
      }
    });

    // Check inmediato + poll cada 500ms hasta que aparezca sesión o se acabe el tiempo.
    void checkSession();
    pollTimer = setInterval(() => { void checkSession(); }, 500);

    // Margen total: 6s si el URL trae token (supabase-js se está demorando),
    // 2s si no hay nada (link claramente inválido).
    const totalMs = probablyRecovering ? 6000 : 2000;
    timeoutTimer = setTimeout(() => {
      if (!mounted) return;
      setHasRecoverySession((prev) => (prev === null ? false : prev));
      if (pollTimer) clearInterval(pollTimer);
    }, totalMs);

    return () => {
      mounted = false;
      subscription.unsubscribe();
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    };
  }, [urlDiag.hash, urlDiag.search]);

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

  const fieldCls = 'w-full pl-11 pr-12 py-3 rounded-xl bg-background/60 border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 hover:border-border-strong transition-colors duration-200';
  const fieldIconCls = 'absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none';

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 relative overflow-hidden">
      <AuroraBackdrop />

      <div className="relative w-full max-w-sm">
        <motion.div {...fadeUp(0)} className="flex items-center gap-3 mb-6">
          <div className="w-11 h-11 rounded-2xl bg-accent-gradient flex items-center justify-center text-accent-foreground shadow-glow3d" aria-hidden="true">
            <Lock size={20} />
          </div>
          <span className="text-lg font-bold text-foreground tracking-tight leading-none">Nueva contraseña</span>
        </motion.div>

        <motion.div {...fadeUp(0.06)}>
          <TiltCard
            sheen
            brackets
            perspective={1200}
            className="bg-card/40 border border-border rounded-3xl p-6 shadow-card3d-lg"
          >
            {hasRecoverySession === null && (
              <div className="tilt-layer-1 flex items-center gap-3">
                <span className="w-9 h-9 rounded-xl border border-border bg-muted/60 flex items-center justify-center text-muted-foreground" aria-hidden="true">
                  <Info size={17} />
                </span>
                <p className="text-sm text-muted-foreground">Validando enlace…</p>
              </div>
            )}

            {hasRecoverySession === false && (
              <div className="tilt-layer-1 space-y-3">
                <div className="relative flex items-start gap-2.5 rounded-2xl border border-danger/30 bg-danger/10 px-4 pl-5 py-3 shadow-card3d">
                  <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-danger" aria-hidden="true" />
                  <span className="w-9 h-9 rounded-xl bg-danger/20 glow-danger flex items-center justify-center flex-shrink-0 text-danger" aria-hidden="true">
                    <ShieldAlert size={17} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-danger">Enlace inválido o expirado</p>
                    <p className="text-muted-foreground text-[11px] mt-1 leading-relaxed">
                      El link del correo solo dura unas horas y solo se puede usar una vez.
                    </p>
                  </div>
                </div>

                {!urlDiag.hash && !urlDiag.search ? (
                  <div className="rounded-2xl bg-background/50 border border-border p-3.5 text-[11px] text-muted-foreground leading-relaxed">
                    <p className="hud-label text-foreground mb-1.5">Probable causa</p>
                    <p>
                      Este URL no trae el token. Posibles motivos: (1) el link del email
                      ya fue usado antes, (2) abriste <code className="font-mono text-foreground">/reset-password</code> manualmente
                      sin venir del email, o (3) Supabase rechazó el redirect porque la
                      URL <code className="font-mono text-foreground">{typeof window !== 'undefined' ? window.location.origin : ''}/reset-password</code> no
                      está whitelisteada en <strong className="text-foreground">Supabase → Authentication → URL Configuration</strong>.
                    </p>
                  </div>
                ) : (
                  <div className="rounded-2xl bg-background/50 border border-border p-3.5 text-[11px] text-muted-foreground leading-relaxed">
                    <p className="hud-label text-foreground mb-1.5">Diagnóstico</p>
                    <p>El URL trae token pero Supabase no lo aceptó. Probablemente expiró (los links duran ~1h) o ya fue usado.</p>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => navigate('/auth', { replace: true })}
                  className="w-full min-h-11 py-2.5 rounded-xl bg-card/40 border border-border text-xs font-semibold text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Pedir un link nuevo <ArrowRight size={13} aria-hidden="true" />
                </button>
              </div>
            )}

            {hasRecoverySession === true && !done && (
              <form onSubmit={handleSubmit} className="tilt-layer-1 space-y-3.5">
                <p className="text-xs text-muted-foreground mb-2 leading-relaxed">
                  Elegí una contraseña de al menos 8 caracteres. Idealmente larga,
                  con números y símbolos.
                </p>
                <div>
                  <label htmlFor="rp-password" className="block text-xs font-semibold text-foreground mb-1.5">Nueva contraseña</label>
                  <div className="relative">
                    <Lock size={15} className={fieldIconCls} aria-hidden="true" />
                    <input
                      id="rp-password"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="••••••••"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      required
                      minLength={8}
                      autoComplete="new-password"
                      autoFocus
                      className={fieldCls}
                    />
                    <PasswordToggle shown={showPassword} onToggle={() => setShowPassword(v => !v)} />
                  </div>
                </div>
                <div>
                  <label htmlFor="rp-confirm" className="block text-xs font-semibold text-foreground mb-1.5">Repetir contraseña</label>
                  <div className="relative">
                    <Lock size={15} className={fieldIconCls} aria-hidden="true" />
                    <input
                      id="rp-confirm"
                      type={showConfirm ? 'text' : 'password'}
                      placeholder="••••••••"
                      value={confirm}
                      onChange={e => setConfirm(e.target.value)}
                      required
                      minLength={8}
                      autoComplete="new-password"
                      className={fieldCls}
                    />
                    <PasswordToggle shown={showConfirm} onToggle={() => setShowConfirm(v => !v)} />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="btn-accent-3d w-full min-h-11 py-3 rounded-xl font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed mt-1 cursor-pointer inline-flex items-center justify-center gap-2 shadow-glow3d focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  {loading ? 'Guardando…' : 'Guardar contraseña'}
                </button>
              </form>
            )}

            {done && (
              <div className="tilt-layer-1 relative flex items-start gap-3 rounded-2xl border border-success/30 bg-success/10 px-4 pl-5 py-3 shadow-card3d">
                <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-success" aria-hidden="true" />
                <span className="w-9 h-9 rounded-xl bg-success/20 glow-success flex items-center justify-center flex-shrink-0 text-success" aria-hidden="true">
                  <CheckCircle2 size={17} />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-success">Contraseña actualizada</p>
                  <p className="text-muted-foreground text-[11px] mt-1">Te llevamos al login…</p>
                </div>
              </div>
            )}
          </TiltCard>
        </motion.div>
      </div>
    </div>
  );
}
