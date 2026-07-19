import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Navigate } from 'react-router-dom';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { useTheme } from '@/hooks/useTheme';
import { supabase } from '@/integrations/supabase/client';
import { AuroraBackdrop, TiltCard } from '@/components/ui3d';
import {
  Package, Phone, BarChart3, ShieldCheck, Store as StoreIcon, Mail, Lock, User,
  ArrowRight, Eye, EyeOff, Info,
} from 'lucide-react';

interface InvitePreview {
  store_name: string | null;
  country_code: string | null;
  role: string | null;
  valid: boolean;
  reason: string;
}

const PENDING_INVITE_KEY = 'guardian.pendingInvite';

/** Entrada escalonada: la pantalla se arma de arriba abajo (misma escala que Dashboard/Logística). */
const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

/**
 * Botón ver/ocultar contraseña (mismo patrón que las credenciales de /admin).
 * Definido a nivel de módulo A PROPÓSITO: si se declara dentro del componente,
 * React lo remonta en cada render y el botón pierde el foco justo después de
 * apretarlo (rompe la navegación por teclado).
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
  // Ver/ocultar contraseña. UNO POR VISTA, no compartido: las vistas son
  // mutuamente excluyentes así que no colisionan, pero con un solo estado la
  // clave revelada en login seguía revelada al pasar a "crear cuenta" — el
  // campo aparecía con la contraseña a la vista. ResetPasswordPage ya usaba dos
  // estados independientes; acá se sigue el mismo patrón.
  const [showPassword, setShowPassword] = useState(false);
  const [showSignupPassword, setShowSignupPassword] = useState(false);

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

  // Tinte por feature (chip de icono) — fórmula del DS: bg/14 · border/30 · text.
  const toneChip: Record<string, string> = {
    accent: 'bg-accent/14 border-accent/30 text-accent glow-accent',
    // `cyan` no tiene utilidad .glow-* en index.css: se reproduce la MISMA
    // fórmula del DS (0 0 18px -6px) con el token, igual que CarrierPicker.
    cyan: 'bg-cyan/14 border-cyan/30 text-cyan shadow-[0_0_18px_-6px_hsl(var(--cyan)/0.4)] dark:shadow-[0_0_18px_-6px_hsl(var(--cyan)/0.9)]',
    info: 'bg-info/14 border-info/30 text-info glow-info',
    success: 'bg-success/14 border-success/30 text-success glow-success',
  };

  const inviteInvalidMsg = invite && !invite.valid
    ? (invite.reason === 'usada' ? 'Este link de invitación ya fue usado.'
      : invite.reason === 'expirada' ? 'Este link de invitación expiró. Pedile uno nuevo al dueño.'
      : invite.reason === 'rpc_error' ? 'No pudimos validar el link de invitación (error de servidor). Pedile uno nuevo al dueño o intentá de nuevo.'
      : invite.reason === 'sin_datos' ? 'No pudimos validar el link de invitación — pedí uno nuevo al dueño.'
      : 'Este link de invitación no es válido.')
    : null;

  // Campo con icono de prefijo: input con pl-11 y el icono absoluto a la
  // izquierda. Solo estilo — no toca value/onChange.
  const fieldCls = 'w-full pl-11 pr-4 py-3 rounded-xl bg-background/60 border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 hover:border-border-strong transition-colors duration-200';
  // Variante para password: deja lugar al botón de ver/ocultar (44px táctiles).
  const fieldPwdCls = `${fieldCls.replace('pr-4', 'pr-12')}`;
  const fieldIconCls = 'absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none';
  const ctaCls = 'btn-accent-3d w-full min-h-11 py-3 rounded-xl font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed mt-1 cursor-pointer inline-flex items-center justify-center gap-2 shadow-glow3d focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background';

  const title = view === 'login' ? 'Bienvenido de nuevo'
    : view === 'forgot' ? 'Recuperar contraseña'
    : 'Crear tu cuenta';
  const subtitle = view === 'login' ? 'Ingresa tus datos para continuar'
    : view === 'forgot' ? 'Ingresa tu correo y te enviamos el link para resetearla'
    : 'Completá tus datos para unirte a la tienda';

  return (
    <div className="flex min-h-screen bg-background">
      {/* Panel izquierdo — identidad de marca sobre la aurora del DS */}
      <div className="hidden lg:flex lg:w-1/2 items-stretch p-12 relative overflow-hidden border-r border-border bg-aurora-strong">
        <AuroraBackdrop />

        <div className="relative z-10 flex flex-col justify-between w-full max-w-md">
          {/* Logo */}
          <motion.div {...fadeUp(0)} className="flex items-center gap-3">
            <span className="w-12 h-12 rounded-2xl bg-accent-gradient flex items-center justify-center text-accent-foreground shadow-glow3d" aria-hidden="true">
              <Package size={24} />
            </span>
            <div>
              <div className="text-xl font-bold text-foreground leading-none tracking-tight">Guardian</div>
              <div className="hud-label text-subtle mt-1.5">PANEL COD</div>
            </div>
          </motion.div>

          {/* Titular + features */}
          <div>
            <motion.h2
              {...fadeUp(0.08)}
              className="text-[30px] font-bold mb-6 leading-[1.15] tracking-tight text-accent-gradient"
            >
              Panel Operadora<br />COD
            </motion.h2>

            <div className="flex flex-col gap-2.5">
              {features.map((item, i) => (
                <motion.div
                  key={item.text}
                  {...fadeUp(0.14 + i * 0.05)}
                  className="flex items-center gap-3 rounded-2xl border border-transparent px-3 py-2 text-[13px] leading-snug text-muted-foreground transition-colors duration-200 hover:border-border hover:bg-card/40 hover:text-foreground"
                >
                  <span
                    className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 border ${toneChip[item.tone]}`}
                    aria-hidden="true"
                  >
                    <item.icon size={17} />
                  </span>
                  <span>{item.text}</span>
                </motion.div>
              ))}
            </div>
          </div>

          <motion.div {...fadeUp(0.34)} className="hud-label-cased text-subtle">Colombia · Ecuador</motion.div>
        </div>
      </div>

      {/* Panel derecho — formulario (card hero de la pantalla) */}
      <div className="flex-1 flex items-center justify-center p-6 relative overflow-hidden">
        <AuroraBackdrop />

        <div className="relative w-full max-w-sm">
          <motion.div {...fadeUp(0)} className="lg:hidden flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-accent-gradient flex items-center justify-center text-accent-foreground shadow-glow3d" aria-hidden="true">
              <Package size={20} />
            </div>
            <span className="text-lg font-bold text-foreground tracking-tight">Guardian</span>
          </motion.div>

          <motion.div {...fadeUp(0.06)}>
            <TiltCard
              sheen
              brackets
              perspective={1200}
              className="bg-card/40 border border-border rounded-3xl p-6 shadow-card3d-lg"
            >
              {/* Banner de invitación válida */}
              {view === 'signup' && invite?.valid && (
                <div className="tilt-layer-1 relative mb-5 flex items-start gap-2.5 rounded-2xl border border-accent/30 bg-accent/10 px-4 pl-5 py-3 shadow-card3d">
                  <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-accent" aria-hidden="true" />
                  <span className="w-9 h-9 rounded-xl bg-accent/20 glow-accent flex items-center justify-center flex-shrink-0 text-accent" aria-hidden="true">
                    <StoreIcon size={17} />
                  </span>
                  <p className="flex-1 min-w-0 text-xs text-foreground leading-relaxed self-center">
                    Te unís a <span className="font-semibold">{invite.store_name}</span>
                    {invite.country_code ? ` (${invite.country_code})` : ''} como{' '}
                    <span className="font-semibold">{invite.role === 'owner' ? 'dueño' : invite.role === 'supervisor' ? 'supervisor' : 'operadora'}</span>.
                  </p>
                </div>
              )}

              {/* Aviso de invitación inválida */}
              {inviteInvalidMsg && view !== 'signup' && (
                <div className="tilt-layer-1 relative mb-5 flex items-start gap-2.5 rounded-2xl border border-danger/30 bg-danger/10 px-4 pl-5 py-3 shadow-card3d">
                  <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-danger" aria-hidden="true" />
                  <span className="w-9 h-9 rounded-xl bg-danger/20 glow-danger flex items-center justify-center flex-shrink-0 text-danger" aria-hidden="true">
                    <Info size={17} />
                  </span>
                  <div className="flex-1 min-w-0 self-center text-xs font-semibold text-danger">
                    {inviteInvalidMsg}
                  </div>
                </div>
              )}

              <div className="tilt-layer-2 mb-6">
                <h1 className="text-2xl font-bold text-foreground tracking-tight mb-1">{title}</h1>
                <p className="text-sm text-muted-foreground">{subtitle}</p>
              </div>

              <div className="tilt-layer-1">
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
                          type={showPassword ? 'text' : 'password'}
                          placeholder="••••••••"
                          value={password}
                          onChange={e => setPassword(e.target.value)}
                          required
                          // En LOGIN la regla la puso la cuenta el día que se creó:
                          // exigir 8 acá dejaría afuera —a nivel navegador, sin
                          // siquiera poder enviar el formulario— a toda cuenta creada
                          // con la regla vieja de 6, que es el mínimo por defecto de
                          // Supabase. Por eso el 8 se aplica donde se ELIGE la clave
                          // (alta y reseteo) y acá se conserva el 6 original: quitarlo
                          // del todo dejaba al login sin ninguna guarda de longitud.
                          // Si se quiere 8 también acá, primero hay que resetear las
                          // claves de 6 — es decisión del dueño.
                          minLength={6}
                          autoComplete="current-password"
                          className={fieldPwdCls}
                        />
                        <PasswordToggle shown={showPassword} onToggle={() => setShowPassword(v => !v)} />
                      </div>
                    </div>
                    <button type="submit" disabled={loading} className={ctaCls}>
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
                          type={showSignupPassword ? 'text' : 'password'}
                          placeholder="Mínimo 8 caracteres"
                          value={password}
                          onChange={e => setPassword(e.target.value)}
                          required
                          minLength={8}
                          autoComplete="new-password"
                          className={fieldPwdCls}
                        />
                        <PasswordToggle shown={showSignupPassword} onToggle={() => setShowSignupPassword(v => !v)} />
                      </div>
                    </div>
                    <button type="submit" disabled={loading} className={ctaCls}>
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
                    <button type="submit" disabled={loading} className={ctaCls}>
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
              </div>
            </TiltCard>
          </motion.div>

          {view === 'login' && !invite?.valid && (
            <motion.p {...fadeUp(0.18)} className="mt-6 text-xs text-muted-foreground text-center">
              Las cuentas se crean desde el panel de administración o por link de invitación.
            </motion.p>
          )}
        </div>
      </div>
    </div>
  );
}
