// Provincias de Ecuador (24). Guardian es multi-país (CO + EC): el editor de
// pedidos (CustomerForm) usa esta lista cuando la tienda activa es
// country_code='EC', en vez del catálogo DANE de Colombia (colombiaGeo.ts).
//
// Para EC la CIUDAD/cantón se captura como TEXTO LIBRE (Dropi valida del lado
// suyo) — así el operador pone el valor exacto que espera Dropi sin arriesgar un
// mismatch de nombres/casing. Cuando tengamos el catálogo exacto de Dropi EC
// (department/all/with-cities de la cuenta EC) se puede reemplazar por un dropdown
// de cantones, igual que Colombia.

export const PROVINCIAS_ECUADOR: string[] = [
  'Azuay',
  'Bolívar',
  'Cañar',
  'Carchi',
  'Chimborazo',
  'Cotopaxi',
  'El Oro',
  'Esmeraldas',
  'Galápagos',
  'Guayas',
  'Imbabura',
  'Loja',
  'Los Ríos',
  'Manabí',
  'Morona Santiago',
  'Napo',
  'Orellana',
  'Pastaza',
  'Pichincha',
  'Santa Elena',
  'Santo Domingo de los Tsáchilas',
  'Sucumbíos',
  'Tungurahua',
  'Zamora Chinchipe',
];
