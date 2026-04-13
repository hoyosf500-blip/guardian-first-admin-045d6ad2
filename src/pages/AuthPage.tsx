import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

export default function AuthPage() {
  const { signIn, signUp } = useAuth();
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
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm text-center">
        <div className="text-5xl mb-3">👋</div>
        <h1 className="text-2xl font-bold mb-1">Panel Operadora</h1>
        <p className="text-muted-foreground text-sm mb-8">
          {mode === 'login' ? 'Inicia sesión para continuar' : 'Crea tu cuenta'}
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {mode === 'register' && (
            <input
              type="text"
              placeholder="Tu nombre"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              className="w-full px-4 py-3 rounded-lg bg-card border border-border text-foreground placeholder:text-muted-foreground text-sm focus:ring-2 focus:ring-cyan"
            />
          )}
          <input
            type="email"
            placeholder="Correo electrónico"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="w-full px-4 py-3 rounded-lg bg-card border border-border text-foreground placeholder:text-muted-foreground text-sm focus:ring-2 focus:ring-cyan"
          />
          <input
            type="password"
            placeholder="Contraseña"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            minLength={6}
            className="w-full px-4 py-3 rounded-lg bg-card border border-border text-foreground placeholder:text-muted-foreground text-sm focus:ring-2 focus:ring-cyan"
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-lg bg-gradient-to-r from-cyan to-blue font-semibold text-primary-foreground text-sm disabled:opacity-50 active:scale-[0.97] transition-transform"
          >
            {loading ? '...' : mode === 'login' ? 'Entrar' : 'Registrarse'}
          </button>
        </form>

        <button
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          className="mt-4 text-sm text-muted-foreground hover:text-cyan transition-colors"
        >
          {mode === 'login' ? '¿No tienes cuenta? Regístrate' : '¿Ya tienes cuenta? Inicia sesión'}
        </button>

        {mode === 'register' && (
          <p className="mt-3 text-xs text-muted-foreground">
            ⭐ El primer usuario registrado será administrador automáticamente
          </p>
        )}
      </div>
    </div>
  );
}
