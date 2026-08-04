/**
 * Leer TODAS las filas de un SELECT, no las primeras mil.
 *
 * PostgREST corta cada SELECT en ~1000 filas y NO avisa: la respuesta llega con
 * 200 OK y parece completa. La cola de Confirmar, la lista de Novedades y el
 * tablero de Seguimiento leen poblaciones que no tienen techo natural (los
 * pedidos PENDIENTE se acumulan hasta que alguien los cierra, y los fantasmas
 * que la reconciliación nocturna limpia se juntan si esa reconciliación falla —
 * que fue exactamente lo que pasó del 1 al 4 de agosto). Al cruzar las mil
 * filas los pedidos sobrantes desaparecen de la pantalla sin ningún síntoma:
 * nadie los llama, y no hay forma de notarlo desde adentro de la app.
 *
 * `useDataLoader` ya paginaba así. Esto lo saca a un solo lugar para que las
 * demás pantallas no tengan cada una su propia versión —o ninguna.
 */

/** Lo mínimo que se le pide a una query de Supabase para poder paginarla. */
export interface Paginable<T> {
  range: (desde: number, hasta: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>;
}

export interface ResultadoPaginado<T> {
  filas: T[];
  /** Mensaje del primer error, o `null`. Con error, `filas` trae lo ya leído. */
  error: string | null;
  /** Se llegó al tope duro y puede faltar información. Hay que DECIRLO. */
  truncado: boolean;
}

export const TAMANO_PAGINA = 1000;
export const TOPE_DURO = 20_000;

/**
 * @param hacerQuery Fábrica que devuelve una query LISTA salvo por el `.range()`.
 *   Tiene que traer un `.order()` ESTABLE: sin orden garantizado, Postgres puede
 *   devolver la misma fila en dos páginas y omitir otra — se leerían 3000 filas
 *   y faltarían pedidos igual, que es peor que el bug original porque además
 *   parece que funciona.
 */
export async function paginarQuery<T>(
  hacerQuery: () => Paginable<T>,
  opciones?: { tamanoPagina?: number; topeDuro?: number; cancelado?: () => boolean },
): Promise<ResultadoPaginado<T>> {
  const tamano = opciones?.tamanoPagina ?? TAMANO_PAGINA;
  const tope = opciones?.topeDuro ?? TOPE_DURO;
  const filas: T[] = [];

  for (let desde = 0; ; desde += tamano) {
    if (opciones?.cancelado?.()) return { filas, error: null, truncado: false };

    const { data, error } = await hacerQuery().range(desde, desde + tamano - 1);

    // Error a mitad del paginado: se devuelve lo leído MARCADO como error. Un
    // resultado parcial que se presenta como completo es la forma más cara de
    // fallar — la pantalla mostraría menos pedidos sin decir por qué.
    if (error) return { filas, error: error.message || 'Error leyendo datos', truncado: false };

    const pagina = data || [];
    filas.push(...pagina);
    if (pagina.length < tamano) return { filas, error: null, truncado: false };
    if (filas.length >= tope) return { filas, error: null, truncado: true };
  }
}
