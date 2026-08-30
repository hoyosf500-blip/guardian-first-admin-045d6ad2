import { describe, it, expect } from 'vitest';
import {
  plantillaSolucion,
  medirCobertura,
  patronesIlikeSector,
  agenciasServientrega,
  abreSabado,
  sectorSinCobertura,
  guiaOficialNovedad,
  novedadesDocumentadas,
  normalizarTransportadora,
  RETIRO_EN_OFICINA,
  INTENTOS_ENTREGA_MAX,
} from './logisticaOficial';

// Los casos vienen de direcciones REALES del histórico de la tienda de Ecuador
// (11.450 pedidos, oct-2025 → ago-2026) cruzadas con las hojas oficiales de Dropi.

describe('agencias de Servientrega habilitadas para retiro', () => {
  it('Guayaquil y Quito tienen decenas; el equipo NO puede decir "la oficina principal"', () => {
    expect(agenciasServientrega('GUAYAQUIL').length).toBeGreaterThan(40);
    expect(agenciasServientrega('Quito').length).toBeGreaterThan(100);
  });

  it('Parque California (la más usada por las operadoras) está, con dirección y horario', () => {
    const pc = agenciasServientrega('guayaquil').find((a) => a.cs === 'GUAYAQUIL_PARQUE CALIFORNIA');
    expect(pc).toBeTruthy();
    expect(pc!.direccion).toMatch(/VIA A DAULE/);
    expect(pc!.horarioLunesViernes).toMatch(/\d/);
    expect(abreSabado(pc!)).toBe(true);
  });

  it('una agencia NO habilitada para retiro no aparece aunque exista', () => {
    // AMBATO_DHL figura en la hoja con HABILITADO RETIRO = NO.
    expect(agenciasServientrega('AMBATO').some((a) => a.cs === 'AMBATO_DHL')).toBe(false);
    expect(agenciasServientrega('AMBATO').length).toBeGreaterThan(10);
  });

  it('acentos y paréntesis no rompen la búsqueda; ciudad desconocida devuelve vacío, no explota', () => {
    expect(agenciasServientrega('Santo Domingo').length).toBeGreaterThan(0);
    expect(agenciasServientrega('SALINAS (SANTA ELENA)').length).toBeGreaterThan(0);
    expect(agenciasServientrega('Ciudad Inventada')).toEqual([]);
    expect(agenciasServientrega(null)).toEqual([]);
  });
});

describe('sectores sin cobertura a domicilio', () => {
  it('Bastión Popular (Guayaquil) → Servientrega lo manda a Parque California', () => {
    const r = sectorSinCobertura('Bastión Popular bloque 5, mz 1601 solar 13', 'GUAYAQUIL');
    expect(r).toBeTruthy();
    expect(r!.sector).toMatch(/BASTION POPULAR/);
    expect(r!.agencia).toBe('PARQUE CALIFORNIA');
    expect(r!.agenciaDetalle?.direccion).toMatch(/VIA A DAULE/);
  });

  it('Monte Sinaí y Flor de Bastión (0 de 5 entregados en 2 años) se detectan', () => {
    expect(sectorSinCobertura('Coop. Monte Sinaí, mz 3 solar 4, detrás de la iglesia', 'Guayaquil')?.sector).toMatch(/MONTE SINAI/);
    expect(sectorSinCobertura('Flor de Bastión bloque 10', 'GUAYAQUIL')?.sector).toMatch(/FLOR DE BASTION/);
  });

  it('Coop. Luz del Día (Santo Domingo, 37 pedidos en el histórico) se detecta', () => {
    const r = sectorSinCobertura('cooperativa Luz del Día, casa de dos pisos', 'SANTO DOMINGO');
    expect(r?.sector).toMatch(/LUZ DEL DIA/);
    expect(r?.agencia).toBeTruthy();
  });

  it('una dirección normal NO matchea (el falso positivo manda a la agencia a quien recibía en casa)', () => {
    expect(sectorSinCobertura('Av. Francisco de Orellana y Juan Tanca Marengo, edificio Torres del Norte', 'GUAYAQUIL')).toBeNull();
    expect(sectorSinCobertura('Sn, Sun número', 'MACHALA')).toBeNull();
    expect(sectorSinCobertura('Calle Bolívar y Rocafuerte', 'LOJA')).toBeNull();
  });

  it('el sector de OTRA ciudad no cuenta, y sin ciudad no se afirma nada', () => {
    // "Bastión Popular" es de Guayaquil; escrito en un pedido de Cuenca es otra cosa.
    expect(sectorSinCobertura('Bastión Popular bloque 5', 'CUENCA')).toBeNull();
    expect(sectorSinCobertura('Bastión Popular bloque 5', null)).toBeNull();
    expect(sectorSinCobertura(null, 'GUAYAQUIL')).toBeNull();
  });

  it('con dos candidatos gana el más específico', () => {
    const r = sectorSinCobertura('Guasmo Sur, coop. Batalla de Tarqui, mz 5', 'GUAYAQUIL');
    expect(r?.sector).toMatch(/BATALLA DE TARQUI/);
  });
});

