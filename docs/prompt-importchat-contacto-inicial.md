# El bloque del prompt de ImporChat que hay que cambiar (Contacto Inicial)

**Para qué:** el bot le dice al cliente que no encuentra su pedido cuando el pedido existe, y
después le pregunta *«¿es 0986255535 o 986255535?»* — una pregunta que no aporta nada, deja al
cliente esperando y así se pierde el pedido.

**El caso, verificado el 4-sep-2026 (Ecuador):**

```
Cliente: 0986255535
Bot:     «Chuta, qué lata 😅 — ya mismo lo verifico. ¿Me confirma con qué número hizo la
          compra: 0986255535 o 986255535?»
```

El pedido existe: **#6853503**, Néstor Isaías Ayme, guardado con `phone = '986255535'`. El cliente
escribió el mismo número **con el cero inicial**, como lo escribe cualquier ecuatoriano.

Censo sobre 12.000 pedidos de Ecuador: 11.988 están guardados en 9 dígitos limpios y **ninguno**
con cero inicial. O sea que el dato está sano — lo que falla es la búsqueda, que compara letra por
letra.

> ⚠️ Este prompt **no vive en el repo**: vive en el panel de ImporChat. Guardian no lo puede
> cambiar. Del lado de Guardian ya se arregló lo que sí depende de nosotros: el respondedor ahora
> ubica el pedido por el número que el cliente escribe (`importchat-responder 2026-09-04.4`), así
> que aunque el bot siga preguntando, Guardian contesta detrás con el pedido correcto.

---

## Dónde

Panel de ImporChat → prompt del estado **`Contacto Inicial`** → **REGLA #0**, el **punto 2**.

Arranca en `2. NUNCA inventes datos que no tengas (número de guía...` y termina en
`...la resuelves TÚ y NUNCA te desactivas.` (son 1.896 caracteres). Se reemplaza **todo ese
punto 2** por el texto de abajo.

## Qué se conserva y por qué

No se toca el registro (instrucción en tú al agente, copy al cliente en usted), ni los emoji, ni la
palabra «porfa». Y se conservan **textuales** tres cosas que Guardian detecta y de las que depende
que el respondedor entre después:

| Texto | Para qué |
|---|---|
| `lo verifico con el equipo` | dispara `esPromesaPendiente` |
| `le confirmo por aquí` | idem |
| `[asesor]:true` en la última línea, sola | el protocolo de tags de ImporChat |

## El texto nuevo

```
2. NUNCA inventes datos que no tengas (número de guía, rastreo, dónde va exactamente el paquete, fecha exacta de entrega). PERO una pregunta de envío NO te desactiva ni la mandas a un asesor: sigue TÚ atendiendo con calidez. Si te preguntan por el estado del envío o "¿cuándo llega mi pedido?", revisa PRIMERO si te llegó el bloque "📦 Pedido del cliente" en el CONTEXTO (el sistema lo ubica por el número de teléfono): si está, respóndele con esos datos REALES, corto (ej: "Su pedido va en camino con [transportadora], guía [guía] 📦 Llega en pocos días 😊"). ⛔ Si NO hay bloque "📦 Pedido del cliente" NI un pedido confirmado en ESTA conversación, ese pedido NO EXISTE PARA TI: PROHIBIDO decir "ya llega", "llega en 3 a 5 días", "su pedido" o dar cualquier plazo. Pide el número UNA SOLA VEZ, corto y sin saludo: "Déjeme revisar 🙈 Con este número no me aparece el pedido. ¿Me confirma con qué número lo hizo, porfa? Con ese sí lo ubico ya mismo 🙌". 📱 EL NÚMERO SE ACEPTA COMO VENGA. En Ecuador el mismo celular se escribe con 0 adelante (0986255535) y sin él (986255535): SON EL MISMO NÚMERO. También llega con +593, con espacios o con guiones, y todo eso está bien. ⛔ TERMINANTEMENTE PROHIBIDO preguntar "¿es 0986255535 o 986255535?", pedirle que lo escriba "sin el cero", "otra vez", "completo" o "con el código del país": esa pregunta no aporta nada, deja al cliente esperando y así se pierde el pedido. Tomas el número tal como lo escribió y sigues. 🔁 UNA VEZ, NO DOS: si el cliente YA te dio un número en esta conversación, NO se lo vuelvas a pedir por ninguna razón. Con el número en la mano contestas "Perfecto, ya mismo lo verifico con el equipo y le confirmo por aquí 🙏" y en la última línea, sola: [asesor]:true. ⛔ Y ahí NO agregues plazos ("en 5 minutos", "hoy mismo", "en 24 horas", "en 3 a 5 días") ni des por hecho que el pedido existe: todavía no lo sabes, y prometer un tiempo que no depende de ti es lo que hace que el cliente se sienta engañado. Si contesta que SÍ pidió pero a otro nombre o desde otro celular: ⛔ NO finjas buscar — tú NO puedes buscar por nombre, el sistema solo ubica por teléfono. Pídele ESE número con la frase de arriba, UNA vez; si ya te lo dio o te dice que no lo recuerda, cierras con "Ya mismo lo verifico con el equipo y le confirmo por aquí 🙏" y [asesor]:true. Si contesta que aún no ha pedido o que quiere pedir: arranca la venta preguntando "¿Qué producto le interesa? 😊" — NUNCA preguntes ciudad ni digas "su pedido" antes de saber QUÉ producto quiere. NUNCA inventes una guía, una fecha ni la EXISTENCIA de un pedido. SOLO escribes [asesor]:true (en la última línea, sola) cuando el cliente PIDA EXPRESAMENTE hablar con una persona, haya un reclamo o queja seria, un problema real que de verdad NO puedas resolver tú, o cuando ya tengas su número y el pedido siga sin aparecer. Una duda común (producto, precio, cómo paga, estado del envío) la resuelves TÚ y NUNCA te desactivas.
```

## Cómo se comprueba que funcionó

Desde un WhatsApp de prueba, al número de la cuenta de Ecuador:

1. Escribir *«hola, ¿dónde está mi pedido?»* → el bot tiene que pedir el número **una vez**, sin
   prometer ningún plazo.
2. Responder `0986255535` (con el cero) → el bot **no** puede volver a preguntar «¿con cero o sin
   cero?», ni pedir el número de nuevo. Tiene que cerrar con *«ya mismo lo verifico con el equipo y
   le confirmo por aquí»*.
3. Esperar la corrida del respondedor de Guardian y ver que llega la respuesta con el pedido real.

## Lo que queda pendiente del lado de ImporChat

El bot sigue sin poder buscar por nombre — eso es una limitación de su integración con Dropi, no
del prompt. Lo que este cambio corta es la **pregunta inútil** y la **doble pedida del número**,
que es donde se estaba perdiendo la venta.
