import { describe, it, expect } from 'vitest';
import {
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
