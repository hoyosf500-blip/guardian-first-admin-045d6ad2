// Qué cambió en Guardian, contado para el DUEÑO de una tienda.
//
// Por qué existe: la app es una sola y todos los dueños reciben cada mejora al
// recargar — pero nadie se enteraba. Una función que nadie sabe que existe es,
// para el que la paga, una función que no existe.
//
// POR QUÉ EL TEXTO VIVE EN EL CÓDIGO Y NO EN UNA TABLA
// Porque así es IMPOSIBLE anunciar algo que ese usuario todavía no tiene: si su
// navegador tiene este archivo, tiene la mejora. Con una tabla, alguien con el
// bundle viejo leería el anuncio de algo que no puede usar. Además no necesita
// migración (que Lovable no auto-aplica) ni RLS, así que no puede filtrar datos
// entre tiendas.
//
// CÓMO SE ESCRIBE UNA ENTRADA
//  · El título es lo que el dueño PUEDE HACER, no lo que se programó.
//  · Cada punto responde "¿qué puedo hacer hoy que ayer no?" y dice DÓNDE, con
//    el mismo nombre que aparece en el menú.
//  · Prohibido: nombres de archivos, funciones, tablas, "migración", "deploy",
//    "commit". Si el dueño no lo puede ver ni tocar, no va acá.
//  · Máximo 3 puntos. Si hay más, es una versión entera: partirla.
//  · MARCA BLANCA: nunca el nombre de una tienda real ni cifras de una
//    operación concreta — este texto lo leen dueños de tiendas distintas.
//  · Nada de "mejoras de rendimiento": si no se nota, no es una novedad.

export interface Novedad {
  /** 'YYYY-MM-DD'. Ordena y hace de marca de "ya lo vi". */
  id: string;
  titulo: string;
  puntos: string[];
  /** 'dueño' = solo encargados (owner/supervisor). Por defecto la ven todos. */
  para?: 'todos' | 'dueño';
}

/** Días que una entrada enciende el puntito. Pasado eso sigue en la lista pero
 *  ya no interrumpe: un aviso de hace tres meses no es novedad. */
export const VENTANA_NUEVO_DIAS = 30;

/** La más reciente PRIMERO. */
export const NOVEDADES: Novedad[] = [
  {
    id: '2026-08-20',
    titulo: 'Los porcentajes ahora dicen la verdad, y las devoluciones no se esconden',
    para: 'dueño',
    puntos: [
      'Un producto ya no puede mostrar 100% de entrega si tuvo devoluciones: antes el redondeo se las comía. Lo ves en Logística → Productos y Transportadoras.',
      'En Logística → Finanzas hay una tarjeta nueva que compara lo que Dropi te cobró por devoluciones contra las que tu CRM tiene registradas, y te deja traer de Dropi las que falten.',
      'Los pedidos que vuelven en devolución ya aparecen en Seguimiento con su aviso, en vez de figurar como si siguieran en camino.',
    ],
  },
  {
    id: '2026-08-19',
    titulo: 'Menos alarmas falsas',
    puntos: [
      'Cuando el sistema deja una tienda para la próxima sincronización, ya no lo muestra como "sincronización fallida": ahora dice que se resuelve solo.',
      'Una tienda recién conectada y sin pedidos deja de aparecer como si su clave de Dropi estuviera mal.',
    ],
  },
  {
    id: '2026-08-15',
    titulo: 'Ahora podés saber POR QUÉ te cancelan',
    para: 'dueño',
    puntos: [
      'Hay una pantalla nueva en Logística → Cancelaciones: te dice cuántas se podían evitar, cuáles te ahorraron una devolución y cuántas nadie llamó nunca.',
      'Al cancelar, la lista de motivos es más precisa, y podés elegir Reagendar cuando el cliente pide que lo llamen otro día — ese pedido vuelve solo a la cola.',
    ],
  },
];
