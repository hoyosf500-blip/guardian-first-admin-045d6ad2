import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ⛔ GUARDIÁN — una plantilla no se canta hasta VERLA en el chat.
 *
 * Medido en producción el 4-sep-2026 (Ecuador): del 25-ago al 4-sep, `touchpoints`
 * tenía 14 apuntes de "Mandé la plantilla X" y **9 de esos clientes no recibieron
 * ningún mensaje** — su último saliente real era del 31-ago o del 2-sep. Solo ese
 * día fueron 5 de 6.
 *
 * ImporChat contestaba `success:true` y Guardian daba el envío por hecho: escribía
 * el touchpoint, pintaba la tarjeta como gestionada y le sumaba la gestión a la
 * productividad de la asesora. El cliente no tenía nada. Y al reintentar, el
 * candado decía "ya se le había mandado hoy" sobre un envío que nunca existió.
 *
 * Control que prueba que el candado no era el culpable: Colombia usa el MISMO
 * diseño y lleva 17 plantillas de 17 entregadas desde el 20-ago. El `success:true`
 * de `enviar_template_masivo` confirma que RECIBIERON EL PEDIDO, no que
 * ENTREGARON EL MENSAJE.
 *
 * ⛔ ── CORRECCIÓN de esa misma noche: la conclusión era FALSA ───────────────
 * Las plantillas SÍ llegaban al cliente. Lo que faltaba era la SEGUNDA llamada
 * que hace el panel de ImporChat, `clientes_chat_center/agregarMensajeEnviado`,
 * que es la que deja el mensaje en la conversación. Guardian hacía solo la
 * primera, así que el mensaje salía y el hilo quedaba mudo — y el espejo
 * `orders.chat_saliente_at`, que se alimenta de ese hilo, tampoco se movía. De
 * ahí salieron los "9 de 14 sin recibir nada": medían el registro que faltaba,
 * no la entrega.
 *
 * La prueba: se le mandó `en_transito_v2` a Ariana Cárdenas (#6856013) y ella
 * contestó apretando **"Perfecto"** —el único botón "Perfecto" de las 46
 * plantillas de la cuenta— mientras su hilo seguía sin mostrar el mensaje.
 *
 * Por eso lo que confirma un envío ahora es el **wamid** (el recibo de Meta),
 * no releer el hilo. Releerlo buscaba algo que nadie estaba escribiendo: nunca
 * iba a confirmar, y habría mandado a reenviar mensajes ya entregados — dos
 * WhatsApp al mismo cliente, que es peor que el bug original.
 */
const RAIZ = process.cwd();
const leerEdge = (rel: string) => readFileSync(join(RAIZ, 'supabase', 'functions', rel), 'utf8');
const leerSrc = (rel: string) => readFileSync(join(RAIZ, 'src', rel), 'utf8');

const sinComentarios = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');

describe('⛔ la plantilla no se canta sin verla en el chat', () => {
  const edge = sinComentarios(leerEdge('importchat-plantillas/index.ts'));

  it('el claim NUNCA se borra: la fila es la prueba', () => {
    // Borrar destruía la evidencia. De los 9 envíos perdidos no quedó rastro en
    // ningún lado salvo un touchpoint que miente — y sin rastro no hay nada que
    // reclamarle a ImporChat.
    expect(edge, 'volvió el DELETE sobre importchat_envios: se pierde la prueba del envío que no salió')
      .not.toMatch(/importchat_envios[\s\S]{0,200}\.delete\(\)/);
    // El candado ahora es un ESTADO, no la existencia de la fila.
    expect(edge).toMatch(/estado: "confirmado"/);
    expect(edge).toMatch(/estado: "enviando"/);
  });

  it('«ya se mandó hoy» solo sale sobre una fila CONFIRMADA', () => {
    const i = edge.indexOf('ya_enviado: true');
    expect(i, 'no encontré la respuesta de idempotencia').toBeGreaterThan(-1);
    const antes = edge.slice(Math.max(0, i - 500), i);
    expect(antes, 'el candado volvió a bloquear con haberlo intentado, no con haberlo visto')
      .toMatch(/estado === "confirmado"/);
  });

  it('el touchpoint y el sello del pedido cuelgan de la confirmación', () => {
    const iSalida = edge.indexOf('verificado.estado !== "confirmado"');
    expect(iSalida, 'no existe el corte de no-confirmado').toBeGreaterThan(-1);
    const iTouch = edge.indexOf('from("touchpoints")');
    expect(iTouch, 'no encontré el touchpoint').toBeGreaterThan(-1);
    expect(iSalida, 'el touchpoint se escribe ANTES de comprobar: vuelve a anotarse una gestión que no ocurrió')
      .toBeLessThan(iTouch);
    const iSaliente = edge.indexOf('chat_saliente_tipo');
    expect(iSalida).toBeLessThan(iSaliente);
  });

  it('el error del UPDATE que cierra la fila SE MIRA', () => {
    // El `liberarClaim()` viejo hacía su DELETE sin mirar el error: si fallaba,
    // el candado quedaba puesto todo el día sobre un envío inexistente.
    expect(edge).toMatch(/if \(error\) console\.warn\(`\[importchat-plantillas\] no pude cerrar la fila/);
  });

  it('falla CERRADO si falta la migración', () => {
    // Antes degradaba con un console.warn y seguía "sin idempotencia". Una
    // degradación silenciosa es la familia de la que salió este bug.
    expect(edge).toMatch(/Falta aplicar la migraci/);
    expect(edge, 'volvió el camino que manda igual cuando la tabla no está lista')
      .not.toMatch(/env[ií]o SIN idempotencia/);
  });

  it('no se loguean datos del cliente', () => {
    const sospechosas = edge.split(/\r?\n/).filter(
      (l) => /console\.(log|warn|error)/.test(l) && /pedido\.phone|payload|destino|valores/.test(l),
    );
    expect(sospechosas).toEqual([]);
  });

  it('la marca de versión subió con el arreglo', () => {
    // Se pide la FECHA, no la revisión exacta: clavar el número convierte esta
    // prueba en papeleo que hay que tocar en cada bump.
    expect(edge).toMatch(/const VERSION = "importchat-plantillas 2026-09-0\d\.\d+ /);
  });
});

describe('⛔ mandar una plantilla son DOS llamadas', () => {
  const edge = sinComentarios(leerEdge('importchat-plantillas/index.ts'));
  const verificada = sinComentarios(leerEdge('_shared/imporchatPlantillaVerificada.ts'));
  const registrar = sinComentarios(leerEdge('_shared/imporchatRegistrarMensaje.ts'));

  it('después de mandar, DEJA EL MENSAJE ESCRITO en la conversación', () => {
    // Sin esto el cliente recibe la plantilla y el hilo queda mudo: exactamente
    // lo que reportó el equipo ("la plantilla no llega a ImporChat").
    expect(edge, 'volvió a mandar sin registrar el mensaje en el chat')
      .toContain('clientes_chat_center/agregarMensajeEnviado');
    expect(edge).toMatch(/registrar: \(wamid\) =>/);
  });

  it('⛔ el envío se confirma con el RECIBO DE META, no releyendo el hilo', () => {
    // `success:true` a secas es lo que engañaba: dice que recibieron el pedido.
    expect(verificada).toContain('wamidDe');
    const i = verificada.indexOf('const wamid = wamidDe');
    expect(i, 'ya no se lee el wamid del envío').toBeGreaterThan(-1);
    expect(verificada.slice(i, i + 600), 'un envío sin recibo de Meta dejó de ser un fallo')
      .toMatch(/if \(!wamid\)[\s\S]{0,200}estado: "fallido"/);
  });

  it('el wamid se lee de las tres formas que mira el propio panel', () => {
    expect(registrar).toMatch(/datos\.wamid/);
    expect(registrar).toMatch(/data\?\.messages\?\.\[0\]\?\.id/);
  });

  it('⛔ si no se puede leer el chat, el envío SIGUE', () => {
    // Antes se cancelaba. Cancelarle el aviso a un cliente porque un socket no
    // abrió no se paga con nada, y el recibo de Meta ya dice la verdad.
    expect(verificada, 'volvió el camino que cancela el envío por no poder leer')
      .not.toMatch(/estado: "sin_lectura"/);
    expect(verificada).toMatch(/if \(antes === null\) return resultado;/);
  });

  it('⛔ nunca se manda dos veces', () => {
    // El POST vive dentro del bloque del socket: si ese bloque explota después
    // de mandar, el camino de respaldo NO puede volver a mandar.
    expect(verificada).toMatch(/let yaMande = false;/);
    const i = verificada.indexOf('if (yaMande)');
    expect(i, 'se sacó el candado anti doble envío').toBeGreaterThan(-1);
    expect(verificada.slice(i, i + 260)).toMatch(/return resultadoDelEnvio;/);
  });

  it('no se guarda el payload del cliente en la respuesta', () => {
    // `respuestaSegura` es lista blanca: ahí no pueden entrar nombre, dirección
    // ni teléfono.
    expect(verificada).toMatch(/\["success", "status", "message", "wamid", "error", "code"\]/);
  });
});

describe('⛔ la pantalla no afirma un envío sin confirmar', () => {
  const plantillas = sinComentarios(leerSrc('components/seguimiento/PlantillasWhatsapp.tsx'));
  const accion = sinComentarios(leerSrc('components/seguimiento/AccionPrincipal.tsx'));

  it('murió «el cliente ya lo recibió»', () => {
    // Era la mentira, textual: el servidor confirmaba con que ImporChat aceptara
    // el pedido, y eso fue falso 9 de 14 veces en once días.
    for (const [nombre, src] of [['PlantillasWhatsapp', plantillas], ['AccionPrincipal', accion]] as const) {
      expect(src, `${nombre} volvió a afirmar que el cliente lo recibió`).not.toMatch(/ya lo recibi/i);
    }
  });

  it('las dos pantallas distinguen los tres «no salió»', () => {
    for (const [nombre, src] of [['PlantillasWhatsapp', plantillas], ['AccionPrincipal', accion]] as const) {
      expect(src, `${nombre} no avisa cuando ImporChat aceptó y el mensaje no apareció`).toMatch(/sinConfirmar/);
      expect(src, `${nombre} no avisa cuando no se pudo leer el chat`).toMatch(/sinLectura/);
      expect(src, `${nombre} no avisa cuando otra pestaña la está mandando`).toMatch(/enCurso/);
    }
  });

  it('el toast verde y onEnviado NO salen con un envío sin confirmar', () => {
    // `sinConfirmar` corta con un `return` ANTES de llegar al éxito: si alguien
    // saca ese corte, la tarjeta vuelve a pintarse por un mensaje que no llegó.
    for (const [nombre, src] of [['PlantillasWhatsapp', plantillas], ['AccionPrincipal', accion]] as const) {
      const i = src.indexOf('sinConfirmar');
      const bloque = src.slice(i, i + 500);
      expect(bloque, `${nombre}: la rama de "no se pudo comprobar" no corta el flujo`).toMatch(/return;/);
    }
  });

  it('⛔ NO se manda a reenviar cuando no se pudo comprobar', () => {
    // Un mensaje puede estar ENTREGADO y no aparecer en la conversación. Decir
    // "reintentá" ahí le manda dos WhatsApp al mismo cliente.
    for (const [nombre, src] of [['PlantillasWhatsapp', plantillas], ['AccionPrincipal', accion]] as const) {
      const i = src.indexOf('No se pudo comprobar que saliera');
      expect(i, `${nombre}: falta el aviso`).toBeGreaterThan(-1);
      expect(src.slice(i, i + 420), `${nombre} volvió a mandar a reintentar a ciegas`)
        .not.toMatch(/reintent/i);
    }
  });

  it('cuando salió pero no quedó escrita, se dice que NO se reenvíe', () => {
    for (const [nombre, src] of [['PlantillasWhatsapp', plantillas], ['AccionPrincipal', accion]] as const) {
      expect(src, `${nombre} no distingue el envío que salió sin quedar en el chat`).toMatch(/sinRegistro/);
      const i = src.indexOf('sinRegistro');
      expect(src.slice(i, i + 700), `${nombre}: no le pide a la asesora que no reenvíe`)
        .toMatch(/[Nn]o la reenv/);
    }
  });

  it('el hook NO degrada con un servidor sin redesplegar', () => {
    // Lovable no redespliega edge functions al publicar. Con `confirmado`
    // ausente (servidor viejo, o Colombia antes de su commit) la pantalla se
    // comporta como hoy; solo `false` corta.
    const hook = sinComentarios(leerSrc('hooks/usePlantillasMeta.ts'));
    expect(hook).toMatch(/confirmado\?: boolean/);
    expect(hook, 'la confirmación se volvió obligatoria y rompería Colombia de inmediato')
      .not.toMatch(/r\.confirmado !== true/);
  });
});