describe('guía oficial de novedades por transportadora', () => {
  it('Servientrega «DIRECCIÓN INCORRECTA» trae qué significa, cómo responder y qué NO hacer', () => {
    const g = guiaOficialNovedad('DIRECCIÓN INCORRECTA', 'SERVIENTREGA');
    expect(g).toBeTruthy();
    expect(g!.transportadora).toBe('SERVIENTREGA');
    expect(g!.comoResponder).toMatch(/calle principal y secundaria/i);
    expect(g!.queNoHacer.length).toBeGreaterThan(10);
  });

  it('el texto real del carrier trae ruido alrededor y aun así encuentra la ficha', () => {
    const g = guiaOficialNovedad('NOVEDAD: NO CONTESTA LAS LLAMADAS - 2do intento', 'Servientrega');
    expect(g?.novedad).toMatch(/NO CONTESTA LAS LLAMADAS/);
  });

  it('la misma novedad se responde distinto según la transportadora', () => {
    const se = guiaOficialNovedad('ZONA DE ALTO RIESGO', 'SERVIENTREGA');
    const laar = guiaOficialNovedad('ZONA PELIGROSA', 'LAARCOURIER');
    expect(se?.transportadora).toBe('SERVIENTREGA');
    expect(laar?.transportadora).toBe('LAARCOURIER');
    expect(se?.comoResponder).toMatch(/oficina/i);
  });

  it('Gintracom: las novedades operativas NO NECESITAN RESPUESTA y la ficha lo dice', () => {
    const g = guiaOficialNovedad('PROBLEMAS DE ORDEN PÚBLICO', 'GINTRACOM');
    expect(g?.queNoHacer).toMatch(/NO NECESITA RESPUESTA/i);
  });

  it('un texto que no se parece a nada devuelve null (no inventa una ficha)', () => {
    expect(guiaOficialNovedad('xyz', 'SERVIENTREGA')).toBeNull();
    expect(guiaOficialNovedad('EL CLIENTE PIDE FACTURA ELECTRÓNICA DEL MES PASADO', 'VELOCES')).toBeNull();
    expect(guiaOficialNovedad('', 'SERVIENTREGA')).toBeNull();
  });

  it('las cinco transportadoras están documentadas', () => {
    for (const t of ['SERVIENTREGA', 'LAARCOURIER', 'GINTRACOM', 'VELOCES', 'URBANO']) {
      expect(novedadesDocumentadas(t).length).toBeGreaterThan(10);
    }
  });
});

describe('reglas oficiales por transportadora', () => {
  it('normaliza los nombres como vienen de Dropi', () => {
    expect(normalizarTransportadora('Servientrega')).toBe('SERVIENTREGA');
    expect(normalizarTransportadora('LAAR COURIER')).toBe('LAARCOURIER');
    expect(normalizarTransportadora('gintracom')).toBe('GINTRACOM');
    expect(normalizarTransportadora('')).toBeNull();
    expect(normalizarTransportadora(undefined)).toBeNull();
  });

  it('solo Servientrega, Laar y Urbano hacen retiro en oficina — Gintracom y Veloces NO', () => {
    expect(RETIRO_EN_OFICINA.SERVIENTREGA.permite).toBe(true);
    expect(RETIRO_EN_OFICINA.SERVIENTREGA.diasMaximo).toBe(7);
    expect(RETIRO_EN_OFICINA.LAARCOURIER.diasMaximo).toBe(5);
    expect(RETIRO_EN_OFICINA.GINTRACOM.permite).toBe(false);
    expect(RETIRO_EN_OFICINA.VELOCES.permite).toBe(false);
    expect(INTENTOS_ENTREGA_MAX.SERVIENTREGA).toBe(2);
  });
});

