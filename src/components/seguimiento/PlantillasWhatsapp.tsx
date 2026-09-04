import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Send, Lock, AlertTriangle, FileText, Search, ChevronRight, ChevronDown, ArrowLeft } from 'lucide-react';
import { usePlantillasMeta, useEnviarPlantilla } from '@/hooks/usePlantillasMeta';
import { useCanalChat, nombreCanal } from '@/hooks/useCanalChat';
import type { ModuloEnvio } from '@/hooks/useEnviarWhatsapp';
import {
  renderizar, faltantes, sugerirValores,
  type PlantillaMeta, type DatosPedido,
} from '@/lib/plantillasMeta';
import {
  partirPlantillas, agruparPlantillas, filtrarPlantillas, faseEnPalabras, nombreVisible,
} from '@/lib/accionSeguimiento';
import { conRastreo } from '@/lib/datosPlantilla';
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
 *
 * ── Cómo se ve (30-ago-2026, pedido del dueño) ─────────────────────────────
 * *"Las plantillas se ven muy feas en comparación con Chatea Pro o Lucid
 * Bot; que salgan las predefinidas según dónde esté el asesor y si quiere
 * otra, que la busque."* Antes: 3 botones grandes + una nube de 40 chips con
 * el mismo rótulo repetido cinco veces ("Volver a ofrecerle el producto" ×5).
 * Ahora es una LISTA de filas —como la de Lucid Bot—, cada una con su nombre
 * en español y, debajo, el mensaje tal como le llegaría a ESTE cliente (eso
 * es lo que distingue dos plantillas con el mismo nombre). Arriba las de la
 * fase del pedido; el resto agrupado por fase detrás de "Ver todas"; y un
 * buscador que mira nombre y cuerpo. La plantilla elegida se queda sola en
 * pantalla con su formulario: la lista se pliega para no competir con el
 * mensaje que se va a mandar.
 */

/** Cómo se ve una plantilla en la lista: el nombre en español y, debajo, el
 *  mensaje ya armado con los datos de este pedido (truncado a una línea).
 *  El nombre técnico de Meta va en el `title`, para quien lo necesite. */
