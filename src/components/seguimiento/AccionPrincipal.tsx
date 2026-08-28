import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Send, Loader2, MessageCircle } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useEnviarWhatsapp, type ModuloEnvio } from '@/hooks/useEnviarWhatsapp';
import { usePlantillasMeta, useEnviarPlantilla } from '@/hooks/usePlantillasMeta';
import { accionPrincipal, plantillaParaAccion } from '@/lib/accionSeguimiento';
import { plantillasPara } from '@/lib/plantillasChat';
import { renderizar, faltantes, sugerirValores, type DatosPedido } from '@/lib/plantillasMeta';
import { conRastreo } from '@/lib/datosPlantilla';
import { ventanaWhatsapp } from '@/lib/ventanaWhatsapp';
import { useConversacion } from '@/hooks/useConversacion';
import { classifySegEstado } from '@/lib/segStatus';
import type { ActividadChatOrden } from '@/lib/actividadChat';
import { cn } from '@/lib/utils';

/**
 * El botón que HACE la gestión, en vez de declararla.
 *
 * ── El problema que resuelve (27-ago-2026) ──────────────────────────────────
 * "Avisé: en oficina" no avisaba a nadie. Escribía un touchpoint y listo: el
 * cliente seguía sin enterarse de que su paquete lo esperaba en la agencia, y
 * nadie —ni la asesora, ni el dueño— podía comprobar si el aviso salió. Una
 * declaración que nadie puede verificar es un dato que no sirve para decidir.
 *
 * Acá el botón dice **lo que le va a llegar al cliente** ("Avisarle que llegó a
 * la agencia") y al confirmarlo el WhatsApp sale de verdad. La gestión queda
 * registrada como efecto del envío, no como una promesa.
 *
 * ── Las tres reglas ─────────────────────────────────────────────────────────
 * 1. **Elige el canal solo.** Si el cliente escribió hace menos de 24 h va un
 *    mensaje normal (gratis, natural); si venció, va una plantilla aprobada.
 *    La asesora no tiene por qué saber qué es la ventana de 24 h de Meta.
 * 2. **Nunca manda a ciegas.** Un clic ABRE la vista previa con el texto exacto;
 *    el segundo confirma. Sale a un cliente real y no se puede deshacer — los
 *    dos clics son el precio de eso, y son menos que los de hoy.
 * 3. **Se apaga en vez de fallar.** Sin plantilla que sirva, con un hueco que
 *    Guardian no sabe llenar, o sin ImporChat en esa tienda, este botón
 *    devuelve null y la tarjeta muestra la botonera declarativa de siempre. La
 *    asesora NUNCA se queda sin dónde registrar.
 */
