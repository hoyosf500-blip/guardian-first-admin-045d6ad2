import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { estado, onCambio, type EstadoFreno } from '@/lib/frenoBase';

/**
 * Le dice a la asesora, con palabras, que la base está lenta.
 *
 * Cuando la base se ahogó el 5-sep-2026 la pantalla no decía nada: un spinner
 * que giraba para siempre y una «huella» que no cargaba. El equipo leyó
 * «Guardian se rompió» y el dueño escribió *«se cayó guardian arreglalo»*. No
 * era Guardian. Un problema que no se nombra se le atribuye a lo que se tiene
 * enfrente.
 *
 * Aparece solo mientras el cortacircuitos (`frenoBase`) está abierto, y se va
 * solo cuando la base vuelve. Vive en la cabecera, al lado del banner de
 * sincronización, porque ése es el lugar donde ya se mira la salud del sistema.
 */
export default function FrenoBaseAviso() {
  const [e, setE] = useState<EstadoFreno>(() => estado());
  const [, setTick] = useState(0);
  useEffect(() => onCambio(setE), []);
  // Reloj para el «desde hace N s»: solo mientras está abierto.
  useEffect(() => {
    if (!e.abierto) return;
    const id = setInterval(() => setTick((t) => t + 1), 5_000);
    return () => clearInterval(id);
  }, [e.abierto]);

  if (!e.abierto || e.desde == null) return null;
  const seg = Math.max(0, Math.round((Date.now() - e.desde) / 1000));
  const hace = seg < 90 ? `${seg} s` : `${Math.round(seg / 60)} min`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-100"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-yellow-400" aria-hidden="true" />
      <div className="min-w-0 leading-relaxed">
        <span className="font-semibold">La base de datos está respondiendo lento</span>
        {' '}(desde hace {hace}{e.motivo ? ` · ${e.motivo}` : ''}).
        {' '}Pausé las actualizaciones automáticas para no empeorarlo; se reanudan solas cuando se recupere.
        {' '}<span className="font-semibold">Lo que hagas se guarda igual</span>, solo tarda más. No es Guardian: es la base.
      </div>
    </div>
  );
}
