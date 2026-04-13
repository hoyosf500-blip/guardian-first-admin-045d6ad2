import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { useTheme } from '@/hooks/useTheme';
import { Sun, Moon, Check, Package, Phone, BarChart3 } from 'lucide-react';

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
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-primary via-primary/90 to-primary/70 items-center justify-center p-12 relative overflow-hidden">
        {/* Decorative blobs */}
        <div className="absolute top-20 -left-20 w-64 h-64 bg-white/5 rounded-full blur-3xl" />
        <div className="absolute bottom-20 right-10 w-80 h-80 bg-white/5 rounded-full blur-3xl" />
        
        <div className="max-w-md text-primary-foreground relative z-10">
          <div className="w-14 h-14 rounded-2xl bg-white/15 backdrop-blur-sm flex items-center justify-center text-2xl font-bold mb-8 shadow-xl">
            P
          </div>
          <h2 className="text-4xl font-bold mb-4 leading-tight">Panel Operadora<br />COD</h2>
          <p className="text-primary-foreground/70 text-lg leading-relaxed">
            Gestiona pedidos, confirma órdenes y rastrea envíos desde una sola plataforma.
          </p>
          <div className="mt-12 space-y-4">
            {[
              { icon: Phone, text: 'Confirmación inteligente de pedidos' },
              { icon: Package, text: 'Seguimiento y rescate de envíos' },
              { icon: BarChart3, text: 'Dashboard con analíticas en tiempo real' },
            ].map(item => (
              <div key={item.text} className="flex items-center gap-3 text-sm text-primary-foreground/70">
                <span className="w-8 h-8 rounded-xl bg-white/10 flex items-center justify-center">
                  <item.icon size={14} />
                </span>
                {item.text}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex items-center justify-center p-6">
        <button onClick={toggleTheme}
          className="absolute top-4 right-4 w-9 h-9 rounded-xl bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground transition-all">
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        <div className="w-full max-w-sm">
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center text-primary-foreground text-sm font-bold shadow-lg">P</div>
            <span className="text-lg font-bold text-foreground">Panel COD</span>
          </div>

          <h1 className="text-2xl font-bold text-foreground mb-1">
            {mode === 'login' ? 'Bienvenido de nuevo' : 'Crear cuenta'}
          </h1>
          <p className="text-sm text-muted-foreground mb-8">
            {mode === 'login' ? 'Ingresa tus datos para continuar' : 'Regístrate para empezar'}
          </p>

          <form onSubmit={handleSubmit} className="space-y-3.5">
            {mode === 'register' && (
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">Nombre</label>
                <input type="text" placeholder="Tu nombre" value={displayName} onChange={e => setDisplayName(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all" />
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-foreground mb-1.5">Correo electrónico</label>
              <input type="email" placeholder="tu@email.com" value={email} onChange={e => setEmail(e.target.value)} required
                className="w-full px-4 py-3 rounded-xl bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-foreground mb-1.5">Contraseña</label>
              <input type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} required minLength={6}
                className="w-full px-4 py-3 rounded-xl bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all" />
            </div>
            <button type="submit" disabled={loading}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-primary to-primary/80 text-primary-foreground font-semibold text-sm disabled:opacity-50 hover:opacity-90 active:scale-[0.98] transition-all mt-1 shadow-lg shadow-primary/15">
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
