// Lista estática de los 32 departamentos de Colombia con sus ciudades
// principales. No es exhaustiva (Colombia tiene ~1100 municipios) pero
// cubre las cabeceras municipales y ciudades grandes que son el 95% de
// los envíos COD. Si una operadora necesita una ciudad que no está,
// tendremos que ampliar este archivo.
//
// Las claves se guardan tal cual se envían a Dropi (sin tildes en algunos
// casos para coincidir con su normalización interna). Si Dropi rechaza
// un valor por mismatch, ajustar aquí.

export interface DepartamentoCO {
  nombre: string;
  ciudades: string[];
}

export const DEPARTAMENTOS_CO: DepartamentoCO[] = [
  { nombre: 'Amazonas', ciudades: ['Leticia', 'Puerto Nariño'] },
  { nombre: 'Antioquia', ciudades: ['Medellín', 'Bello', 'Envigado', 'Itagüí', 'Sabaneta', 'La Estrella', 'Copacabana', 'Caldas', 'Girardota', 'Barbosa', 'Apartadó', 'Turbo', 'Rionegro', 'La Ceja', 'El Carmen de Viboral', 'Marinilla', 'Guarne', 'Caucasia', 'Yarumal', 'Santa Fe de Antioquia', 'Puerto Berrío', 'Necoclí', 'Chigorodó', 'Carepa'] },
  { nombre: 'Arauca', ciudades: ['Arauca', 'Tame', 'Saravena', 'Arauquita', 'Fortul'] },
  { nombre: 'Atlántico', ciudades: ['Barranquilla', 'Soledad', 'Malambo', 'Sabanagrande', 'Puerto Colombia', 'Galapa', 'Baranoa', 'Sabanalarga', 'Palmar de Varela'] },
  { nombre: 'Bolívar', ciudades: ['Cartagena', 'Magangué', 'Turbaco', 'Arjona', 'El Carmen de Bolívar', 'Mompós', 'San Pablo', 'Santa Rosa del Sur', 'María la Baja'] },
  { nombre: 'Boyacá', ciudades: ['Tunja', 'Duitama', 'Sogamoso', 'Chiquinquirá', 'Paipa', 'Villa de Leyva', 'Puerto Boyacá', 'Moniquirá', 'Garagoa', 'Soatá'] },
  { nombre: 'Caldas', ciudades: ['Manizales', 'Villamaría', 'Chinchiná', 'La Dorada', 'Riosucio', 'Anserma', 'Aguadas', 'Salamina', 'Supía'] },
  { nombre: 'Caquetá', ciudades: ['Florencia', 'San Vicente del Caguán', 'Puerto Rico', 'La Montañita', 'El Doncello'] },
  { nombre: 'Casanare', ciudades: ['Yopal', 'Aguazul', 'Tauramena', 'Villanueva', 'Paz de Ariporo', 'Monterrey'] },
  { nombre: 'Cauca', ciudades: ['Popayán', 'Santander de Quilichao', 'Puerto Tejada', 'Patía (El Bordo)', 'Piendamó', 'Guapi', 'Cajibío', 'Miranda', 'Caloto'] },
  { nombre: 'Cesar', ciudades: ['Valledupar', 'Aguachica', 'Codazzi', 'La Jagua de Ibirico', 'Bosconia', 'Curumaní', 'San Diego', 'Chimichagua'] },
  { nombre: 'Chocó', ciudades: ['Quibdó', 'Istmina', 'Tadó', 'Acandí', 'Riosucio', 'Bahía Solano', 'Nuquí'] },
  { nombre: 'Córdoba', ciudades: ['Montería', 'Cereté', 'Lorica', 'Sahagún', 'Planeta Rica', 'Tierralta', 'Montelíbano', 'Ciénaga de Oro', 'Chinú'] },
  { nombre: 'Cundinamarca', ciudades: ['Soacha', 'Chía', 'Zipaquirá', 'Facatativá', 'Mosquera', 'Madrid', 'Funza', 'Cajicá', 'Fusagasugá', 'Girardot', 'La Calera', 'Cota', 'Sopó', 'Tocancipá', 'Tenjo', 'Sibaté', 'Tabio', 'Ubaté', 'Pacho', 'Villeta', 'Anolaima', 'La Mesa', 'Cáqueza'] },
  { nombre: 'Bogotá D.C.', ciudades: ['Bogotá'] },
  { nombre: 'Guainía', ciudades: ['Inírida'] },
  { nombre: 'Guaviare', ciudades: ['San José del Guaviare', 'Calamar', 'El Retorno'] },
  { nombre: 'Huila', ciudades: ['Neiva', 'Pitalito', 'Garzón', 'La Plata', 'Campoalegre', 'Aipe', 'Gigante', 'Palermo', 'Rivera', 'San Agustín'] },
  { nombre: 'La Guajira', ciudades: ['Riohacha', 'Maicao', 'Uribia', 'Manaure', 'San Juan del Cesar', 'Villanueva', 'Fonseca', 'Albania', 'Dibulla'] },
  { nombre: 'Magdalena', ciudades: ['Santa Marta', 'Ciénaga', 'Fundación', 'El Banco', 'Plato', 'Aracataca', 'Pivijay', 'Zona Bananera'] },
  { nombre: 'Meta', ciudades: ['Villavicencio', 'Acacías', 'Granada', 'Puerto López', 'Cumaral', 'Restrepo', 'Puerto Gaitán', 'San Martín'] },
  { nombre: 'Nariño', ciudades: ['Pasto', 'Tumaco', 'Ipiales', 'Túquerres', 'La Unión', 'Samaniego', 'Sandoná', 'Buesaco', 'El Charco'] },
  { nombre: 'Norte de Santander', ciudades: ['Cúcuta', 'Ocaña', 'Pamplona', 'Villa del Rosario', 'Los Patios', 'Tibú', 'El Zulia', 'Chinácota', 'Sardinata'] },
  { nombre: 'Putumayo', ciudades: ['Mocoa', 'Puerto Asís', 'Orito', 'Valle del Guamuez', 'Sibundoy', 'Villagarzón'] },
  { nombre: 'Quindío', ciudades: ['Armenia', 'Calarcá', 'La Tebaida', 'Montenegro', 'Quimbaya', 'Circasia', 'Filandia', 'Salento'] },
  { nombre: 'Risaralda', ciudades: ['Pereira', 'Dosquebradas', 'Santa Rosa de Cabal', 'La Virginia', 'Belén de Umbría', 'Marsella', 'Quinchía'] },
  { nombre: 'San Andrés y Providencia', ciudades: ['San Andrés', 'Providencia'] },
  { nombre: 'Santander', ciudades: ['Bucaramanga', 'Floridablanca', 'Girón', 'Piedecuesta', 'Barrancabermeja', 'San Gil', 'Socorro', 'Málaga', 'Vélez', 'Sabana de Torres', 'Lebrija', 'Rionegro', 'Charalá'] },
  { nombre: 'Sucre', ciudades: ['Sincelejo', 'Corozal', 'Sampués', 'San Marcos', 'Tolú', 'San Onofre', 'Coveñas', 'Los Palmitos'] },
  { nombre: 'Tolima', ciudades: ['Ibagué', 'Espinal', 'Melgar', 'Honda', 'Mariquita', 'Líbano', 'Chaparral', 'Purificación', 'Guamo', 'Flandes', 'Lérida'] },
  { nombre: 'Valle del Cauca', ciudades: ['Cali', 'Palmira', 'Buenaventura', 'Tuluá', 'Buga', 'Cartago', 'Jamundí', 'Yumbo', 'Candelaria', 'Florida', 'Pradera', 'Zarzal', 'Roldanillo', 'Sevilla', 'Caicedonia', 'El Cerrito'] },
  { nombre: 'Vaupés', ciudades: ['Mitú', 'Carurú', 'Taraira'] },
  { nombre: 'Vichada', ciudades: ['Puerto Carreño', 'La Primavera', 'Cumaribo', 'Santa Rosalía'] },
];

export const DEPARTAMENTOS_NOMBRES = DEPARTAMENTOS_CO.map(d => d.nombre);

export function getCiudadesDe(departamento: string): string[] {
  const d = DEPARTAMENTOS_CO.find(x => x.nombre.toLowerCase() === (departamento || '').toLowerCase());
  return d ? d.ciudades : [];
}
