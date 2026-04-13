import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { useTheme } from '@/hooks/useTheme';

export default function AuthPage() {
  const { signIn, signUp } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    if (mode === 'login') {
      const { error } = await signIn(email, password);
      if (error) toast.error(error);
    } else {
      if (!displayName.trim()) { toast.error('Ingresa tu nombre'); setLoading(false); return; }
      const { error } = await signUp(email, password, displayName);
      if (error) toast.error(error);
      else toast.success('Cuenta creada. Revisa tu correo para confirmar.');
    }
    setLoading(false);
  };

  return (
    <div className="flex min-h-screen bg-background">
      {/* Left panel */}
      <div className="hidden lg:flex lg:w-1/2 bg-primary items-center justify-center p-12">
        <div className="max-w-md text-primary-foreground">
          <div className="w-12 h-12 rounded-xl bg-primary-foreground/20 flex items-center justify-center text-xl font-bold mb-8">P</div>
          <h2 className="text-3xl font-bold mb-4">Panel Operadora COD</h2>
          <p className="text-primary-foreground/70 text-lg leading-relaxed">
            Gestiona tus pedidos, confirma órdenes y rastrea envíos desde una sola plataforma.
          </p>
          <div className="mt-12 space-y-4 text-sm text-primary-foreground/60">
            <div className="flex items-center gap-3"><span className="w-5 h-5 rounded bg-primary-foreground/10 flex items-center justify-center text-[10px]">✓</span> Confirmación inteligente de pedidos</div>
            <div className="flex items-center gap-3"><span className="w-5 h-5 rounded bg-primary-foreground/10 flex items-center justify-center text-[10px]">✓</span> Seguimiento y rescate de envíos</div>
            <div className="flex items-center gap-3"><span className="w-5 h-5 rounded bg-primary-foreground/10 flex items-center justify-center text-[10px]">✓</span> Dashboard con analíticas en tiempo real</div>
          </div>
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex items-center justify-center p-6">
        <button onClick={toggleTheme}
          className="absolute top-4 right-4 w-8 h-8 rounded-lg bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground text-sm">
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>

        <div className="w-full max-w-sm">
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center text-primary-foreground text-sm font-bold">P</div>
            <span className="text-lg font-semibold text-foreground">Panel COD</span>
          </div>

          <h1 className="text-2xl font-bold text-foreground mb-1">
            {mode === 'login' ? 'Bienvenido de nuevo' : 'Crear cuenta'}
          </h1>
          <p className="text-sm text-muted-foreground mb-8">
            {mode === 'login' ? 'Ingresa tus datos para continuar' : 'Regístrate para empezar'}
          </p>

          <form onSubmit={handleSubmit} className="space-y-3">
            {mode === 'register' && (
              <div>
                <label className="block text-xs font-medium text-foreground mb-1.5">Nombre</label>
                <input type="text" placeholder="Tu nombre" value={displayName} onChange={e => setDisplayName(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-lg bg-background border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-foreground mb-1.5">Correo electrónico</label>
              <input type="email" placeholder="tu@email.com" value={email} onChange={e => setEmail(e.target.value)} required
                className="w-full px-3 py-2.5 rounded-lg bg-background border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1.5">Contraseña</label>
              <input type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} required minLength={6}
                className="w-full px-3 py-2.5 rounded-lg bg-background border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
            </div>
            <button type="submit" disabled={loading}
              className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground font-medium text-sm disabled:opacity-50 hover:opacity-90 active:scale-[0.98] transition-all mt-2">
              {loading ? '...' : mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'}
            </button>
          </form>

          <div className="mt-6 text-center">
            <button onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              {mode === 'login' ? '¿No tienes cuenta? Regístrate' : '¿Ya tienes cuenta? Inicia sesión'}
            </button>
          </div>

          {mode === 'register' && (
            <p className="mt-4 text-xs text-muted-foreground text-center">
              El primer usuario registrado será administrador automáticamente
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
