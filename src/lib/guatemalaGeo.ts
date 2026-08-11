// Catálogo de geografía de Guatemala para tiendas con country_code='GT'.
//
// POR QUÉ EXISTE
// El editor de pedidos es country-aware. Sin este archivo, una tienda de
// Guatemala vería el catálogo DANE de Colombia en el desplegable de
// departamento — exactamente el bug que ya pasó con Ecuador (commit 4289aa5):
// la asesora elige "Antioquia" para un cliente de Quetzaltenango y Dropi
// rechaza el pedido.
//
// La CIUDAD/municipio queda como texto libre (mismo criterio que EC): Dropi
// valida su lado y los nombres de municipio tienen variantes de escritura que
// no vale la pena pelear acá.

export const DEPARTAMENTOS_GUATEMALA: string[] = [
  'Alta Verapaz',
  'Baja Verapaz',
  'Chimaltenango',
  'Chiquimula',
  'El Progreso',
  'Escuintla',
  'Guatemala',
  'Huehuetenango',
  'Izabal',
  'Jalapa',
  'Jutiapa',
  'Petén',
  'Quetzaltenango',
  'Quiché',
  'Retalhuleu',
  'Sacatepéquez',
  'San Marcos',
  'Santa Rosa',
  'Sololá',
  'Suchitepéquez',
  'Totonicapán',
  'Zacapa',
];
