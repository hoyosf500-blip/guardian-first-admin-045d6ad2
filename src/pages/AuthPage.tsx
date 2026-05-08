import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Navigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useTheme } from '@/hooks/useTheme';
import { Sun, Moon, Package, Phone, BarChart3, ShieldCheck } from 'lucide-react';

export default function AuthPage() {
  // Fix 4: signup público deshabilitado en la UI. Las cuentas se crean
  // desde el panel de admin. Solo el formulario de login + recuperación
  // de contraseña son visibles.
  const { signIn, resetPassword, user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  // Vista 'login' = formulario normal. Vista 'forgot' = pedir email para
  // recuperación. Toggle inline (sin route nueva).
  const [view, setView] = useState<'login' | 'forgot'>('login');

  if (user) return <Navigate to="/dashboard" replace />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await signIn(email, password);
    if (error) toast.error(error);
    setLoading(false);
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

  return (
    <div className="flex min-h-screen bg-background">
      {/* Left panel — brand identity */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-accent via-accent/90 to-accent/70 items-center justify-center p-12 relative overflow-hidden">
        {/* Decorative blobs */}
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

          <h1 className="text-2xl font-extrabold text-foreground tracking-tight mb-1">
            {view === 'login' ? 'Bienvenido de nuevo' : 'Recuperar contraseña'}
          </h1>
          <p className="text-sm text-muted-foreground mb-8">
            {view === 'login'
              ? 'Ingresa tus datos para continuar'
              : 'Ingresa tu correo y te enviamos el link para resetearla'}
          </p>

          {view === 'login' ? (
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
            </form>
          ) : (
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

          <p className="mt-6 text-xs text-muted-foreground text-center">
            Las cuentas se crean desde el panel de administración.
          </p>
        </div>
      </div>
    </div>
  );
}
