// Re-export de los builders PUROS de Meta WhatsApp, para probarlos desde
// `src/lib/*.test.ts` (npm test no corre las pruebas de `supabase/functions/`).
//
// Solo lo puro: los envíos a Meta (`enviarMensajeMeta`, `leerNumeroMeta`,
// `leerPlantillasMeta`) hacen red y viven solo del lado Deno. Mismo patrón que
// `plantillasMeta.ts` / `telefonoWhatsapp.ts`.
export {
  payloadTexto,
  payloadMedia,
  graphBase,
  TIPOS_MEDIA,
  META_API_VERSION_DEFAULT,
  type TipoMedia,
} from "../../supabase/functions/_shared/metaWhatsapp";
