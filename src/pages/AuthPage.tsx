import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Navigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useTheme } from '@/hooks/useTheme';
import { supabase } from '@/integrations/supabase/client';
import { Sun, Moon, Package, Phone, BarChart3, ShieldCheck, Store as StoreIcon } from 'lucide-react';

interface InvitePreview {
  store_name: string | null;
  country_code: string | null;
  role: string | null;
  valid: boolean;
  reason: string;
}

const PENDING_INVITE_KEY = 'guardian.pendingInvite';

export default function AuthPage() {
  // El registro público SOLO se habilita con un link de invitación válido
  // (?invite=TOKEN). Sin invitación, la página muestra únicamente login +
  // recuperación de contraseña (las cuentas internas se crean desde Admin).
  const { signIn, signUp, resetPassword, user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'login' | 'forgot' | 'signup'>('login');

  // Lee el token del link UNA vez y lo persiste antes del posible redirect a
  // /dashboard (si ya hay sesión). La redención corre en ProtectedLayout.
  const [inviteToken] = useState(() => {
    const t = new URLSearchParams(window.location.search).get('invite');
    if (t) { try { localStorage.setItem(PENDING_INVITE_KEY, t); } catch { /* noop */ } }
    return t;
  });
  const [invite, setInvite] = useState<InvitePreview | null>(null);

  // Preview de la invitación: nombre de tienda + validez (RPC anon).
  useEffect(() => {
    if (!inviteToken) return;
    let cancelled = false;
    void (async () => {
      const { data } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<{ data: InvitePreview[] | InvitePreview | null }>)(
        'get_store_invite', { p_token: inviteToken },
      );
      if (cancelled) return;
      const row = Array.isArray(data) ? data[0] : data;
      if (row) {
        setInvite(row);
        if (row.valid) setView('signup');
      }
    })();
    return () => { cancelled = true; };
  }, [inviteToken]);

  if (user) return <Navigate to="/dashboard" replace />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await signIn(email, password);
    if (error) toast.error(error);
    setLoading(false);
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { toast.error('Ingresá tu nombre'); return; }
    setLoading(true);
    const { error } = await signUp(email.trim(), password, name.trim());
    setLoading(false);
    if (error) { toast.error(error); return; }
    toast.success(
      'Cuenta creada. Si te pedimos confirmar el correo, revisá tu email y luego entrá; si no, ya estás dentro.',
      { duration: 8000 },
    );
    // Si hubo auto-login, el redirect a /dashboard + la redención de la
    // invitación ocurren solos. Si requiere confirmar email, mostramos login.
    setView('login');
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      toast.error('Ingresa tu correo');
      return;
    }
    setLoading(true);
    const { error } = await resetPassword(email.trim());
    setLoading(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success('Te enviamos un correo con el link para resetear la contraseña. Revisa tu bandeja (y spam).');
    setView('login');
  };

  const features = [
    { icon: Phone, text: 'Confirmación inteligente de pedidos' },
    { icon: Package, text: 'Seguimiento y rescate de envíos' },
    { icon: BarChart3, text: 'Dashboard con analíticas en tiempo real' },
    { icon: ShieldCheck, text: 'Sincronización directa con Dropi' },
  ];

  const inviteInvalidMsg = invite && !invite.valid
    ? (invite.reason === 'usada' ? 'Este link de invitación ya fue usado.'
      : invite.reason === 'expirada' ? 'Este link de invitación expiró. Pedile uno nuevo al dueño.'
      : 'Este link de invitación no es válido.')
    : null;

  const title = view === 'login' ? 'Bienvenido de nuevo'
    : view === 'forgot' ? 'Recuperar contraseña'
    : 'Crear tu cuenta';
  const subtitle = view === 'login' ? 'Ingresa tus datos para continuar'
    : view === 'forgot' ? 'Ingresa tu correo y te enviamos el link para resetearla'
    : 'Completá tus datos para unirte a la tienda';

  return (
    <div className="flex min-h-screen bg-background">
      {/* Left panel — brand identity */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-accent via-accent/90 to-accent/70 items-center justify-center p-12 relative overflow-hidden">
        <div className="absolute top-20 -left-20 w-64 h-64 bg-accent-foreground/10 rounded-full blur-3xl" aria-hidden="true" />
        <div className="absolute bottom-20 right-10 w-80 h-80 bg-accent-foreground/10 rounded-full blur-3xl" aria-hidden="true" />
        <div className="absolute inset-0 opacity-[0.04] bg-[radial-gradient(circle_at_1px_1px,currentColor_1px,transparent_0)] [background-size:24px_24px] text-accent-foreground" aria-hidden="true" />

        <div className="max-w-md text-accent-foreground relative z-10">
          <div className="w-14 h-14 rounded-2xl bg-accent-foreground/15 backdrop-blur-sm flex items-center justify-center text-2xl font-extrabold mb-8 shadow-ds-lg ring-1 ring-accent-foreground/20">
            P
          </div>
          <h2 className="text-4xl font-extrabold mb-4 leading-[1.1] tracking-tight">
            Panel Operadora<br />COD
          </h2>
          <p className="text-accent-foreground/80 text-base leading-relaxed">
            Gestiona pedidos, confirma órdenes y rastrea envíos desde una sola plataforma.
          </p>
          <div className="mt-12 space-y-3">
            {features.map(item => (
              <div key={item.text} className="flex items-center gap-3 text-sm text-accent-foreground/85">
                <span className="w-8 h-8 rounded-xl bg-accent-foreground/12 flex items-center justify-center flex-shrink-0">
                  <item.icon size={14} aria-hidden="true" />
                </span>
                <span>{item.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right panel — form */}
      <div className="flex-1 flex items-center justify-center p-6 relative">
        <button
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
          className="absolute top-4 right-4 w-9 h-9 rounded-xl bg-card border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-accent/40 transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        <div className="w-full max-w-sm">
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent to-accent/70 flex items-center justify-center text-accent-foreground text-sm font-extrabold shadow-ds-md">P</div>
            <span className="text-lg font-bold text-foreground tracking-tight">CRM</span>
          </div>

          {/* Banner de invitación válida */}
          {view === 'signup' && invite?.valid && (
            <div className="mb-5 rounded-xl border border-accent/30 bg-accent/10 p-3.5 flex items-start gap-2.5">
              <StoreIcon size={16} className="text-accent mt-0.5 flex-shrink-0" />
              <p className="text-xs text-foreground leading-relaxed">
                Te unís a <span className="font-semibold">{invite.store_name}</span>
                {invite.country_code ? ` (${invite.country_code})` : ''} como{' '}
                <span className="font-semibold">{invite.role === 'owner' ? 'dueño' : 'operadora'}</span>.
              </p>
            </div>
          )}

          {/* Aviso de invitación inválida */}
          {inviteInvalidMsg && view !== 'signup' && (
            <div className="mb-5 rounded-xl border border-destructive/30 bg-destructive/10 p-3.5 text-xs text-destructive">
              {inviteInvalidMsg}
            </div>
          )}

          <h1 className="text-2xl font-extrabold text-foreground tracking-tight mb-1">{title}</h1>
          <p className="text-sm text-muted-foreground mb-8">{subtitle}</p>

          {view === 'login' && (
            <form onSubmit={handleSubmit} className="space-y-3.5">
              <div>
                <label htmlFor="auth-email" className="block text-xs font-semibold text-foreground mb-1.5">Correo electrónico</label>
                <input
                  id="auth-email"
                  type="email"
                  placeholder="tu@email.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  className="w-full px-4 py-3 rounded-xl bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 transition-colors duration-200"
                />
              </div>
              <div>
                <div className="flex items-baseline justify-between mb-1.5">
                  <label htmlFor="auth-password" className="block text-xs font-semibold text-foreground">Contraseña</label>
                  <button
                    type="button"
                    onClick={() => setView('forgot')}
                    className="text-xs font-medium text-accent hover:text-accent/80 transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:underline"
                  >
                    ¿Olvidaste tu contraseña?
                  </button>
                </div>
                <input
                  id="auth-password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={6}
                  autoComplete="current-password"
                  className="w-full px-4 py-3 rounded-xl bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 transition-colors duration-200"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-accent to-accent/85 text-accent-foreground font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-glow active:scale-[0.98] transition-all duration-200 mt-1 shadow-ds-md cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {loading ? 'Procesando…' : 'Iniciar sesión'}
              </button>
              {invite?.valid && (
                <button
                  type="button"
                  onClick={() => setView('signup')}
                  disabled={loading}
                  className="w-full text-xs font-medium text-accent hover:text-accent/80 transition-colors duration-200 cursor-pointer"
                >
                  ← Volver a crear cuenta para {invite.store_name}
                </button>
              )}
            </form>
          )}

          {view === 'signup' && (
            <form onSubmit={handleSignup} className="space-y-3.5">
              <div>
                <label htmlFor="signup-name" className="block text-xs font-semibold text-foreground mb-1.5">Tu nombre</label>
                <input
                  id="signup-name"
                  type="text"
                  placeholder="Nombre y apellido"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  required
                  autoComplete="name"
                  className="w-full px-4 py-3 rounded-xl bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 transition-colors duration-200"
                />
              </div>
              <div>
                <label htmlFor="signup-email" className="block text-xs font-semibold text-foreground mb-1.5">Correo electrónico</label>
                <input
                  id="signup-email"
                  type="email"
                  placeholder="tu@email.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  className="w-full px-4 py-3 rounded-xl bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 transition-colors duration-200"
                />
              </div>
              <div>
                <label htmlFor="signup-password" className="block text-xs font-semibold text-foreground mb-1.5">Contraseña</label>
                <input
                  id="signup-password"
                  type="password"
                  placeholder="Mínimo 6 caracteres"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={6}
                  autoComplete="new-password"
                  className="w-full px-4 py-3 rounded-xl bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 transition-colors duration-200"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-accent to-accent/85 text-accent-foreground font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-glow active:scale-[0.98] transition-all duration-200 mt-1 shadow-ds-md cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {loading ? 'Creando cuenta…' : 'Crear cuenta y unirme'}
              </button>
              <button
                type="button"
                onClick={() => setView('login')}
                disabled={loading}
                className="w-full text-xs font-medium text-muted-foreground hover:text-foreground transition-colors duration-200 cursor-pointer disabled:opacity-50"
              >
                Ya tengo cuenta → iniciar sesión
              </button>
            </form>
          )}

          {view === 'forgot' && (
            <form onSubmit={handleForgot} className="space-y-3.5">
              <div>
                <label htmlFor="forgot-email" className="block text-xs font-semibold text-foreground mb-1.5">Correo electrónico</label>
                <input
                  id="forgot-email"
                  type="email"
                  placeholder="tu@email.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  autoFocus
                  className="w-full px-4 py-3 rounded-xl bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 transition-colors duration-200"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-accent to-accent/85 text-accent-foreground font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-glow active:scale-[0.98] transition-all duration-200 mt-1 shadow-ds-md cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {loading ? 'Enviando…' : 'Enviar link de recuperación'}
              </button>
              <button
                type="button"
                onClick={() => setView('login')}
                disabled={loading}
                className="w-full text-xs font-medium text-muted-foreground hover:text-foreground transition-colors duration-200 cursor-pointer disabled:opacity-50"
              >
                ← Volver al login
              </button>
            </form>
          )}

          {view === 'login' && !invite?.valid && (
            <p className="mt-6 text-xs text-muted-foreground text-center">
              Las cuentas se crean desde el panel de administración o por link de invitación.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
