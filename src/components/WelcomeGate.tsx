import { ReactNode, useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Clock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { AuroraBackdrop } from '@/components/ui3d';
import { greetingFor } from '@/lib/greeting';
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

export default function WelcomeGate({ children }: Props) {
  const { user, profile, isAdmin } = useAuth();
  const [visible, setVisible] = useState(false);
  // Hora congelada al ABRIR, no `new Date()` en cada render: la bienvenida vive
  // 2.8s y re-renderiza varias veces; leer el reloj cada vez haría saltar el
  // minuto en pantalla justo cuando la asesora lo está leyendo.
  const [horaEntrada, setHoraEntrada] = useState('');

  useEffect(() => {
    if (!user) return;
    if (yaSaludadoHoy(user.id)) return;
    marcarSaludado(user.id);
    setHoraEntrada(formatTimeBogota(new Date().toISOString()));
    setVisible(true);
  }, [user]);

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
                  jornada, así que anunciarle un turno sería mentirle. */}
              {!isAdmin && (
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
