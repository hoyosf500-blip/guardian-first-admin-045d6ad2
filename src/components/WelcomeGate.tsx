import { ReactNode, useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Clock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { supabase } from '@/integrations/supabase/client';
import { AuroraBackdrop } from '@/components/ui3d';
import { greetingFor } from '@/lib/greeting';
import { decidirApertura } from '@/lib/aperturaTurno';
import { formatTimeBogota } from '@/lib/timeFormat';
import { bogotaToday } from '@/lib/utils';

interface Props { children: ReactNode }

/**
 * Pantalla de bienvenida al abrir el turno.
 *
 * REEMPLAZA A `OpeningReportGate` (decisión del dueño, 2026-07-19): "cuando sea
 * apertura quitá el formulario y hacé una animación dándole la bienvenida".
 *
 * ⚠️ LO QUE ESTO DEJA DE RECOGER, dicho para que nadie lo descubra tarde: el
 * formulario viejo alimentaba `submit_opening_report` con pedidos nuevos, guías
 * de ayer y pendientes de ayer. Esas tres columnas de /admin → Reportes diarios
 * (y del CSV) quedan VACÍAS desde hoy. Los datos históricos siguen intactos: no
 * se borró ninguna fila, solo se dejó de escribir. El dueño lo aprobó
 * explícitamente sabiendo el costo.
 *
 * DIFERENCIAS DE COMPORTAMIENTO CON EL GATE VIEJO — las tres son a propósito:
 *
 *  1. NO BLOQUEA. El viejo era `fixed inset-0` sin botón de cerrar, sin Esc y
 *     sin salida salvo enviar el reporte: una auditoría lo marcó como jaula
 *     (por teclado se podía tabular al menú que no se veía ni se podía usar).
 *     Este se va solo, y con Esc, clic o cualquier tecla se va antes.
 *  2. UNA VEZ POR DÍA, no por carga de página. Un F5 no la repite: sería un
 *     peaje. La marca vive en localStorage por usuario y día de Bogotá.
 *  3. LA VE TODO EL MUNDO, incluido el admin. El gate viejo salteaba al admin
 *     porque el reporte era trabajo de operadora; una bienvenida no es trabajo.
 *
 * Si localStorage falla (Safari privado, cuota llena), el catch degrada a "no
 * mostrar": ante la duda, no estorbar.
 *
 * ── POR QUÉ ADEMÁS SE PREGUNTA AL SERVIDOR (2026-07-19) ──
 *
 * Pedido del dueño: "ya hice apertura, pero si cierro el CRM y vuelvo a entrar
 * sin hacer cierre, no me tiene que volver a contar la apertura".
 *
 * En la BASE eso ya estaba bien y se verificó contra la función desplegada: el
 * `ON CONFLICT` de `record_operator_heartbeat` no toca `first_action_at`, así
 * que volver a entrar suma segundos pero NO mueve la hora de llegada.
 *
 * El agujero estaba acá arriba. localStorage es por navegador y por equipo: se
 * borra con la caché, no existe en incógnito y no viaja a otra máquina. En
 * cualquiera de esos casos la bienvenida reaparecía — y como mostraba el reloj
 * local, anunciaba "Turno iniciado · 2:15 p.m." mientras el reporte del dueño
 * seguía diciendo 8:03 a.m. La pantalla se contradecía con la base.
 *
 * Por eso ahora, cuando localStorage no sabe, se le pregunta al servidor: si ya
 * hay marca de hoy y no es de recién, esto es una re-entrada y no se saluda. Y
 * la hora que se muestra sale SIEMPRE de esa marca, nunca del reloj de turno.
 */

const DURACION_MS = 2800;

function claveDeHoy(userId: string): string {
  return `guardian.welcome.${userId}.${bogotaToday()}`;
}

function yaSaludadoHoy(userId: string): boolean {
  try { return localStorage.getItem(claveDeHoy(userId)) === '1'; } catch { return true; }
}

function marcarSaludado(userId: string): void {
  try { localStorage.setItem(claveDeHoy(userId), '1'); } catch { /* sin persistencia, no rompe nada */ }
}

const esperar = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Lee del SERVIDOR la hora de entrada sellada hoy, o null si todavía no hay.
 *
 * Reintenta una vez porque compite con el latido de `useOperatorHeartbeat`:
 * ambos arrancan al montar y el que gane la carrera es indistinto. Si leemos
 * antes de que el latido escriba, un segundo intento lo encuentra.
 *
 * Filtra por `operator_id` explícito en vez de confiar en RLS: si algún día una
 * política deja a un supervisor ver las filas de su equipo, esta consulta
 * seguiría trayendo UNA sola fila — la propia — en lugar de la de otra persona.
 */
async function leerMarcaDeEntrada(userId: string, storeId: string): Promise<string | null> {
  const hoy = bogotaToday();
  for (let intento = 0; intento < 2; intento++) {
    try {
      const { data } = await supabase
        .from('operator_activity_daily')
        .select('first_action_at')
        .eq('operator_id', userId)
        .eq('store_id', storeId)
        .eq('activity_date', hoy)
        .maybeSingle();
      if (data?.first_action_at) return data.first_action_at;
    } catch { /* red caída: se resuelve abajo sin afirmar ninguna hora */ }
    if (intento === 0) await esperar(600);
  }
  return null;
}

export default function WelcomeGate({ children }: Props) {
  const { user, profile, isAdmin, profileLoaded } = useAuth();
  const { activeStoreId } = useStore();
  const [visible, setVisible] = useState(false);
  // Hora SELLADA POR EL SERVIDOR (operator_activity_daily.first_action_at), no
  // el reloj de esta máquina. Antes se mostraba `new Date()`, que coincide con
  // la hora real solo en la primerísima apertura del día en ESE navegador: si
  // la bienvenida reaparecía (caché borrada, otro equipo, incógnito) anunciaba
  // una hora nueva mientras la base conservaba la original — la pantalla
  // contradecía a /admin → Productividad. '' = no se pudo confirmar.
  const [horaEntrada, setHoraEntrada] = useState('');

  useEffect(() => {
    // Esperar a saber QUIÉN es: hasta que cargan los roles, `isAdmin` es false.
    if (!user || !profileLoaded) return;
    if (yaSaludadoHoy(user.id)) return;

    // El dueño no ficha jornada: no hay marca que consultar. Se lo saluda igual
    // pero sin chip de turno — la decisión la toma `decidirApertura`.
    if (isAdmin) {
      marcarSaludado(user.id);
      setVisible(decidirApertura({ esAdmin: true, marcaEntrada: null }).saludar);
      return;
    }
    if (!activeStoreId) return;

    let cancelado = false;
    void (async () => {
      const marca = await leerMarcaDeEntrada(user.id, activeStoreId);
      if (cancelado) return;
      marcarSaludado(user.id);
      // La regla vive en `lib/aperturaTurno.ts`, pura y con tests: acá no se
      // puede verificar porque el único que abre este navegador es el dueño, y
      // el camino de la operadora nunca se ejecuta con su sesión.
      const { saludar, horaSellada } = decidirApertura({ esAdmin: false, marcaEntrada: marca });
      if (!saludar) return;
      setHoraEntrada(horaSellada ? formatTimeBogota(horaSellada) : '');
      setVisible(true);
    })();
    return () => { cancelado = true; };
  }, [user, profileLoaded, isAdmin, activeStoreId]);

  const cerrar = useCallback(() => setVisible(false), []);

  // Auto-cierre + salida por teclado. El listener se monta SOLO mientras la
  // bienvenida está en pantalla: dejarlo vivo capturaría Esc del resto de la app
  // (los diálogos de Radix lo usan para cerrarse).
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(cerrar, DURACION_MS);
    const onKey = () => cerrar();
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, [visible, cerrar]);

  const saludo = greetingFor(profile?.display_name);
  const fecha = new Date().toLocaleDateString('es-CO', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  return (
    <>
      <AnimatePresence>
        {visible && (
          <motion.div
            // role="status" + aria-live: un lector de pantalla lo ANUNCIA sin
            // robarle el foco a lo que la asesora estaba haciendo. No es
            // role="dialog" porque no pide ninguna decisión.
            role="status"
            aria-live="polite"
            onClick={cerrar}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.45, ease: 'easeInOut' } }}
            transition={{ duration: 0.3 }}
            className="fixed inset-0 z-[60] overflow-hidden bg-background flex items-center justify-center cursor-pointer select-none"
          >
            <AuroraBackdrop />

            <div className="relative text-center px-6">
              {/* Aro que se expande y se desvanece: el "pulso" de arranque.
                  aria-hidden — es decoración, el texto ya dice todo. */}
              <motion.div
                aria-hidden="true"
                initial={{ scale: 0.6, opacity: 0.55 }}
                animate={{ scale: 1.9, opacity: 0 }}
                transition={{ duration: 1.6, ease: 'easeOut' }}
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-56 h-56 rounded-full border-2 border-accent/50"
              />
              <motion.div
                aria-hidden="true"
                initial={{ scale: 0.6, opacity: 0.4 }}
                animate={{ scale: 2.4, opacity: 0 }}
                transition={{ duration: 2, ease: 'easeOut', delay: 0.25 }}
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-56 h-56 rounded-full border border-accent2/40"
              />

              <motion.h1
                initial={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={{ duration: 0.7, ease: 'easeOut', delay: 0.15 }}
                className="relative text-4xl sm:text-5xl font-bold tracking-tight text-foreground"
              >
                {saludo}
              </motion.h1>

              <motion.p
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, ease: 'easeOut', delay: 0.45 }}
                className="relative mt-3 text-sm text-muted-foreground first-letter:uppercase"
              >
                {fecha}
              </motion.p>

              {/* MARCA DE ENTRADA VISIBLE. El dueño pidió que abrir el CRM inicie
                  el turno y quede la hora. La hora la sella el servidor (primer
                  latido del día, ver useOperatorHeartbeat); acá se MUESTRA para
                  que la asesora sepa que quedó registrada y a qué hora — si no
                  se ve, la marca existe pero nadie confía en ella.
                  Solo para quien realmente ficha: al admin no se le trackea
                  jornada, así que anunciarle un turno sería mentirle.
                  Y solo si `horaEntrada` tiene valor: eso significa que se LEYÓ
                  del servidor. Sin lectura confirmada no se muestra el chip —
                  un turno anunciado con una hora inventada es peor que no
                  anunciarlo, porque después no cuadra con el reporte. */}
              {!isAdmin && horaEntrada && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.5, ease: 'easeOut', delay: 0.8 }}
                  className="relative mt-5 inline-flex items-center gap-2 rounded-xl border border-success/30 bg-success/12 px-3.5 py-2 glow-success"
                >
                  <Clock size={14} className="text-success" aria-hidden="true" />
                  <span className="text-[13px] font-semibold text-success">
                    Turno iniciado · {horaEntrada}
                  </span>
                </motion.div>
              )}

              {/* Barra de progreso = cuánto falta para que se vaya sola. Sin
                  esto la pantalla se siente colgada durante casi 3 segundos. */}
              <motion.div
                aria-hidden="true"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.7 }}
                className="relative mt-8 mx-auto h-[3px] w-40 rounded-full bg-border overflow-hidden"
              >
                <motion.div
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ duration: DURACION_MS / 1000, ease: 'linear' }}
                  style={{ transformOrigin: 'left' }}
                  className="h-full w-full bg-accent-gradient"
                />
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {children}
    </>
  );
}