describe('cobertura MEDIDA con los pedidos de la tienda (manda sobre la lista de Dropi)', () => {
  const filas = [
    { estado: 'ENTREGADO', transportadora: 'SERVIENTREGA', direccion: 'Bastión Popular bloque 3 mz 1234 sl 5' },
    { estado: 'DEVOLUCION', transportadora: 'SERVIENTREGA', direccion: 'BASTION POPULAR BLOQUE 1B' },
    { estado: 'DEVOLUCION EN TRANSITO', transportadora: 'Servientrega', direccion: 'bastion popular bloque 7' },
    { estado: 'ENTREGADO', transportadora: 'LAARCOURIER', direccion: 'Bastión Popular bloque 2, casa verde' },
    { estado: 'ENTREGADO', transportadora: 'LAAR COURIER', direccion: 'Bastion Popular bloque 10' },
    // No cuentan: cancelado, en ruta, retiro en agencia, otro sector, sin dirección
    { estado: 'CANCELADO', transportadora: 'SERVIENTREGA', direccion: 'Bastión Popular bloque 4' },
    { estado: 'EN TRANSITO', transportadora: 'SERVIENTREGA', direccion: 'Bastión Popular bloque 5' },
    { estado: 'ENTREGADO', transportadora: 'SERVIENTREGA', direccion: 'RETIRO CS GUAYAQUIL_PARQUE CALIFORNIA - km 10.5 via daule (bastion popular)' },
    { estado: 'ENTREGADO', transportadora: 'SERVIENTREGA', direccion: 'Flor de Bastión bloque 9' },
    { estado: 'ENTREGADO', transportadora: 'SERVIENTREGA', direccion: null },
  ];
  const SECTOR = 'BASTION POPULAR TODOS LOS BLOQUES';

  it('cuenta solo terminales a domicilio de ESE sector, con tilde o sin tilde, y separa por transportadora', () => {
    const m = medirCobertura(filas, 'GUAYAQUIL', SECTOR);
    expect(m.entregados).toBe(3);
    expect(m.devueltos).toBe(2);
    expect(m.terminales).toBe(5);
    expect(m.veredicto).toBe('entregamos');
    expect(m.porTransportadora).toEqual([
      { transportadora: 'SERVIENTREGA', entregados: 1, devueltos: 2 },
      { transportadora: 'LAARCOURIER', entregados: 2, devueltos: 0 },
    ]);
    expect(m.mejorAlternativa).toBe('LAARCOURIER');
  });

  it('con menos de 3 terminales NO afirma nada (un 0 de 1 no es «no llega»)', () => {
    const m = medirCobertura(filas.slice(0, 2), 'GUAYAQUIL', SECTOR);
    expect(m.terminales).toBe(2);
    expect(m.veredicto).toBe('sin_dato');
    expect(medirCobertura([], 'GUAYAQUIL', SECTOR).tasa).toBeNull();
  });

  it('no_llega solo por debajo del 45% con 3+ terminales', () => {
    const m = medirCobertura(filas.slice(0, 3), 'GUAYAQUIL', SECTOR);
    expect(m.terminales).toBe(3);
    expect(m.veredicto).toBe('no_llega');
    expect(m.mejorAlternativa).toBeNull();
  });

  it('el patrón ILIKE pesca la tilde y la Ñ; lo que trae de más lo descarta el filtro fino', () => {
    const p = patronesIlikeSector(SECTOR);
    expect(p).toEqual(['%B_ST___%', '%P_P_L_R%']);
    const like = (s: string, pat: string) =>
      new RegExp('^' + pat.replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i').test(s);
    expect(like('Bastión Popular bloque 3', p[0])).toBe(true);
    expect(like('bastion popular', p[1])).toBe(true);
    expect(patronesIlikeSector('COOP. RUMIÑAHUI LA LOZA')[0]).toBe('%R_M___H__%');
    // Un sector sin palabra usable no manda a la base a buscar «todo».
    expect(patronesIlikeSector('7')).toEqual([]);
  });
});

describe('plantilla de solución según la guía oficial de Dropi', () => {
  const pedido = { phone: '0991234567', nombre: 'Ana Pérez', direccion: 'Calle 4A Mz 6' };

  it('rellena el ejemplo oficial de Servientrega con el teléfono y deja huecos para lo que decide la asesora', () => {
    const g = guiaOficialNovedad('NO HAY QUIEN RECIBA', 'SERVIENTREGA');
    expect(g).not.toBeNull();
    const p = plantillaSolucion(g, pedido, 'SERVIENTREGA');
    expect(p.origen).toBe('oficial');
    expect(p.texto).toMatch(/^Me he comunicado con el cliente, al numero 0991234567/);
    expect(p.texto).toContain('preguntar por Ana Pérez');
    expect(p.texto).not.toMatch(/\*{3,}/);
    expect(p.texto).not.toMatch(/no mayor a 24 horas la proxima/i);
    expect(p.maximo).toBe(500);
  });

  it('Gintracom: borrador corto porque Dropi limita a 50 caracteres', () => {
    const g = guiaOficialNovedad('DESTINATARIO NO CONTESTA LLAMADAS NI WHATSAPP', 'GINTRACOM');
    const p = plantillaSolucion(g, pedido, 'GINTRACOM');
    expect(p.maximo).toBe(50);
    expect(p.texto.length).toBeLessThanOrEqual(50);
  });

  it('sin ficha (LAAR con novedad vacía) da el genérico con el teléfono, nunca vacío', () => {
    const p = plantillaSolucion(null, pedido, 'LAARCOURIER');
    expect(p.origen).toBe('generica');
    expect(p.texto).toContain('0991234567');
    expect(p.texto).toContain('____');
  });
});

describe('alias: lo que Dropi escribe de verdad en orders.novedad también tiene ficha', () => {
  it('«NO RECLAMO EN OFICINA» (SE) va a la ficha oficial de retiro en agencia', () => {
    const g = guiaOficialNovedad('NO RECLAMO EN OFICINA', 'SERVIENTREGA');
    expect(g?.novedad).toMatch(/PARA RETIRO EN AGENCIA SERVIENTREGA/);
  });
  it('«DEVUELTO DE» / «DEVOLUCION DE DISTRIBUCION» / «ENVIO CON NOVEDAD» (SE) tienen ficha sintética que manda a hablar con el cliente', () => {
    for (const n of ['DEVUELTO DE', 'DEVOLUCION DE DISTRIBUCION', 'ENVIO CON NOVEDAD']) {
      const g = guiaOficialNovedad(n, 'SERVIENTREGA');
      expect(g?.transportadora).toBe('SERVIENTREGA');
      expect(g?.comoResponder).toMatch(/habl[áa] con el cliente/i);
      expect(g?.queNoHacer).toMatch(/volver a ofrecer/i);
    }
  });
  it('«DEVOLUCION AL REMITENTE» (SE): ya no admite solución', () => {
    expect(guiaOficialNovedad('DEVOLUCION AL REMITENTE', 'SERVIENTREGA')?.comoResponder).toMatch(/No hay solución/);
  });
  it('LAAR con novedad vacía: ficha que explica que Dropi no tiene incidencia', () => {
    const g = guiaOficialNovedad('', 'LAARCOURIER');
    expect(g?.transportadora).toBe('LAARCOURIER');
    expect(g?.significado).toMatch(/no le pasó a Dropi/);
    // Servientrega con novedad vacía sigue sin ficha: no se inventa.
    expect(guiaOficialNovedad('', 'SERVIENTREGA')).toBeNull();
  });
});