export default function AccionPrincipal({ externalId, phone, estado, nombre, datos, actividad, modulo, onEnviado, fallback = null, className }: {
  externalId: string;
  /** Necesario para que el contador baje al instante: es la clave con la que
   *  Seguimiento cruza las gestiones (touchpoints no guarda order_id). */
  phone?: string | null;
  estado?: string | null;
  nombre?: string | null;
  datos?: DatosPedido;
  actividad?: ActividadChatOrden | null;
  modulo?: ModuloEnvio;
  onEnviado?: (gestion: string) => void;
  /** Qué dibujar cuando este botón no puede ofrecer nada (fase sin acción, la
   *  tienda no tiene ImporChat, ninguna plantilla sirve, falta un dato). La
   *  decisión vive ACÁ y no en cada tarjeta: quien llama no puede saber de
   *  antemano si vamos a poder mandar, y sin esto la asesora se quedaría sin
   *  ningún botón. */
  fallback?: ReactNode;
  className?: string;
}) {
  const [abierto, setAbierto] = useState(false);
  const accion = accionPrincipal(estado);
  const fase = useMemo(() => classifySegEstado(estado || ''), [estado]);

  // La ventana decide TODO lo de abajo. Se calcula PRIMERO con lo sincronizado
  // (lo que ya tiene la tarjeta): abrir el hilo por cada una de las 83 tarjetas
  // del tablero no vale la pena. Cuando ese dato dice que NO se puede escribir,
  // se relee — ver el bloque de abajo. Y el servidor revalida igual antes de
  // mandar nada.
  const vSync = useMemo(
    () => ventanaWhatsapp(actividad?.entranteAt ?? null, !!actividad),
    [actividad],
  );

  // ⛔ "VENCIDA" NO SE AFIRMA CON DATO VIEJO (28-ago-2026).
  //
  // Reportado por el dueño: *"el chat está abierto y no han pasado las 24, pero
  // en el CRM sale que sí"*. La tarjeta calcula la ventana con `chat_entrante_at`,
  // que lo escribe el sync de ImporChat y por lo tanto **va atrasado**: si el
  // cliente escribió después de la última corrida, acá seguía figurando el
  // mensaje viejo y Guardian daba por cerrada una ventana que está abierta.
  //
  // La asimetría es la clave y por eso solo se relee en un sentido:
  //  · "abierta" con dato viejo NUNCA es un falso positivo — que el cliente
  //    haya escrito no se borra, y si escribió DESPUÉS la ventana está aún más
  //    abierta. No hace falta preguntar.
  //  · "vencida" / "nunca escribió" SÍ pueden ser mentira del atraso. Ahí se
  //    relee el hilo (que devuelve la ventana fresca del servidor) antes de
  //    decidir. Cuesta una lectura —cacheada 60 s, la misma que usa el cuadro
  //    grande— y a cambio la asesora escribe gratis en vez de gastar una
  //    plantilla, o directamente deja de creer que no puede escribir.
  const dudoso = vSync.estado === 'vencida' || vSync.estado === 'nunca_escribio';
  const hilo = useConversacion(externalId, abierto && dudoso);
  const vFresca = hilo.estado === 'ok' && hilo.ventana
    ? { estado: hilo.ventana.estado as typeof vSync.estado, restanteMs: hilo.ventana.restanteMs }
    : null;
  const v = vFresca ?? vSync;
  // Mientras la relectura está en curso no se decide nada: es exactamente el
  // momento en que el dato viejo mentiría.
  const revalidando = abierto && dudoso && !vFresca
    && (hilo.estado === 'inicial' || hilo.estado === 'cargando');
  const conPlantilla = v.estado === 'vencida' || v.estado === 'nunca_escribio';

  // Solo se piden al ABRIR: son 40 plantillas por llamada y en el tablero hay
  // decenas de tarjetas a la vez.
  const { plantillas, estado: estadoPl } = usePlantillasMeta(abierto && conPlantilla, fase);
  const { enviar, enviando: enviandoTexto } = useEnviarWhatsapp();
  const { enviarPlantilla, enviando: enviandoPl } = useEnviarPlantilla();
  const enviando = enviandoTexto || enviandoPl;

  // ⛔ La dependencia es el CONTENIDO de `datos`, no su identidad — misma
  // trampa que ya documenta `PlantillasWhatsapp`. Quien llama arma el objeto
  // inline (`datos={{ guia: o.guia, … }}`), así que es uno nuevo en cada
  // render: depender de la referencia haría que la cadena de abajo (elegir
  // plantilla → sugerir valores → calcular huecos, con sus regex sobre 42
  // plantillas) se recalcule en cada render de cada una de las ~200 tarjetas
  // del tablero.
  const claveDatos = JSON.stringify(datos ?? {});
  const datosPedido = useMemo<DatosPedido>(
    // `conRastreo` arma el link de rastreo si la transportadora lo permite. Sin
    // él, la plantilla que dice "seguí tu envío aquí 👉 {{3}}" recibía el NÚMERO
    // de guía y le llegaba rota al cliente (ver `datosPlantilla.ts`).
    () => conRastreo({ ...(JSON.parse(claveDatos) as DatosPedido), nombre: datos?.nombre ?? nombre ?? null }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [claveDatos, nombre],
  );

  // Se elige la que Guardian puede COMPLETAR con los datos del pedido, no la
  // que suena mejor: la más específica de agencia pide un "plazo en días" que
  // tenemos prohibido inventar, y el botón quedaba inservible. Ver
  // `plantillaParaAccion`.
  const plantilla = useMemo(
    () => (conPlantilla
      ? plantillaParaAccion(plantillas, estado, (p) => faltantes(p, sugerirValores(p, datosPedido)).length === 0)
      : null),
    [conPlantilla, plantillas, estado, datosPedido],
  );
  const valores = useMemo(
    () => (plantilla ? sugerirValores(plantilla, datosPedido) : {}),
    [plantilla, datosPedido],
  );
  const huecos = useMemo(() => (plantilla ? faltantes(plantilla, valores) : []), [plantilla, valores]);

  const textoLibre = useMemo(
    () => plantillasPara(estado, nombre)[0]?.texto ?? '',
    [estado, nombre],
  );

  // ⛔ Un clic no se pierde en silencio (visto en pantalla el 27-ago-2026).
  //
  // Si al abrir falla la lectura de plantillas —ImporChat caído, la llave de 7
  // días vencida— el botón se convertía en el declarativo y el popover no
  // aparecía: la asesora tocaba, no pasaba nada visible, y el botón le cambiaba
  // de nombre solo. Ese es exactamente el tipo de silencio que este trabajo
  // vino a sacar. Ahora se dice qué pasó y qué le queda por hacer.
  useEffect(() => {
    if (!abierto || !conPlantilla || revalidando) return;
    const falla =
      estadoPl === 'sin_config' ? 'Esta tienda no tiene WhatsApp conectado. Registrá la gestión y escribile por fuera.'
      : estadoPl === 'error' ? 'No se pudieron leer las plantillas aprobadas. Probá abriendo el chat, o llamalo.'
      // Cargó bien pero ninguna se puede mandar entera con los datos del
      // pedido. Es un caso REAL y frecuente —las plantillas que piden el plazo
      // en días nunca se completan solas— y hasta el 27-ago-2026 hacía que el
      // panel se evaporara sin una palabra.
      : estadoPl === 'ok' && !plantilla ? 'Ninguna plantilla se puede completar con los datos de este pedido. Abrí el chat y escribile el dato que falta.'
      : null;
    if (!falla) return;
    setAbierto(false);
    toast.error('No se pudo preparar el mensaje', { description: falla });
  }, [abierto, conPlantilla, estadoPl, plantilla, revalidando]);

  // La previa ES el mensaje: se arma con la misma función que usa el servidor
  // para hablarle a Meta, así lo que se lee acá es lo que le llega al cliente.
  const previa = conPlantilla
    ? (plantilla ? renderizar(plantilla.cuerpo, valores) : '')
    : textoLibre;

  // Cuando no hay nada que ofrecer se devuelve el fallback: la asesora nunca
  // se queda sin un botón para registrar.
  //
  // `sin_dato` (no sabemos si la ventana está abierta) queda afuera a
  // propósito: ofrecer el camino caro —la plantilla— por las dudas sería
  // hacerle pagar de más al dueño. El diálogo completo sí lo averigua releyendo
  // el hilo, y ahí se decide con el dato en la mano.
  // ⛔ `!revalidando`: mientras se relee la ventana, el botón NO puede
  // convertirse en el declarativo y hacer desaparecer el panel que la asesora
  // acaba de abrir. Se decide con el dato fresco, no con el que está por
  // cambiar.
  const sinCamino = !accion || !phone
    || v.estado === 'sin_dato'
    || (!revalidando && conPlantilla && (estadoPl === 'sin_config' || estadoPl === 'error'))
    || (!revalidando && conPlantilla && estadoPl === 'ok' && (!plantilla || huecos.length > 0));
  if (sinCamino) return <>{fallback}</>;

  const listo = conPlantilla ? !!plantilla && huecos.length === 0 : !!textoLibre;

  const mandar = async () => {
    const gestion = accion.gestion;
    const r = conPlantilla && plantilla
      ? await enviarPlantilla(externalId, plantilla.nombre, valores, modulo, { phone, accion: gestion })
      : await enviar(externalId, textoLibre, modulo, { phone, accion: gestion });
    if (r.ok) {
      toast.success(gestion, { description: 'El cliente ya lo recibió por WhatsApp.' });
      setAbierto(false);
      onEnviado?.(gestion);
    } else {
      toast.error(r.error || 'No se pudo enviar');
    }
  };

  return (
    <Popover open={abierto} onOpenChange={setAbierto}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          title={`Le manda el mensaje al cliente por WhatsApp y queda registrado como "${accion.gestion}"`}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/12 px-2.5 py-1.5 text-[11px] font-bold text-accent hover:bg-accent/20 transition-colors',
            className,
          )}
        >
          <MessageCircle size={12} aria-hidden="true" />
          <span className="truncate">{accion.etiqueta}</span>
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-80 p-3 space-y-2.5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Le va a llegar así
          </span>
          {/* Qué canal se está usando, dicho sin jerga de Meta. */}
          <span className="text-[10px] text-muted-foreground/70">
            {conPlantilla ? 'Plantilla aprobada' : 'Mensaje normal'}
          </span>
        </div>

        {revalidando || (conPlantilla && (estadoPl === 'inicial' || estadoPl === 'cargando')) ? (
          // ⛔ Acá NO puede decir "no hay plantilla": todavía no se sabe. Un
          // vacío que se lee como veredicto es el error que ya costó dos veces.
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-2">
            <Loader2 size={13} className="animate-spin shrink-0" aria-hidden="true" />
            Buscando el mensaje aprobado…
          </div>
        ) : (
          <>
            <div className="rounded-xl border border-accent/25 bg-accent/10 px-3 py-2">
              <p className="text-xs leading-snug whitespace-pre-wrap break-words text-foreground">{previa}</p>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">
                Queda como «{accion.gestion}»
              </span>
              <button
                type="button"
                onClick={() => void mandar()}
                disabled={enviando || !listo}
                className="ml-auto btn-accent-3d inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold disabled:opacity-50"
              >
                {enviando ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Send size={12} aria-hidden="true" />}
                {enviando ? 'Mandando…' : 'Mandar'}
              </button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