function FilaPlantilla({ p, previa, activa, destacada, onClick }: {
  p: PlantillaMeta;
  previa: string;
  activa: boolean;
  destacada?: boolean;
  onClick: () => void;
}) {
  const bloqueada = !!p.noSoportada;
  return (
    <button
      type="button"
      disabled={bloqueada}
      title={p.noSoportada ?? p.nombre}
      onClick={onClick}
      className={cn(
        'w-full min-w-0 overflow-hidden text-left flex items-center gap-3 rounded-xl border px-3 py-2 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        bloqueada
          ? 'border-border/60 bg-card/20 cursor-not-allowed opacity-60'
          : activa
          ? 'border-accent/60 bg-accent/15'
          : destacada
          ? 'border-accent/25 bg-accent/8 hover:bg-accent/15 hover:border-accent/50'
          : 'border-border bg-card/40 hover:border-border-strong hover:bg-card/60',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className={cn('block text-xs font-semibold truncate', activa ? 'text-accent' : 'text-foreground')}>
          {nombreVisible(p.nombre)}
        </span>
        <span className="block text-[11px] text-muted-foreground truncate">
          {bloqueada ? p.noSoportada : previa}
        </span>
      </span>
      {p.categoria === 'MARKETING' && !bloqueada && (
        <span
          className="shrink-0 rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[9px] font-bold text-warning"
          title="Plantilla de promoción: Meta la cobra más caro y la restringe más que una de logística."
        >
          PROMO
        </span>
      )}
      {bloqueada
        ? <Lock size={12} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        : <ChevronRight size={14} className="shrink-0 text-muted-foreground/70" aria-hidden="true" />}
    </button>
  );
}

function TituloGrupo({ children, deLaFase }: { children: React.ReactNode; deLaFase?: boolean }) {
  return (
    <p className={cn(
      'px-1 pt-1.5 pb-0.5 text-[10px] font-bold uppercase tracking-wide',
      deLaFase ? 'text-accent' : 'text-muted-foreground',
    )}>
      {children}
    </p>
  );
}

export default function PlantillasWhatsapp({ externalId, fase, estadoPedido, phone, datos, modulo, onEnviado }: {
  externalId: string;
  fase?: string | null;
  /** El estado CRUDO de Dropi ("PARA RETIRO EN AGENCIA SERVIENTREGA"). Es lo que
   *  `partirPlantillas` necesita para saber cuáles sirven acá. Va aparte de
   *  `fase` —que ya viene clasificada y la usa el servidor para ordenar— porque
   *  clasificar dos veces no funciona. */
  estadoPedido?: string | null;
  /** Para que el contador baje al instante tras enviar (el touchpoint lo
   *  escribe el servidor; ver `eventosGestion.ts`). */
  phone?: string | null;
  datos: DatosPedido;
  modulo?: ModuloEnvio;
  onEnviado?: () => void;
}) {
  const { plantillas, estado, error, recargar } = usePlantillasMeta(true, fase);
  const { enviarPlantilla, enviando } = useEnviarPlantilla();
  // ⛔ El canal se NOMBRA, no se escribe a mano: en Colombia es Chatea Pro
  // y decir "ImporChat" manda a la asesora a la app de otro país.
  const canalNombre = nombreCanal(useCanalChat());
  const [elegida, setElegida] = useState<PlantillaMeta | null>(null);
  const [valores, setValores] = useState<Record<number, string>>({});
  const [verTodas, setVerTodas] = useState(false);
  const [busqueda, setBusqueda] = useState('');

  // ⛔ 40 botones con el nombre CRUDO de Meta (`retiro_agencia_k1`,
  // `remarketin3 ecomm`) no es una lista, es un volcado de identificadores —
  // *"mis colaboradores no entienden y no saben trabajar, hay muchos botones"*.
  // Arriba van las 2-3 que sirven para ESTE pedido, con nombre en español; el
  // resto queda a un clic. NINGUNA se esconde: la regla de este archivo sigue
  // siendo que esconder una plantilla aprobada es decidir por la asesora con
  // una regexp.
  // Serializado para que las memos de abajo no se recalculen por una identidad
  // nueva del objeto en cada render (ver el bloque del efecto más abajo).
  const claveDatos = JSON.stringify(datos ?? {});
  // ⛔ EL TERCER ARGUMENTO (30-ago-2026). `partirPlantillas` hace DOS pasadas
  // —primero las completables, después el resto— pero SOLO si recibe el
  // predicado. El diálogo la llamaba con dos argumentos, así que la doble
  // pasada nunca corría y dentro de cada patrón mandaba el desempate por
  // botones/variables, que no mira si Guardian puede completar la plantilla.
  //
  // Efecto en pantalla: en un pedido en agencia, la PRIMERA recomendada era la
  // que pide «Plazo para retirar: ____ días». La asesora la elegía, aparecía
  // «Falta un dato» y el botón Enviar quedaba deshabilitado. O peor: escribía
  // un plazo inventado, que es justo lo que este módulo tiene prohibido.
  //
  // Las incompletables NO se esconden —siguen en la lista, detrás—: solo dejan
  // de salir primeras. Es la misma lección que `plantillaParaAccion` ya aplica
  // en el botón de acción ("entre dos que sirven, la que se puede mandar gana a
  // la que suena mejor"), que faltaba en el selector.
  const { recomendadas } = useMemo(
    () => {
      const d = conRastreo(JSON.parse(claveDatos) as DatosPedido);
      return partirPlantillas(plantillas, estadoPedido, (p) => faltantes(p, sugerirValores(p, d)).length === 0);
    },
    [plantillas, estadoPedido, claveDatos],
  );
  const grupos = useMemo(() => agruparPlantillas(plantillas, estadoPedido), [plantillas, estadoPedido]);
  // En "Ver todas" las recomendadas ya están arriba: repetirlas dentro de su
  // grupo era ver la misma fila dos veces (visto en pantalla el 30-ago).
  const gruposSinRecomendadas = useMemo(() => {
    const arriba = new Set(recomendadas.map((p) => p.nombre));
    return grupos
      .map((g) => ({ ...g, plantillas: g.plantillas.filter((p) => !arriba.has(p.nombre)) }))
      .filter((g) => g.plantillas.length > 0);
  }, [grupos, recomendadas]);
  const enPalabras = useMemo(() => faseEnPalabras(estadoPedido), [estadoPedido]);

  // ⛔ La dependencia es el CONTENIDO de `datos`, no su identidad.
  //
  // Quien llama arma el objeto inline (`datos={{ guia: o.guia, … }}`), así que
  // es uno nuevo en cada render. Depender de la referencia haría que este
  // efecto corriera de nuevo con cada tecla y le PISARA a la asesora lo que
  // acaba de escribir en un campo — el mensaje saldría con el dato sugerido en
  // vez del que ella corrigió. Serializar deja que el efecto corra solo cuando
  // el pedido cambia de verdad, y no obliga a que cada call-site se acuerde de
  // memoizar.
  useEffect(() => {
    // `conRastreo` arma el link de rastreo cuando la transportadora lo permite;
    // sin él, el hueco del link se llenaba con el NÚMERO de guía y el cliente
    // recibía "seguí tu envío aquí 👉 V123456789" (ver `datosPlantilla.ts`).
    if (elegida) setValores(sugerirValores(elegida, conRastreo(JSON.parse(claveDatos) as DatosPedido)));
  }, [elegida, claveDatos]);

  // La línea de abajo de cada fila: el mensaje como le llegaría a ESTE
  // cliente, con los datos que Guardian ya sabe. Es lo que hace distinguibles
  // dos plantillas con el mismo nombre en español (la cuenta tiene cinco
  // "Volver a ofrecerle el producto"). Un hueco que no se sabe llenar queda
  // como "____", que también es información: "ésta te va a pedir un dato".
  const previas = useMemo(() => {
    const d = conRastreo(JSON.parse(claveDatos) as DatosPedido);
    const m = new Map<string, string>();
    for (const p of plantillas) {
      const texto = renderizar(p.cuerpo, sugerirValores(p, d)).replace(/\{\{\d+\}\}/g, '____').replace(/\s+/g, ' ').trim();
      m.set(p.nombre, texto);
    }
    return m;
  }, [plantillas, claveDatos]);

  const huecos = useMemo(() => (elegida ? faltantes(elegida, valores) : []), [elegida, valores]);
  const previa = useMemo(
    () => (elegida ? renderizar(elegida.cuerpo, valores) : ''),
    [elegida, valores],
  );

  // Con búsqueda se mira TODA la cuenta, agrupada igual, sin la sección de
  // recomendadas: la asesora ya dijo qué quiere.
  const buscando = busqueda.trim().length > 0;
  const gruposFiltrados = useMemo(() => {
    if (!buscando) return grupos;
    const permitidas = new Set(filtrarPlantillas(plantillas, busqueda).map((p) => p.nombre));
    return grupos
      .map((g) => ({ ...g, plantillas: g.plantillas.filter((p) => permitidas.has(p.nombre)) }))
      .filter((g) => g.plantillas.length > 0);
  }, [buscando, busqueda, grupos, plantillas]);
  const coincidencias = useMemo(
    () => gruposFiltrados.reduce((n, g) => n + g.plantillas.length, 0),
    [gruposFiltrados],
  );
  // Sin recomendadas (fase sin acción obvia) la lista completa sale de una:
  // no hay nada mejor que mostrar primero.
  const mostrarTodas = verTodas || recomendadas.length === 0;

  const mandar = async () => {
    if (!elegida) return;
    // El `phone` va para que el contador de la pantalla baje al instante: el
    // touchpoint lo escribe el servidor y sin este aviso nadie se entera hasta
    // recargar (ver `eventosGestion.ts`).
    const r = await enviarPlantilla(externalId, elegida.nombre, valores, modulo, { phone });
    // ⛔ Otra pestaña o una compañera la está mandando AHORA. No es un error ni
    // un éxito: es esperar y mirar el chat.
    if (r.enCurso) {
      toast.info('Se está mandando ahora mismo', {
        description: 'Otra pestaña o una compañera la disparó hace unos segundos. Esperá y mirá el chat.',
      });
      return;
    }
    // ⛔ ImporChat aceptó el envío y el mensaje NO apareció en la conversación
    // (4-sep-2026: 9 de 14 en once días). NO se cierra el panel, NO se pinta la
    // tarjeta y NO se anota la gestión: el cliente no tiene nada.
    if (r.sinConfirmar) {
      toast.error('No se pudo comprobar que saliera', {
        description: `${canalNombre} aceptó el envío pero el mensaje NO aparece en la conversación. No lo des por enviado: abrí el chat y mirá. Si no está, reintentá.`,
        duration: 12000,
      });
      return;
    }
    if (r.sinLectura) {
      toast.error('No pude leer el chat, así que no mandé nada', {
        description: 'Probá de nuevo en un momento, o mandala desde el panel de chat.',
      });
      return;
    }
    if (r.ok && r.yaEnviado) {
      // Ahora esto SÍ es verdad: la fila solo bloquea cuando el mensaje se vio
      // en el chat. Antes bloqueaba con haberlo intentado, así que el aviso
      // salía sobre envíos que nunca ocurrieron y la asesora se quedaba sin
      // camino: ni se reenviaba, ni sabía que el cliente no tenía nada.
      const hora = r.enviadoAt
        ? new Date(r.enviadoAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
        : null;
      toast.info(
        hora
          ? `Ya se le mandó hoy a las ${hora} y se vio en el chat — no se reenvió`
          : 'Esta plantilla ya se le había mandado hoy — no se reenvió',
        { description: 'Si necesitás insistir, llamalo o mandale un mensaje escrito.' },
      );
      setElegida(null);
      // NO se llama a onEnviado: es lo que pinta la tarjeta como gestionada.
      return;
    }
    if (r.ok) {
      // `confirmado === undefined` = servidor sin redesplegar: se dice lo justo,
      // sin afirmar que el cliente la recibió.
      toast.success(r.confirmado ? 'Plantilla enviada — se ve en el chat del cliente' : 'Plantilla enviada');
      setElegida(null);
      onEnviado?.();
    } else {
      toast.error(r.error || 'No se pudo enviar');
    }
  };

  // Una tienda sin ImporChat no ve nada: mejor que no exista a que exista
  // vacío y parezca roto.
  if (estado === 'sin_config') return null;

  const fila = (p: PlantillaMeta, destacada?: boolean) => (
    <FilaPlantilla
      key={p.nombre}
      p={p}
      previa={previas.get(p.nombre) ?? ''}
      activa={elegida?.nombre === p.nombre}
      destacada={destacada}
      onClick={() => setElegida(elegida?.nombre === p.nombre ? null : p)}
    />
  );

  return (
    // ⛔ `min-w-0`: el DialogContent de shadcn es un GRID, y un hijo de grid
    // tiene `min-width: auto` — con las filas en una sola línea (`truncate` =
    // nowrap) el ancho mínimo del selector pasaba a ser el del mensaje más
    // largo y la caja entera se salía del diálogo hacia la derecha (visto el
    // 30-ago en el dev server). Con min-w-0 el grid lo deja encoger y el
    // truncado hace su trabajo.
    <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card/30 p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <FileText size={13} className="text-muted-foreground shrink-0" aria-hidden="true" />
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          Mandarle una plantilla
        </span>
        {estado === 'ok' && plantillas.length > 0 && (
          <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">{plantillas.length} aprobadas</span>
        )}
      </div>

      {estado === 'inicial' || estado === 'cargando' ? (
        // ⛔ Acá NO puede decir "no hay plantillas": todavía no se sabe.
        <div className="space-y-1.5" aria-label="Leyendo las plantillas">
          {[0, 1, 2].map((i) => <div key={i} className="h-11 rounded-xl bg-muted/40 animate-pulse" />)}
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
      ) : elegida ? (
        // La elegida, sola. La lista se pliega: lo que importa ahora es el
        // mensaje que va a salir, no las otras 42.
        <div className="space-y-2.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setElegida(null)}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft size={12} aria-hidden="true" />
              Elegir otra
            </button>
          </div>
          {fila(elegida)}

          {elegida.noSoportada ? (
            <p className="text-[11px] text-warning">{elegida.noSoportada}</p>
          ) : (
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
        </div>
      ) : (
        <>
          {/* El buscador va siempre: "si quiere enviar otra, que la busque". */}
          <label className="relative block">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar una plantilla… (agencia, guía, novedad, descuento)"
              aria-label="Buscar una plantilla"
              className="w-full rounded-lg border border-border bg-card/40 pl-8 pr-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>

          {buscando ? (
            coincidencias === 0 ? (
              <p className="text-[11px] text-muted-foreground px-1">
                Ninguna plantilla dice «{busqueda.trim()}». Probá con otra palabra: agencia, guía, novedad, reparto…
              </p>
            ) : (
              <div className="max-h-[340px] overflow-y-auto pr-0.5 space-y-1">
                {gruposFiltrados.map((g) => (
                  <div key={g.clave} className="space-y-1">
                    <TituloGrupo deLaFase={g.deLaFase}>{g.titulo}</TituloGrupo>
                    {g.plantillas.map((p) => fila(p, g.deLaFase))}
                  </div>
                ))}
              </div>
            )
          ) : (
            <>
              {/* Las que sirven para ESTE pedido, primero y marcadas. Es lo
                  que la asesora va a tocar el 90% de las veces. */}
              {recomendadas.length > 0 && (
                <div className="space-y-1">
                  <TituloGrupo deLaFase>
                    Para este pedido{enPalabras ? ` · ${enPalabras}` : ''}
                  </TituloGrupo>
                  {recomendadas.map((p) => fila(p, true))}
                </div>
              )}

              {mostrarTodas ? (
                <div className="max-h-[340px] overflow-y-auto pr-0.5 space-y-1">
                  {gruposSinRecomendadas.map((g) => (
                    <div key={g.clave} className="space-y-1">
                      <TituloGrupo deLaFase={g.deLaFase}>{g.titulo}</TituloGrupo>
                      {g.plantillas.map((p) => fila(p, g.deLaFase))}
                    </div>
                  ))}
                </div>
              ) : (
                // El resto NO desaparece: queda a un clic. Si se borrara, una
                // asesora con un caso raro (un reclamo, un rescate) se quedaría
                // sin la plantilla que necesita y sin saber que existe.
                <button
                  type="button"
                  onClick={() => setVerTodas(true)}
                  className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-1.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:border-border-strong"
                >
                  <ChevronDown size={12} aria-hidden="true" />
                  Ver todas las plantillas ({plantillas.length})
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
