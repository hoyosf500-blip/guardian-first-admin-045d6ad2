import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Send, Lock, AlertTriangle, FileText } from 'lucide-react';
import { usePlantillasMeta, useEnviarPlantilla } from '@/hooks/usePlantillasMeta';
import type { ModuloEnvio } from '@/hooks/useEnviarWhatsapp';
import {
  renderizar, faltantes, sugerirValores,
  type PlantillaMeta, type DatosPedido,
} from '@/lib/plantillasMeta';
import { cn } from '@/lib/utils';

/**
 * Mandarle una plantilla aprobada al cliente cuando la ventana de 24 h venció.
 *
 * ── Por qué esto existe ────────────────────────────────────────────────────
 * Hasta hoy, pasadas las 24 h, la pantalla decía "llamalo por teléfono" y se
 * acababa. Pero Meta SÍ deja escribir fuera de la ventana con una plantilla
 * aprobada, y la cuenta tiene 31 sin usar desde Guardian.
 *
 * ── Las tres reglas que le dan forma ───────────────────────────────────────
 * 1. **La vista previa es el mensaje.** Los huecos de una plantilla son
 *    POSICIONALES (`{{1}}`, `{{2}}`): equivocarse no da error, le llega al
 *    cliente "tu pedido está en 7". Por eso se ve el texto final, armado con
 *    la MISMA función que usa el servidor, antes de que salga.
 * 2. **Lo sugerido se puede corregir.** Guardian rellena lo que puede deducir
 *    del pedido y deja vacío lo que no sabe (el plazo en días, por ejemplo,
 *    depende de la transportadora). Nada se manda con un hueco vacío.
 * 3. **Lo que no se puede mandar se dice, no se esconde.** Las plantillas con
 *    video, imagen o botón-con-enlace aparecen bloqueadas y con el motivo: si
 *    desaparecieran, la asesora creería que no existen.
 */
