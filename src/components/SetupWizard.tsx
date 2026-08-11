import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { panelDropiUrl } from '@/lib/dropiPais';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import {
  Package, Loader2, CheckCircle2, ExternalLink, XCircle,
  AlertTriangle, MinusCircle, RefreshCw, ShieldCheck, ChevronDown, AlertCircle,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import OnboardingStepper from '@/components/onboarding/OnboardingStepper';
import { validarSetup, hayErrores } from '@/lib/onboardingValidacion';
import {
  interpretarChequeos, puedeContinuar, estaCompleto, resumen,
  type ChequeoCrudo, type ChequeoLegible,
  mensajeReintento,
} from '@/lib/verificacionCredenciales';

type ClaveCampo =
  | 'dropi_api_key' | 'dropi_login_email' | 'dropi_login_password'
  | 'dropi_session_token' | 'dropi_store_url' | 'brand_logo_url' | 'name';

interface FieldDef {
  key: ClaveCampo;
  label: string;
  hint?: string;
  required: boolean;
  type?: 'text' | 'password' | 'url' | 'email';
}

/**
 * Campos que un cliente PUEDE dar sin ayuda técnica.
 *
 * Hasta el 6-ago-2026 acá se le pedía el `dropi_session_token` —"DevTools →
 * Network → header x-authorization"— y NO se le pedía email y clave. O sea, se
 * exigía lo que se muere en una hora y se omitía lo que dura para siempre.
 * Un cliente no técnico se trababa en ese campo; y el que lo lograba, al día
 * siguiente tenía la billetera muerta sin saber por qué.
 *
 * Eso pasó de verdad: Colombia quedó configurada sin login y su billetera murió
 * el 28-jul; se descubrió el 6-ago, con los costos congelados diez días.
 */
const FIELDS: FieldDef[] = [
  { key: 'name', label: 'Nombre de la tienda', required: true, hint: 'Ej. "Rushmira (Colombia)" — aparece en el menú lateral.' },
  { key: 'dropi_api_key', label: 'API Key de Dropi', required: true, type: 'password', hint: 'En Dropi → Configuración → API. Es la clave de integraciones, no vence.' },
  { key: 'dropi_login_email', label: 'Correo de tu cuenta Dropi', required: true, type: 'email', hint: 'El mismo con el que entrás a la página de Dropi.' },
  { key: 'dropi_login_password', label: 'Clave de tu cuenta Dropi', required: true, type: 'password', hint: 'Guardian la usa para renovar el acceso solo. Sin esto, tus costos y tu billetera dejan de actualizarse.' },
  { key: 'dropi_store_url', label: 'URL de integración Dropi', required: true, type: 'url', hint: 'La URL del tipo de integración (ej: https://mitienda.com/). No es la dirección pública de tu tienda.' },
  { key: 'brand_logo_url', label: 'URL del logo (opcional)', required: false, type: 'url' },
];

/** Ya NO es obligatorio y vive escondido.
 *
 *  Se conserva porque las tiendas que hoy funcionan lo tienen cargado y no hay
 *  ninguna razón para tocarlo — el dueño lo pidió explícitamente. Pero exigirlo
 *  a un cliente nuevo era pedirle algo que no puede conseguir. */
const CAMPO_AVANZADO: FieldDef = {
  key: 'dropi_session_token',
  label: 'Token de sesión Dropi (opcional)',
  required: false,
  type: 'password',
  hint: 'No hace falta: con tu correo y clave, Guardian lo genera y lo renueva solo. Está acá solo para casos especiales.',
};

const ICONO = {
  ok: { Icon: CheckCircle2, clase: 'text-success' },
  falla: { Icon: XCircle, clase: 'text-danger' },
  aviso: { Icon: AlertTriangle, clase: 'text-warning' },
  omitido: { Icon: MinusCircle, clase: 'text-muted-foreground' },
} as const;

type Fase = 'form' | 'verificando' | 'resultado';

/**
 * Wizard POR-TIENDA. Se muestra al owner cuando la tienda activa no tiene
 * dropi_api_key cargada. Escribe vía RPCs `upsert_store_dropi_config`,
 * `upsert_store_dropi_login` y `update_store_branding` (las tres validan
 * ownership server-side) y DESPUÉS verifica contra Dropi de verdad.
 */
export default function SetupWizard({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const { activeStore, isOwnerOfActive, refresh } = useStore();
  const [vals, setVals] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fase, setFase] = useState<Fase>('form');
  const [chequeos, setChequeos] = useState<ChequeoLegible[]>([]);
  const [errorVerif, setErrorVerif] = useState('');
  const [verAvanzado, setVerAvanzado] = useState(false);
  /** Campos ya visitados + si ya apretó "Guardar": los errores aparecen recién
   *  ahí, no con el formulario en blanco. */
  const [tocados, setTocados] = useState<Record<string, boolean>>({});
  const [intentoEnvio, setIntentoEnvio] = useState(false);
  /** Cuántas veces se probó contra Dropi. Sirve para no repetir el mismo
   *  mensaje al tercer intento fallido y ofrecer la salida correcta. */
  const [intentosVerif, setIntentosVerif] = useState(0);


  /** Token de sesión tal como estaba en la base al abrir. Se reenvía si el
   *  campo quedó vacío: guardar el wizard NUNCA debe borrar un token que hoy
   *  está funcionando. */
  const tokenOriginal = useRef('');

  useEffect(() => {
    if (!activeStore || !isOwnerOfActive) { setLoading(false); return; }
    let cancelled = false;
    void (async () => {
      const { data: cfg } = await supabase
        .from('store_dropi_config')
        .select('dropi_api_key, dropi_session_token, dropi_store_url')
        .eq('store_id', activeStore.id)
        .maybeSingle();
      if (cancelled) return;
      tokenOriginal.current = cfg?.dropi_session_token ?? '';
      setVals({
        name: activeStore.name,
        brand_logo_url: activeStore.brand_logo_url ?? '',
        dropi_api_key: cfg?.dropi_api_key ?? '',
        dropi_session_token: cfg?.dropi_session_token ?? '',
        dropi_store_url: cfg?.dropi_store_url ?? '',
        // El email y la clave NUNCA se leen de vuelta: son secretos y no hay
        // ninguna razón para mandarlos al navegador.
        dropi_login_email: '',
        dropi_login_password: '',
      });
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [activeStore, isOwnerOfActive]);

  if (!activeStore || !isOwnerOfActive) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-card border border-border rounded-2xl p-8 text-center space-y-3">
          <div className="w-12 h-12 rounded-xl bg-warning/10 border border-warning/25 flex items-center justify-center mx-auto">
            <Package size={22} className="text-warning" />
          </div>
          <h1 className="text-lg font-bold text-foreground">Configuración pendiente</h1>
          <p className="text-sm text-muted-foreground">
            El dueño de esta tienda aún no cargó las credenciales de Dropi.
          </p>
        </div>
      </div>
    );
  }

  // Validación de FORMA antes de gastar un viaje a Dropi: una API Key cortada o
  // un correo mal escrito se avisan acá, no después de un "guardado" que falla
  // en silencio.
  const errores = validarSetup(vals);
  const canSubmit = !hayErrores(errores) && !saving;
  const cantidadErrores = Object.keys(errores).length;

  type RpcRes = { error: { message: string } | null };
  const rpc = supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<RpcRes>;

  /** Carga inicial de pedidos y billetera. Se dispara SOLA en cuanto sabemos
   *  que la API Key sirve — el cliente no tiene por qué apretar nada. No se
   *  espera el resultado: son minutos y el realtime va llenando la pantalla. */
  function dispararCargaInicial(storeId: string) {
    const hoy = new Date().toISOString().slice(0, 10);
    const desde = new Date();
    desde.setUTCDate(desde.getUTCDate() - 90);
    const body = { store_id: storeId, from: desde.toISOString().slice(0, 10), untill: hoy };
    void supabase.functions.invoke('dropi-sync', { body }).catch(() => { /* el cron reintenta */ });
    void supabase.functions.invoke('dropi-wallet-sync', { body }).catch(() => { /* idem */ });
  }

  async function verificar(storeId: string) {
    setFase('verificando');
    setErrorVerif('');
    setIntentosVerif(n => n + 1);
    try {
      const { data, error } = await supabase.functions.invoke('dropi-verify-credentials', {
        body: { store_id: storeId },
      });
      if (error) throw error;
      const d = data as { ok?: boolean; chequeos?: ChequeoCrudo[]; error?: string } | null;
      if (!d?.ok) throw new Error(d?.error || 'No se pudo verificar.');
      const legibles = interpretarChequeos(d.chequeos ?? []);
      setChequeos(legibles);
      if (legibles.some(c => c.clave === 'api_key' && c.estado === 'ok')) {
        dispararCargaInicial(storeId);
      }
    } catch (e) {
      // Que la verificación no ande NO puede dejar al cliente encerrado: sus
      // credenciales ya quedaron guardadas. Se lo decimos y lo dejamos pasar.
      setErrorVerif(e instanceof Error ? e.message : String(e));
      setChequeos([]);
    } finally {
      setFase('resultado');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIntentoEnvio(true);
    if (!activeStore || saving) return;
    // Nada viaja a Dropi si la forma de los datos ya está mal.
    if (!canSubmit) {
      toast.error('Revisá los campos marcados en rojo antes de continuar.');
      return;
    }
    setSaving(true);


    const { error: brandErr } = await rpc('update_store_branding', {
      p_store_id: activeStore.id,
      p_name: vals.name ?? '',
      p_brand_logo_url: vals.brand_logo_url ?? '',
    });
    if (brandErr) {
      toast.error('No se pudo guardar el nombre', { description: brandErr.message });
      setSaving(false); return;
    }

    const { error: cfgErr } = await rpc('upsert_store_dropi_config', {
      p_store_id: activeStore.id,
      p_country_code: activeStore.country_code,
      p_dropi_api_key: vals.dropi_api_key ?? '',
      // Nunca vaciar un token que ya estaba: ver `tokenOriginal`.
      p_dropi_session_token: (vals.dropi_session_token || tokenOriginal.current) ?? '',
      p_dropi_store_url: vals.dropi_store_url ?? '',
    });
    if (cfgErr) {
      toast.error('No se pudo guardar las credenciales', { description: cfgErr.message });
      setSaving(false); return;
    }

    const { error: loginErr } = await rpc('upsert_store_dropi_login', {
      p_store_id: activeStore.id,
      p_login_email: vals.dropi_login_email ?? '',
      p_login_password: vals.dropi_login_password ?? '',
    });
    if (loginErr) {
      // No abortamos: lo esencial (API Key) ya quedó. La verificación lo va a
      // mostrar en rojo con su explicación, que es mejor que un toast suelto.
      toast.error('No se pudo guardar el acceso a tu cuenta', { description: loginErr.message });
    }

    setSaving(false);
    await refresh();
    await verificar(activeStore.id);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="animate-spin text-accent" size={28} />
      </div>
    );
  }

  const listo = chequeos.length > 0 && estaCompleto(chequeos);
  const puede = chequeos.length === 0 ? true : puedeContinuar(chequeos);

  return (
    <div className="min-h-screen bg-background overflow-y-auto">
      <div className="max-w-2xl mx-auto p-6 sm:p-10">
        <header className="mb-8 space-y-3">
          <OnboardingStepper actual={fase === 'resultado' && listo ? 3 : 2} />
          <div className="flex items-center gap-3">

            <div className="w-10 h-10 rounded-xl bg-accent flex items-center justify-center">
              <Package size={20} className="text-accent-foreground" />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted-foreground">
                Setup tienda · {activeStore.country_code}
              </div>
              <h1 className="text-2xl font-bold text-foreground tracking-tight">{activeStore.name}</h1>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Cargá los datos de tu cuenta Dropi. Al guardar los probamos de verdad y te decimos
            si quedó todo conectado.
          </p>
        </header>

        {fase !== 'form' ? (
          <ResultadoVerificacion
            fase={fase}
            chequeos={chequeos}
            errorVerif={errorVerif}
            listo={listo}
            puede={puede}
            intentos={intentosVerif}
            onVolver={() => setFase('form')}
            onReintentar={() => void verificar(activeStore.id)}
            onContinuar={onDone}
            onIrAdmin={() => { onDone(); navigate('/admin'); }}
          />
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5 bg-card border border-border rounded-2xl p-6 sm:p-8">
            {FIELDS.map(f => {
              const err = (tocados[f.key] || intentoEnvio) ? errores[f.key] : undefined;
              return (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={f.key} className="text-sm font-semibold">
                    {f.label}
                    {f.required && <span className="text-danger ml-1" aria-hidden>*</span>}
                  </Label>
                  <Input
                    id={f.key}
                    type={f.type ?? 'text'}
                    value={vals[f.key] ?? ''}
                    onChange={(e) => setVals(v => ({ ...v, [f.key]: e.target.value }))}
                    onBlur={() => setTocados(t => ({ ...t, [f.key]: true }))}
                    autoComplete={f.key === 'dropi_login_password' ? 'new-password' : 'off'}
                    spellCheck={false}
                    aria-invalid={Boolean(err)}
                    aria-describedby={err ? `${f.key}-error` : undefined}
                    className={`h-11 ${err ? 'border-danger focus-visible:ring-danger' : ''}`}
                  />
                  {err ? (
                    <p id={`${f.key}-error`} className="flex items-center gap-1 text-xs text-danger">
                      <AlertCircle size={12} aria-hidden /> {err}
                    </p>
                  ) : (
                    f.hint && <p className="text-xs text-muted-foreground">{f.hint}</p>
                  )}
                </div>
              );
            })}

            <div className="pt-1">
              <button
                type="button"
                onClick={() => setVerAvanzado(v => !v)}
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground min-h-11"
                aria-expanded={verAvanzado}
              >
                <ChevronDown size={13} className={verAvanzado ? 'rotate-180 transition-transform' : 'transition-transform'} />
                Opciones avanzadas
              </button>
              {verAvanzado && (
                <div className="space-y-1.5 mt-2">
                  <Label htmlFor={CAMPO_AVANZADO.key} className="text-sm font-semibold">
                    {CAMPO_AVANZADO.label}
                  </Label>
                  <Input
                    id={CAMPO_AVANZADO.key}
                    type="password"
                    value={vals.dropi_session_token ?? ''}
                    onChange={(e) => setVals(v => ({ ...v, dropi_session_token: e.target.value }))}
                    autoComplete="off"
                    spellCheck={false}
                    className="h-11"
                  />
                  <p className="text-xs text-muted-foreground">{CAMPO_AVANZADO.hint}</p>
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-border flex items-center justify-between gap-3">
              <a
                href={panelDropiUrl(activeStore.country_code)}
                target="_blank" rel="noreferrer"
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 min-h-11"
              >
                Ir a Dropi <ExternalLink size={11} />
              </a>
              <button
                type="submit" disabled={saving || (intentoEnvio && !canSubmit)}
                className="inline-flex items-center gap-2 px-4 h-11 rounded-lg bg-accent text-accent-foreground text-sm font-semibold shadow-sm hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {saving ? <Loader2 className="animate-spin" size={15} /> : <ShieldCheck size={15} />}
                Guardar y verificar
              </button>
            </div>
            {cantidadErrores > 0 && (intentoEnvio || Object.keys(tocados).length > 0) && (
              <p className="text-xs text-danger" role="status">
                Revisá {cantidadErrores} {cantidadErrores === 1 ? 'campo' : 'campos'} antes de continuar.
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}

function ResultadoVerificacion({
  fase, chequeos, errorVerif, listo, puede, intentos, onVolver, onReintentar, onContinuar, onIrAdmin,
}: {
  fase: Fase;
  chequeos: ChequeoLegible[];
  errorVerif: string;
  listo: boolean;
  puede: boolean;
  /** Número de prueba contra Dropi (1 = la primera). */
  intentos: number;
  onVolver: () => void;
  onReintentar: () => void;
  onContinuar: () => void;
  /** Paso 3: cierra el asistente y deja al dueño en /admin. */
  onIrAdmin: () => void;
}) {
  if (fase === 'verificando') {
    return (
      <div className="bg-card border border-border rounded-2xl p-8 text-center space-y-3" role="status" aria-live="polite">
        <Loader2 className="animate-spin text-accent mx-auto" size={26} />
        <p className="text-sm font-semibold text-foreground">Probando la conexión con Dropi…</p>
        <p className="text-xs text-muted-foreground">Puede tardar unos segundos.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <div className="bg-card border border-border rounded-2xl p-6 sm:p-8 space-y-5">
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
            listo ? 'bg-success/10 border border-success/25' : 'bg-warning/10 border border-warning/25'
          }`}>
            {listo
              ? <CheckCircle2 size={20} className="text-success" />
              : <AlertTriangle size={20} className="text-warning" />}
          </div>
          <div>
            <h2 className="text-lg font-bold text-foreground">
              {listo ? 'Todo conectado' : 'Falta algo'}
            </h2>
            <p className="text-sm text-muted-foreground">
              {chequeos.length > 0 ? resumen(chequeos) : 'No pudimos completar la prueba.'}
            </p>
          </div>
        </div>

        {(errorVerif || !listo) && (
          <div className={`text-xs rounded-lg p-3 border ${
            errorVerif || !puede
              ? 'text-danger bg-danger/5 border-danger/25'
              : 'text-foreground/80 bg-warning/5 border-warning/25'
          }`} role="alert">
            {errorVerif && (
              <p className="mb-1">Tus datos quedaron guardados, pero la prueba no se pudo correr: {errorVerif}</p>
            )}
            <p>{mensajeReintento(intentos, errorVerif, chequeos)}</p>
            <p className="mt-1 opacity-70">
              Intento {intentos} {intentos === 1 ? 'de verificación' : 'de verificación (ninguno salió en verde)'}
            </p>
          </div>
        )}

        <ul className="space-y-3">
          {chequeos.map((c) => {
            const { Icon, clase } = ICONO[c.estado];
            return (
              <li key={c.clave} className="flex items-start gap-3">
                <Icon size={17} className={`${clase} shrink-0 mt-0.5`} aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    {c.titulo}
                    <span className="sr-only">
                      {c.estado === 'ok' ? ': correcto' : c.estado === 'falla' ? ': con error' : ': con advertencia'}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">{c.detalle}</p>
                  {c.comoArreglar && (
                    <p className="text-xs text-foreground/80 mt-1">{c.comoArreglar}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {listo && (
          <div className="border-t border-border pt-4 space-y-2">
            <p className="text-xs text-muted-foreground">
              Ya empezamos a traer tus pedidos y tu billetera. Se van a ir llenando solos en los
              próximos minutos.
            </p>
            <p className="text-xs text-foreground/80">
              <strong>Paso 3:</strong> entrá a <strong>Configuración</strong> para invitar a tu
              equipo y ajustar horarios. Tus datos son privados de tu tienda.
            </p>
          </div>
        )}
      </div>

      {/* Mientras no esté todo en verde, la acción PRINCIPAL es reintentar.
          Entrar al CRM sigue existiendo solo cuando no hay una falla que lo
          deje vacío (`puede`), pero como botón chico y con el aviso arriba:
          bloquearlo del todo dejaría encerrada a una cuenta con verificación
          en dos pasos, que nunca puede llegar al verde completo. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button" onClick={onVolver}
          className="px-4 h-11 rounded-lg border border-border text-sm font-semibold text-foreground hover:bg-muted/50 transition cursor-pointer"
        >
          Corregir datos
        </button>
        <div className="flex flex-wrap items-center gap-2">
          {!listo && (
            <button
              type="button" onClick={onReintentar}
              className="inline-flex items-center gap-2 px-4 h-11 rounded-lg bg-accent text-accent-foreground text-sm font-semibold hover:opacity-90 transition cursor-pointer"
            >
              <RefreshCw size={15} />
              Volver a probar
            </button>
          )}
          {listo ? (
            <>
              <button
                type="button" onClick={onContinuar}
                className="px-4 h-11 rounded-lg border border-border text-sm font-semibold text-foreground hover:bg-muted/50 transition cursor-pointer"
              >
                Ir a pedidos
              </button>
              <button
                type="button" onClick={onIrAdmin}
                className="px-4 h-11 rounded-lg bg-accent text-accent-foreground text-sm font-semibold hover:opacity-90 transition cursor-pointer"
              >
                Ir a Configuración
              </button>
            </>
          ) : (
            puede && (
              <button
                type="button" onClick={onIrAdmin}
                className="px-4 h-11 rounded-lg border border-border text-xs font-semibold text-muted-foreground hover:bg-muted/50 transition cursor-pointer"
              >
                Entrar con avisos pendientes
              </button>
            )
          )}
        </div>
      </div>

    </div>
  );
}
