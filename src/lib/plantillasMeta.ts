/**
 * Re-export de la lógica de plantillas de WhatsApp aprobadas por Meta.
 *
 * La definición vive en `supabase/functions/_shared/plantillasMeta.ts` porque
 * el SERVIDOR es quien arma el payload que Meta recibe. La pantalla lee
 * exactamente las mismas funciones —no una copia— para que la vista previa que
 * ve la asesora sea, carácter por carácter, lo que le va a llegar al cliente.
 *
 * Mismo patrón que `ventanaWhatsapp` y `conversacion`: lógica pura en
 * `_shared`, consumida desde `src/` cruzando el límite. Se puede porque ese
 * archivo no importa nada — ni siquiera el socket (ver el comentario de
 * `imporchatSocket.ts` sobre por qué eso rompería el typecheck de la app).
 */
export {
  parsearPlantillas,
  renderizar,
  faltantes,
  sugerirValores,
  construirPayloadMeta,
  ordenarParaFase,
  etiquetaDe,
  indicesDe,
  primerNombre,
  type PlantillaMeta,
  type VariablePlantilla,
  type DatosPedido,
} from '../../supabase/functions/_shared/plantillasMeta';