export default function PlantillasWhatsapp({ externalId, fase, datos, modulo, onEnviado }: {
  externalId: string;
  fase?: string | null;
  datos: DatosPedido;
  modulo?: ModuloEnvio;
  onEnviado?: () => void;
}) {
  const { plantillas, estado, error, recargar } = usePlantillasMeta(true, fase);
  const { enviarPlantilla, enviando } = useEnviarPlantilla();
  const [elegida, setElegida] = useState<PlantillaMeta | null>(null);
  const [valores, setValores] = useState<Record<number, string>>({});

  // ⛔ La dependencia es el CONTENIDO de `datos`, no su identidad.
  //
  // Quien llama arma el objeto inline (`datos={{ guia: o.guia, … }}`), así que
  // es uno nuevo en cada render. Depender de la referencia haría que este
  // efecto corriera de nuevo con cada tecla y le PISARA a la asesora lo que
  // acaba de escribir en un campo — el mensaje saldría con el dato sugerido en
  // vez del que ella corrigió. Serializar deja que el efecto corra solo cuando
  // el pedido cambia de verdad, y no obliga a que cada call-site se acuerde de
  // memoizar.
  const claveDatos = JSON.stringify(datos ?? {});
  useEffect(() => {
    if (elegida) setValores(sugerirValores(elegida, JSON.parse(claveDatos) as DatosPedido));
  }, [elegida, claveDatos]);

  const huecos = useMemo(() => (elegida ? faltantes(elegida, valores) : []), [elegida, valores]);
  const previa = useMemo(
    () => (elegida ? renderizar(elegida.cuerpo, valores) : ''),
    [elegida, valores],
  );

  const mandar = async () => {
    if (!elegida) return;
    const r = await enviarPlantilla(externalId, elegida.nombre, valores, modulo);
    if (r.ok) {
      toast.success('Plantilla enviada al cliente');
      setElegida(null);
      onEnviado?.();
    } else {
      toast.error(r.error || 'No se pudo enviar');
    }
  };

  // Una tienda sin ImporChat no ve nada: mejor que no exista a que exista
  // vacío y parezca roto.
  if (estado === 'sin_config') return null;

  return (
    <div className="rounded-xl border border-border bg-card/30 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <FileText size={13} className="text-muted-foreground shrink-0" aria-hidden="true" />
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          Mandarle una plantilla
        </span>
      </div>

      {estado === 'inicial' || estado === 'cargando' ? (
        // ⛔ Acá NO puede decir "no hay plantillas": todavía no se sabe.
        <div className="space-y-2" aria-label="Leyendo las plantillas">
          <div className="flex gap-1.5">
            {[0, 1, 2].map((i) => <div key={i} className="h-6 w-28 rounded-lg bg-muted/40 animate-pulse" />)}
          </div>
          <p className="text-[11px] text-muted-foreground">Buscando las plantillas aprobadas…</p>
        </div>
      ) : estado === 'error' ? (
        <div className="flex items-start gap-2 text-[11px] text-warning">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
          <div className="space-y-1.5">
            <p>{error || 'No se pudieron leer las plantillas.'}</p>
            <button type="button" onClick={recargar} className="underline hover:no-underline font-semibold">
              Probar de nuevo
            </button>
          </div>
        </div>
      ) : plantillas.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          Esta cuenta todavía no tiene plantillas aprobadas por Meta.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {plantillas.map((p) => {
              const activa = elegida?.nombre === p.nombre;
              const bloqueada = !!p.noSoportada;
              return (
                <button
                  key={p.nombre}
                  type="button"
                  disabled={bloqueada}
                  title={p.noSoportada ?? p.cuerpo.slice(0, 160)}
                  onClick={() => setElegida(activa ? null : p)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors',
                    bloqueada
                      ? 'border-border/60 bg-card/20 text-muted-foreground/50 cursor-not-allowed'
                      : activa
                      ? 'border-accent/50 bg-accent/15 text-accent'
                      : 'border-border bg-card/40 text-muted-foreground hover:text-foreground hover:border-border-strong',
                  )}
                >
                  {bloqueada && <Lock size={10} aria-hidden="true" />}
                  {p.nombre.replace(/_/g, ' ')}
                  {p.categoria === 'MARKETING' && !bloqueada && (
                    <span className="text-[9px] font-bold opacity-60" title="Plantilla de promoción: Meta la cobra más caro y la restringe más que una de logística.">PROMO</span>
                  )}
                </button>
              );
            })}
          </div>

          {elegida?.noSoportada && (
            <p className="text-[11px] text-warning">{elegida.noSoportada}</p>
          )}

          {elegida && !elegida.noSoportada && (
            <div className="space-y-2.5 pt-1">
              {elegida.variables.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {elegida.variables.map((v) => (
                    <label key={v.indice} className="block">
                      <span className="block text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-0.5">
                        {v.etiqueta ?? (v.indice === 1 ? 'Nombre' : `Dato ${v.indice}`)}
                      </span>
                      <input
                        value={valores[v.indice] ?? ''}
                        onChange={(e) => setValores((prev) => ({ ...prev, [v.indice]: e.target.value }))}
                        placeholder={v.ejemplo ? `ej. ${v.ejemplo}` : `Dato ${v.indice}`}
                        className={cn(
                          'w-full rounded-lg border bg-card/40 px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring',
                          huecos.includes(v.indice) ? 'border-warning/50' : 'border-border',
                        )}
                      />
                    </label>
                  ))}
                </div>
              )}

              {/* La vista previa ES el mensaje: se arma con la misma función
                  que usa el servidor para hablarle a Meta. */}
              <div className="rounded-xl border border-accent/25 bg-accent/10 px-3 py-2">
                <p className="text-[10px] font-semibold text-accent/90 mb-1">Le va a llegar así:</p>
                <p className="text-xs leading-snug whitespace-pre-wrap break-words text-foreground">{previa}</p>
                {elegida.botones.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5 pt-1.5 border-t border-accent/20">
                    {elegida.botones.map((b) => (
                      <span key={b} className="rounded-md border border-accent/30 px-1.5 py-0.5 text-[10px] text-accent/80">{b}</span>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                {huecos.length > 0 && (
                  <span className="text-[11px] text-warning">
                    {huecos.length === 1 ? 'Falta un dato' : `Faltan ${huecos.length} datos`}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void mandar()}
                  disabled={enviando || huecos.length > 0}
                  className="ml-auto btn-accent-3d inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
                >
                  <Send size={14} aria-hidden="true" />
                  {enviando ? 'Enviando…' : 'Enviar plantilla'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
