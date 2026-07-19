import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Navigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useTheme } from '@/hooks/useTheme';
import { supabase } from '@/integrations/supabase/client';
import { Package, Phone, BarChart3, ShieldCheck, Store as StoreIcon, Mail, Lock, User, ArrowRight } from 'lucide-react';

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
  // Tema único oscuro: el hook ya no togglea, solo garantiza la clase.
  useTheme();
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
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<{ data: InvitePreview[] | InvitePreview | null; error: { message: string } | null }>)(
        'get_store_invite', { p_token: inviteToken },
      );
      if (cancelled) return;
      if (error) {
        console.error('[AuthPage] get_store_invite falló:', error);
        setInvite({ store_name: null, country_code: null, role: null, valid: false, reason: 'rpc_error' });
        return;
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (row) {
        setInvite(row);
        if (row.valid) setView('signup');
      } else {
        console.warn('[AuthPage] get_store_invite no devolvió fila para token', inviteToken);
        setInvite({ store_name: null, country_code: null, role: null, valid: false, reason: 'sin_datos' });
      }
    })();
    return () => { cancelled = true; };
  }, [inviteToken]);

  // Funnel por el index (`/`): IndexRedirect decide el destino según el rol
  // (operadora → /confirmar, manager/admin → /dashboard).
  if (user) return <Navigate to="/" replace />;

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
    { icon: Phone, text: 'Confirmación inteligente de pedidos', tone: 'accent' },
    { icon: Package, text: 'Seguimiento y rescate de envíos', tone: 'cyan' },
    { icon: BarChart3, text: 'Dashboard con analíticas en tiempo real', tone: 'info' },
    { icon: ShieldCheck, text: 'Sincronización directa con Dropi', tone: 'success' },
  ] as const;

  // Tinte por feature (chip de icono) — coherente con los semánticos del DS.
  const toneChip: Record<string, string> = {
    accent: 'bg-accent/16 border-accent/30 text-accent',
    cyan: 'bg-cyan/16 border-cyan/30 text-cyan',
    info: 'bg-info/16 border-info/30 text-info',
    success: 'bg-success/16 border-success/30 text-success',
  };

  const inviteInvalidMsg = invite && !invite.valid
    ? (invite.reason === 'usada' ? 'Este link de invitación ya fue usado.'
      : invite.reason === 'expirada' ? 'Este link de invitación expiró. Pedile uno nuevo al dueño.'
      : invite.reason === 'rpc_error' ? 'No pudimos validar el link de invitación (error de servidor). Pedile uno nuevo al dueño o intentá de nuevo.'
      : invite.reason === 'sin_datos' ? 'No pudimos validar el link de invitación — pedí uno nuevo al dueño.'
      : 'Este link de invitación no es válido.')
    : null;

  // Campo con icono de prefijo (patrón del handoff): input con pl-11 y el
  // icono absoluto a la izquierda. Solo estilo — no toca value/onChange.
  const fieldCls = 'w-full pl-11 pr-4 py-3 rounded-xl bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 transition-colors duration-200';
  const fieldIconCls = 'absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none';

  const title = view === 'login' ? 'Bienvenido de nuevo'
    : view === 'forgot' ? 'Recuperar contraseña'
    : 'Crear tu cuenta';
  const subtitle = view === 'login' ? 'Ingresa tus datos para continuar'
    : view === 'forgot' ? 'Ingresa tu correo y te enviamos el link para resetearla'
    : 'Completá tus datos para unirte a la tienda';

  return (
    <div className="flex min-h-screen bg-background">
      {/* Left panel — brand identity (Dirección 3D: gradiente índigo + aurora) */}
      <div className="hidden lg:flex lg:w-1/2 items-stretch p-12 relative overflow-hidden bg-gradient-to-br from-[#171a3d] to-[#0a0b18]">
        {/* Orbes aurora */}
        <div
          className="absolute -top-28 -left-24 w-96 h-96 rounded-full blur-[50px] bg-[radial-gradient(circle,hsl(var(--accent)/0.5),transparent_65%)]"
          aria-hidden="true"
        />
        <div
          className="absolute -bottom-28 -right-20 w-80 h-80 rounded-full blur-[50px] bg-[radial-gradient(circle,hsl(var(--accent2)/0.4),transparent_65%)]"
          aria-hidden="true"
        />

        <div className="relative z-10 flex flex-col justify-between w-full max-w-md text-white">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <span className="w-12 h-12 rounded-2xl bg-accent-gradient flex items-center justify-center text-accent-foreground shadow-glow">
              <Package size={24} aria-hidden="true" />
            </span>
            <div>
              <div className="text-xl font-bold text-white leading-none tracking-tight">Guardian</div>
              <div className="hud-label !text-white/45 mt-1.5">PANEL COD</div>
            </div>
          </div>

          {/* Titular + features */}
          <div>
            <h2 className="text-[26px] font-bold mb-5 leading-[1.2] tracking-tight text-white">
              Panel Operadora<br />COD
            </h2>
            <div className="flex flex-col gap-3">
              {features.map(item => (
                <div key={item.text} className="flex items-center gap-3 text-[13px] leading-snug text-white/70">
                  <span className={`w-[30px] h-[30px] rounded-[9px] flex items-center justify-center flex-shrink-0 border ${toneChip[item.tone]}`}>
                    <item.icon size={15} aria-hidden="true" />
                  </span>
                  <span>{item.text}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="font-mono text-[10px] text-white/35">Colombia · Ecuador</div>
        </div>
      </div>

      {/* Right panel — form */}
      <div className="flex-1 flex items-center justify-center p-6 relative bg-aurora">
        <div className="w-full max-w-sm">
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl bg-accent-gradient flex items-center justify-center text-accent-foreground shadow-glow">
              <Package size={20} aria-hidden="true" />
            </div>
            <span className="text-lg font-bold text-foreground tracking-tight">Guardian</span>
          </div>

          {/* Banner de invitación válida */}
          {view === 'signup' && invite?.valid && (
            <div className="mb-5 rounded-xl border border-accent/30 bg-accent/10 p-3.5 flex items-start gap-2.5">
              <StoreIcon size={16} className="text-accent mt-0.5 flex-shrink-0" />
              <p className="text-xs text-foreground leading-relaxed">
                Te unís a <span className="font-semibold">{invite.store_name}</span>
                {invite.country_code ? ` (${invite.country_code})` : ''} como{' '}
                <span className="font-semibold">{invite.role === 'owner' ? 'dueño' : invite.role === 'supervisor' ? 'supervisor' : 'operadora'}</span>.
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
                <div className="relative">
                  <Mail size={15} className={fieldIconCls} aria-hidden="true" />
                  <input
                    id="auth-email"
                    type="email"
                    placeholder="tu@email.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    className={fieldCls}
                  />
                </div>
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
                <div className="relative">
                  <Lock size={15} className={fieldIconCls} aria-hidden="true" />
                  <input
                    id="auth-password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                    minLength={6}
                    autoComplete="current-password"
                    className={fieldCls}
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="btn-accent-3d w-full py-3 rounded-xl font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed mt-1 cursor-pointer inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {loading ? 'Procesando…' : <>Iniciar sesión <ArrowRight size={16} aria-hidden="true" /></>}
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
                <div className="relative">
                  <User size={15} className={fieldIconCls} aria-hidden="true" />
                  <input
                    id="signup-name"
                    type="text"
                    placeholder="Nombre y apellido"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    required
                    autoComplete="name"
                    className={fieldCls}
                  />
                </div>
              </div>
              <div>
                <label htmlFor="signup-email" className="block text-xs font-semibold text-foreground mb-1.5">Correo electrónico</label>
                <div className="relative">
                  <Mail size={15} className={fieldIconCls} aria-hidden="true" />
                  <input
                    id="signup-email"
                    type="email"
                    placeholder="tu@email.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    className={fieldCls}
                  />
                </div>
              </div>
              <div>
                <label htmlFor="signup-password" className="block text-xs font-semibold text-foreground mb-1.5">Contraseña</label>
                <div className="relative">
                  <Lock size={15} className={fieldIconCls} aria-hidden="true" />
                  <input
                    id="signup-password"
                    type="password"
                    placeholder="Mínimo 6 caracteres"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                    minLength={6}
                    autoComplete="new-password"
                    className={fieldCls}
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="btn-accent-3d w-full py-3 rounded-xl font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed mt-1 cursor-pointer inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
                <div className="relative">
                  <Mail size={15} className={fieldIconCls} aria-hidden="true" />
                  <input
                    id="forgot-email"
                    type="email"
                    placeholder="tu@email.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    autoFocus
                    className={fieldCls}
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="btn-accent-3d w-full py-3 rounded-xl font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed mt-1 cursor-pointer inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
