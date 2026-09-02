import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * PRUEBA GUARDIANA — a qué canal le habla cada tienda.
 *
 * Ecuador atiende por ImporChat y las dos de Colombia por Chatea Pro. Las
 * pantallas son las mismas; lo único que cambia es la edge function.
 *
 * Lo que se está protegiendo, en orden de cuánto costaría:
 *
 *  1. **Que el mensaje salga por el canal equivocado.** Mandar el chat de un
 *     cliente colombiano a la función de ImporChat no da un error limpio: da
 *     "esta tienda no tiene ImporChat configurado" sobre una conversación que
 *     sí existe, y la asesora concluye que el CRM está roto.
 *  2. **Que la consulta de `stores` de StoreContext crezca.** Esa consulta
 *     sostiene la app entera: si le agregan `canal_chat` y la migración no se
 *     aplicó, el SELECT muere con «column does not exist» y NADIE entra. Es el
 *     accidente que CLAUDE.md documenta con `ORDER_COLUMNS`.
 *  3. **Que se pierda alguna de las tres reglas del envío** (ventana de 24 h,
 *     verificar que salió, dejar autor). Se escribieron para ImporChat después
 *     de que un mensaje "enviado" nunca llegara; el canal nuevo nace con ellas.
 */

const raiz = process.cwd();
const leer = (p: string) => readFileSync(join(raiz, p), 'utf8');
/** Quita comentarios de línea sin confundir el `//` de `https://`. */
const sinComentarios = (t: string) =>
  t.replace(/(?<!:)\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const canal = sinComentarios(leer('src/lib/canalChat.ts'));
const conversacion = sinComentarios(leer('src/hooks/useConversacion.ts'));
const enviar = sinComentarios(leer('src/hooks/useEnviarWhatsapp.ts'));
const plantillas = sinComentarios(leer('src/hooks/usePlantillasMeta.ts'));
const storeCtx = sinComentarios(leer('src/contexts/StoreContext.tsx'));

const cpChat = sinComentarios(leer('supabase/functions/chateapro-chat/index.ts'));
const cpSend = sinComentarios(leer('supabase/functions/chateapro-send/index.ts'));
const cpPlant = sinComentarios(leer('supabase/functions/chateapro-plantillas/index.ts'));
const cpApi = sinComentarios(leer('supabase/functions/_shared/chateaproApi.ts'));

describe('canal de chat por tienda', () => {
  it('ningún hook vuelve a clavar el nombre de la función de ImporChat', () => {
    for (const [nombre, src] of [
      ['useConversacion', conversacion],
      ['useEnviarWhatsapp', enviar],
      ['usePlantillasMeta', plantillas],
    ] as const) {
      expect(
        /invoke\(\s*'importchat-/.test(src),
        `${nombre} llama a ImporChat de forma fija: la asesora de Colombia queda sin canal`,
      ).toBe(false);
      expect(
        /fnCanal\(/.test(src),
        `${nombre} debe resolver el canal con fnCanal antes de invocar`,
      ).toBe(true);
    }
  });

  it('resolver el canal NUNCA lanza ni deja a la tienda sin canal', () => {
    expect(/catch/.test(canal), 'sin catch, una columna que falta apaga el botón de escribir').toBe(true);
    expect(/country_code/.test(canal), 'debe haber respaldo por país si no está la columna').toBe(true);
  });

  it('la consulta de stores de StoreContext no se toca', () => {
    const sel = storeCtx.match(/from\('stores'\)\s*\.select\('([^']*)'\)/);
    expect(sel, 'no se encontró el SELECT de stores').not.toBeNull();
    expect(
      /canal_chat/.test(sel![1]),
      'si esa columna entra acá y la migración no está aplicada, el SELECT muere y NADIE puede entrar a la app',
    ).toBe(false);
  });
});

describe('las funciones de Chatea Pro nacen con las reglas puestas', () => {
  const funcs = [
    ['chateapro-chat', cpChat],
    ['chateapro-send', cpSend],
    ['chateapro-plantillas', cpPlant],
  ] as const;

  it('todas exigen ser miembro de la tienda', () => {
    for (const [nombre, src] of funcs) {
      expect(/store_members/.test(src), `${nombre} no valida la membresía de la tienda`).toBe(true);
      expect(/auth\.getUser/.test(src), `${nombre} no valida el usuario`).toBe(true);
    }
  });

  it('todas pueden decir qué versión están corriendo', () => {
    for (const [nombre, src] of funcs) {
      expect(
        /respuestaPing\(req, VERSION/.test(src),
        `${nombre} sin ping: Lovable no redespliega edge functions y no habría forma de saber cuál está viva`,
      ).toBe(true);
    }
  });

  it('todas revisan la credencial ANTES de tocar el pedido', () => {
    for (const [nombre, src] of funcs) {
      const iCfg = src.indexOf('cargarConfigChateapro');
      expect(iCfg, `${nombre} no carga la config de Chatea Pro`).toBeGreaterThan(-1);
      const iPedido = src.indexOf("from(\"orders\")");
      if (iPedido > -1) {
        expect(
          iCfg < iPedido,
          `${nombre}: al revés, una tienda sin Chatea Pro recibe un mensaje que promete algo que nunca va a pasar`,
        ).toBe(true);
      }
      expect(/sin_config: true/.test(src), `${nombre} debe responder sin_config`).toBe(true);
    }
  });

  it('escribir respeta las 24 h y verifica que el mensaje salió', () => {
    expect(
      /ventanaWhatsapp\(/.test(cpSend),
      'sin la ventana, el mensaje no se entrega y la asesora queda convencida de que avisó',
    ).toBe(true);
    expect(/ventana_vencida: true/.test(cpSend)).toBe(true);
    expect(
      /apareceEnHilo\(/.test(cpSend),
      'hay que releer el hilo y confirmar: un "listo" sin confirmar es peor que un error',
    ).toBe(true);
  });

  it('el cruce por teléfono confirma los últimos 9 dígitos', () => {
    expect(
      /last9\(s\.phone\) === clave/.test(cpApi),
      'un match flojo por teléfono le muestra a la asesora la conversación de OTRO cliente',
    ).toBe(true);
  });

  it('la plantilla no se manda con huecos vacíos y suelta el candado si falla', () => {
    expect(/faltantes\(/.test(cpPlant)).toBe(true);
    expect(
      /importchat_envios"\)\s*\.delete\(\)/.test(cpPlant) || /\.delete\(\)/.test(cpPlant),
      'si el envío falla y el candado queda puesto, el reintento choca con "ya se mandó hoy" sobre un mensaje que nunca salió',
    ).toBe(true);
    expect(/ya_enviado: true/.test(cpPlant)).toBe(true);
  });

  it('se reusa el parser de plantillas, no se escribe un segundo', () => {
    expect(
      /parsearPlantillas/.test(cpPlant),
      'dos definiciones del mismo hecho es la trampa que este repo ya pagó',
    ).toBe(true);
  });

  it('la API key nunca baja al navegador', () => {
    const mig = leer('supabase/migrations/20260902180000_chateapro_canal_por_tienda.sql');
    expect(/REVOKE ALL ON TABLE public\.store_chateapro_config/.test(mig)).toBe(true);
    expect(
      /store_chateapro_config/.test(canal + conversacion + enviar + plantillas),
      'ningún archivo del cliente puede leer la tabla de credenciales',
    ).toBe(false);
  });
});
