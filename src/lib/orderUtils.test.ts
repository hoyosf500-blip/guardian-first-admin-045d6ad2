import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  dbToOrderData,
  parseDate,
  calcDias,
  calcBusinessDays,
  setTrackingCountry,
  isWithinLastDays,
  isClosedOutByCloser,
  parseMoney,
  cleanPhone,
  formatPhone,
  getWhatsAppPhone,
  isPendiente,
  isDespachado,
  isConfirmado,
  isNovedad,
  isOficina,
  isDevolucion,
  getTrackingUrl,
  truncate,
  getErrorMessage,
  normalizeColombianPhone,
  isValidColombianPhone,
  isValidEcuadorianPhone,
  normalizeEcuadorianPhone,
  isValidPhoneForCountry,
} from './orderUtils';

describe('parseDate', () => {
  it('parses ISO format YYYY-MM-DD', () => {
    const d = parseDate('2026-04-15');
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2026);
    expect(d!.getUTCMonth()).toBe(3); // April = 3
    expect(d!.getUTCDate()).toBe(15);
  });

  it('parses DD/MM/YYYY format', () => {
    const d = parseDate('15/04/2026');
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2026);
    expect(d!.getUTCMonth()).toBe(3);
    expect(d!.getUTCDate()).toBe(15);
  });

  it('parses DD-MM-YYYY format', () => {
    const d = parseDate('15-04-2026');
    expect(d).not.toBeNull();
    expect(d!.getUTCDate()).toBe(15);
  });

  it('handles 2-digit years', () => {
    const d = parseDate('15/04/26');
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2026);
  });

  it('returns null for empty/invalid strings', () => {
    expect(parseDate('')).toBeNull();
    expect(parseDate('undefined')).toBeNull();
    expect(parseDate('not-a-date')).toBeNull();
  });
});

describe('calcDias', () => {
  it('returns 0 for today', () => {
    const today = new Date().toISOString().split('T')[0];
    expect(calcDias(today)).toBe(0);
  });

  it('returns 0 for invalid dates', () => {
    expect(calcDias('')).toBe(0);
    expect(calcDias('garbage')).toBe(0);
  });

  it('returns positive days for past dates', () => {
    const past = new Date(Date.now() - 5 * 86400000).toISOString().split('T')[0];
    const dias = calcDias(past);
    expect(dias).toBeGreaterThanOrEqual(4);
    expect(dias).toBeLessThanOrEqual(6);
  });
});

describe('isWithinLastDays', () => {
  // nowMs fijo para que el test sea determinista (no depende del reloj real).
  const NOW = Date.UTC(2026, 5, 26, 12, 0, 0); // 2026-06-26 mediodía UTC

  it('incluye una fecha de hoy', () => {
    expect(isWithinLastDays('2026-06-26', 45, NOW)).toBe(true);
  });

  it('incluye una fecha del mes anterior dentro de la ventana (cross-month)', () => {
    // 2026-05-20 está a ~37 días → dentro de 45.
    expect(isWithinLastDays('2026-05-20', 45, NOW)).toBe(true);
    expect(isWithinLastDays('20/05/2026', 45, NOW)).toBe(true); // DD/MM/YYYY
  });

  it('excluye una fecha más vieja que la ventana', () => {
    // 2026-04-01 está a ~86 días → fuera de 45.
    expect(isWithinLastDays('2026-04-01', 45, NOW)).toBe(false);
  });

  it('incluye lo de hace 44 días y excluye lo de hace 46', () => {
    const d44 = new Date(NOW - 44 * 86400000).toISOString().slice(0, 10);
    const d46 = new Date(NOW - 46 * 86400000).toISOString().slice(0, 10);
    expect(isWithinLastDays(d44, 45, NOW)).toBe(true);
    expect(isWithinLastDays(d46, 45, NOW)).toBe(false);
  });

  it('una fecha sin parsear se incluye (no esconder por las dudas)', () => {
    expect(isWithinLastDays('', 45, NOW)).toBe(true);
    expect(isWithinLastDays('garbage', 45, NOW)).toBe(true);
    expect(isWithinLastDays(null, 45, NOW)).toBe(true);
    expect(isWithinLastDays(undefined, 45, NOW)).toBe(true);
  });
});

describe('isClosedOutByCloser', () => {
  const creado = '2026-05-01';
  const bogotaStart = Date.UTC(2026, 4, 1) + 5 * 3600 * 1000; // medianoche Bogotá del 2026-05-01

  it('sin cierre → no está cerrado (visible)', () => {
    expect(isClosedOutByCloser(creado, undefined)).toBe(false);
  });

  it('cierre en/después de la creación (hora Bogotá) → cerrado (se esconde)', () => {
    expect(isClosedOutByCloser(creado, bogotaStart + 3 * 86400000)).toBe(true);       // 3 días después
    expect(isClosedOutByCloser(creado, bogotaStart + 10 * 3600 * 1000)).toBe(true);   // mismo día, más tarde
    expect(isClosedOutByCloser(creado, bogotaStart)).toBe(true);                      // justo a medianoche Bogotá
  });

  it('cierre de la NOCHE anterior (hora Bogotá) NO esconde un pedido del día siguiente', () => {
    // 2h antes de la medianoche-Bogotá del día de creación = noche previa → no esconde.
    expect(isClosedOutByCloser(creado, bogotaStart - 2 * 3600 * 1000)).toBe(false);
  });

  it('cierre ANTERIOR a la creación → NO cerrado (pedido nuevo de cliente repetido)', () => {
    expect(isClosedOutByCloser(creado, bogotaStart - 10 * 86400000)).toBe(false);
  });

  it('acepta DD/MM/YYYY igual que ISO', () => {
    expect(isClosedOutByCloser('01/05/2026', bogotaStart + 86400000)).toBe(true);
  });

  it('fecha sin parsear → NO se esconde (preferimos mostrar; consistente con isWithinLastDays)', () => {
    expect(isClosedOutByCloser('', bogotaStart)).toBe(false);
    expect(isClosedOutByCloser('garbage', bogotaStart)).toBe(false);
    expect(isClosedOutByCloser(null, bogotaStart)).toBe(false);
  });

  it('pedido VIVO EN TRÁNSITO no se esconde por el cierre de un hermano del teléfono', () => {
    // Regresión auditoría 2026-07-14: un pedido EN REPARTO/NOVEDAD/OFICINA es un
    // envío distinto vivo — no debe desaparecer del tablero por un closer del phone.
    const cerrado = bogotaStart + 3 * 86400000; // cierre posterior → sin el guard escondería
    expect(isClosedOutByCloser(creado, cerrado, 'EN REPARTO')).toBe(false);
    expect(isClosedOutByCloser(creado, cerrado, 'NOVEDAD')).toBe(false);
    expect(isClosedOutByCloser(creado, cerrado, 'RECLAME EN OFICINA')).toBe(false);
    // Estado terminal/entregado SÍ se esconde (ya no necesita seguimiento).
    expect(isClosedOutByCloser(creado, cerrado, 'ENTREGADO')).toBe(true);
    // Sin estado (llamadas viejas de 2 args) → comportamiento intacto.
    expect(isClosedOutByCloser(creado, cerrado)).toBe(true);
  });

  it('reconoce estados EC y "GUIA GENERADA" con espacio como VIVOS (auditoría 2026-07-31)', () => {
    // El guard viejo usaba isDespachado/isNovedad/isOficina (CO-céntricos): un
    // pedido EC 'EN RUTA A CENTRO LOGISTICO' desaparecía del tablero de todas
    // las asesoras cuando se cerraba un hermano del mismo teléfono.
    const cerrado = bogotaStart + 3 * 86400000;
    expect(isClosedOutByCloser(creado, cerrado, 'EN RUTA A CENTRO LOGISTICO')).toBe(false); // EC
    expect(isClosedOutByCloser(creado, cerrado, 'INGRESANDO OPERATIVO A QUITO')).toBe(false); // EC
    expect(isClosedOutByCloser(creado, cerrado, 'ASIGNADO A GINTRACOM')).toBe(false); // EC
    expect(isClosedOutByCloser(creado, cerrado, 'PARA RETIRO EN AGENCIA SERVIENTREGA')).toBe(false); // EC
    expect(isClosedOutByCloser(creado, cerrado, 'GUIA GENERADA')).toBe(false); // espacio (Dropi manda ambas)
    expect(isClosedOutByCloser(creado, cerrado, 'GUIA_GENERADA')).toBe(false); // guion bajo
    // Lógica invertida: solo estados TERMINALES se esconden; un estado que
    // Dropi invente mañana cae en 'otros' y se trata como vivo (visible).
    expect(isClosedOutByCloser(creado, cerrado, 'DEVOLUCION')).toBe(true);
    expect(isClosedOutByCloser(creado, cerrado, 'CANCELADO')).toBe(true);
    expect(isClosedOutByCloser(creado, cerrado, 'ESTADO_RARO_NUEVO')).toBe(false);
  });
});

describe('parseMoney', () => {
  it('formato CO con punto de miles: "$ 79.900" → 79900 (no 79.9)', () => {
    // Regresión auditoría 2026-07-31: el parser viejo dividía por ~1.000 los
    // montos formateados como moneda al re-guardar el Excel.
    expect(parseMoney('$ 79.900')).toBe(79900);
    expect(parseMoney('79.900')).toBe(79900);
  });

  it('formato CO con varios puntos: "$ 1.234.567" → 1234567 (no 1.234)', () => {
    expect(parseMoney('$ 1.234.567')).toBe(1234567);
    expect(parseMoney('1.234.567')).toBe(1234567);
  });

  it('formato EC con coma decimal: "4.734,53" → 4734.53', () => {
    expect(parseMoney('4.734,53')).toBe(4734.53);
    expect(parseMoney('$ 4.734,53')).toBe(4734.53);
    expect(parseMoney('4734,53')).toBe(4734.53);
  });

  it('formato anglo: "1,234.56" → 1234.56 y "1,234,567" → 1234567', () => {
    expect(parseMoney('1,234.56')).toBe(1234.56);
    expect(parseMoney('1,234,567')).toBe(1234567);
  });

  it('decimales legítimos con punto NO se tratan como miles', () => {
    expect(parseMoney('4.99')).toBe(4.99);   // USD EC
    expect(parseMoney('150.5')).toBe(150.5);
  });

  it('números crudos y strings planos quedan intactos', () => {
    expect(parseMoney(150000)).toBe(150000);
    expect(parseMoney('150000')).toBe(150000);
    expect(parseMoney(4.99)).toBe(4.99);
  });

  it('vacío / basura / null → 0 (mismo fallback que el parser viejo)', () => {
    expect(parseMoney('')).toBe(0);
    expect(parseMoney('N/A')).toBe(0);
    expect(parseMoney(null)).toBe(0);
    expect(parseMoney(undefined)).toBe(0);
    expect(parseMoney(NaN)).toBe(0);
  });
});

describe('calcBusinessDays por país (festivos CO vs EC)', () => {
  afterEach(() => {
    vi.useRealTimers();
    setTrackingCountry('CO'); // no filtrar estado module-level a otros tests
  });

  it('20-jul (festivo SOLO CO) no cuenta en CO pero SÍ en EC', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 22, 12))); // miércoles 22-jul-2026
    // Desde el viernes 17-jul: sáb/dom no cuentan; lun 20 es festivo CO
    // (Grito de Independencia) pero día laboral normal en Ecuador.
    expect(calcBusinessDays('2026-07-17')).toBe(2);        // CO: mar 21 + mié 22
    expect(calcBusinessDays('2026-07-17', 'EC')).toBe(3);  // EC: lun 20 + mar 21 + mié 22
  });

  it('10-ago (feriado SOLO EC) cuenta en CO pero no en EC', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 12, 12))); // miércoles 12-ago-2026
    // Desde el viernes 7-ago: lun 10 es Primer Grito de Independencia (EC).
    expect(calcBusinessDays('2026-08-07')).toBe(3);        // CO: lun 10 + mar 11 + mié 12
    expect(calcBusinessDays('2026-08-07', 'EC')).toBe(2);  // EC: mar 11 + mié 12
  });

  it('Carnaval EC 2026 (lun 16 / mar 17 feb) resta 2 días hábiles solo en EC', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 1, 19, 12))); // jueves 19-feb-2026
    expect(calcBusinessDays('2026-02-13')).toBe(4);        // CO: lun-jue normales
    expect(calcBusinessDays('2026-02-13', 'EC')).toBe(2);  // EC: solo mié 18 + jue 19
  });

  it('sin countryCode explícito hereda el país de la tienda activa (setTrackingCountry)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 22, 12)));
    setTrackingCountry('EC');
    // Mismo cálculo del primer test pero SIN pasar el país: los call-sites de
    // Seguimiento (segLists/CrmTable/SegBoard) heredan el calendario EC solos.
    expect(calcBusinessDays('2026-07-17')).toBe(3);
  });

  it('festivos móviles CO (Semana Santa) se excluyen en fecha correcta', () => {
    // El fmt viejo usaba getters LOCALES sobre fechas UTC-midnight: en un host
    // UTC-5 los festivos móviles (Emiliani/Pascua) quedaban corridos un día y
    // NO se excluían. Pascua 2026 = 5-abr → Jue Santo 2-abr, Vie Santo 3-abr.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 3, 7, 12))); // martes 7-abr-2026
    expect(calcBusinessDays('2026-04-01')).toBe(2);       // CO: lun 6 + mar 7
    expect(calcBusinessDays('2026-04-01', 'EC')).toBe(3); // EC: jue 2 (labora) + lun 6 + mar 7
  });
});

describe('cleanPhone', () => {
  it('strips non-numeric characters', () => {
    expect(cleanPhone('+57 311 234 5678')).toBe('573112345678');
    expect(cleanPhone('(311) 234-5678')).toBe('3112345678');
  });

  it('handles already-clean phones', () => {
    expect(cleanPhone('3112345678')).toBe('3112345678');
  });
});

describe('formatPhone', () => {
  it('formats 10-digit Colombian numbers', () => {
    expect(formatPhone('3112345678')).toBe('311 234 5678');
  });

  it('returns as-is for non-10-digit numbers', () => {
    expect(formatPhone('573112345678')).toBe('573112345678');
    expect(formatPhone('12345')).toBe('12345');
  });
});

describe('getWhatsAppPhone', () => {
  it('prepends 57 to 10-digit numbers', () => {
    expect(getWhatsAppPhone('3112345678')).toBe('573112345678');
  });

  it('keeps 12-digit numbers starting with 57', () => {
    expect(getWhatsAppPhone('573112345678')).toBe('573112345678');
  });

  it('handles numbers with spaces/dashes', () => {
    expect(getWhatsAppPhone('311 234 5678')).toBe('573112345678');
  });
});

describe('status checkers', () => {
  describe('isPendiente', () => {
    it('matches PENDIENTE CONFIRMACION', () => {
      expect(isPendiente('PENDIENTE CONFIRMACION')).toBe(true);
      expect(isPendiente('pendiente confirmacion')).toBe(true);
    });
    it('rejects other states', () => {
      expect(isPendiente('PENDIENTE')).toBe(false);
      expect(isPendiente('ENTREGADO')).toBe(false);
    });
  });

  describe('isDespachado', () => {
    it('matches dispatch-related states', () => {
      expect(isDespachado('EN REPARTO')).toBe(true);
      expect(isDespachado('EN DISTRIBUCION')).toBe(true);
      expect(isDespachado('ADMITIDA')).toBe(true);
      expect(isDespachado('DESPACHADO')).toBe(true);
    });
    it('rejects non-dispatch states', () => {
      expect(isDespachado('PENDIENTE')).toBe(false);
      expect(isDespachado('NOVEDAD')).toBe(false);
    });
  });

  describe('isConfirmado', () => {
    it('matches confirmed-waiting states', () => {
      expect(isConfirmado('PENDIENTE')).toBe(true);
      expect(isConfirmado('ALISTAMIENTO')).toBe(true);
      expect(isConfirmado('EN BODEGA DROPI')).toBe(true);
    });
  });

  describe('isNovedad', () => {
    it('matches novedad and intento de entrega', () => {
      expect(isNovedad('NOVEDAD')).toBe(true);
      expect(isNovedad('INTENTO DE ENTREGA')).toBe(true);
    });
    it('rejects other states', () => {
      expect(isNovedad('ENTREGADO')).toBe(false);
    });
  });

  describe('isOficina', () => {
    it('matches office states', () => {
      expect(isOficina('RECLAME EN OFICINA')).toBe(true);
    });
  });

  describe('isDevolucion', () => {
    it('matches return states', () => {
      expect(isDevolucion('DEVOLUCION')).toBe(true);
      expect(isDevolucion('EN DEVOLUCION')).toBe(true);
    });
  });
});

describe('getTrackingUrl', () => {
  it('returns URL for known carriers', () => {
    const url = getTrackingUrl('TCC', '12345');
    expect(url).not.toBeNull();
    expect(url).toContain('tcc.com.co');
  });

  it('appends guia for carriers with = suffix', () => {
    const url = getTrackingUrl('ENVIA', '12345');
    expect(url).not.toBeNull();
    expect(url).toContain('12345');
  });

  it('returns null for unknown carriers', () => {
    expect(getTrackingUrl('DESCONOCIDA', '12345')).toBeNull();
  });
});

describe('dbToOrderData', () => {
  it('maps DB row fields to OrderData', () => {
    const row = {
      id: 'uuid-123',
      external_id: 'EXT-456',
      nombre: 'Juan',
      phone: '3112345678',
      ciudad: 'Bogotá',
      producto: 'Crema',
      estado: 'PENDIENTE',
      fecha: '2026-04-10',
      fecha_conf: '2026-04-11',
      dias: 5,
      dias_conf: 4,
      valor: 50000,
      flete: 8000,
      costo_prod: 15000,
      costo_dev: 5000,
      cantidad: 2,
      direccion: 'Calle 1 # 2-3',
      novedad: '',
      guia: 'G123',
      transportadora: 'TCC',
      tags: '',
      departamento: 'Cundinamarca',
      tienda: 'Mi tienda',
      novedad_sol: false,
    };
    const order = dbToOrderData(row, 0);
    expect(order.dbId).toBe('uuid-123');
    expect(order.externalId).toBe('EXT-456');
    expect(order.nombre).toBe('Juan');
    expect(order.valor).toBe(50000);
    expect(order.cantidad).toBe(2);
    expect(order.novedadSol).toBe(false);
  });

  it('handles missing fields with defaults', () => {
    const row = { id: 'x', nombre: 'Ana', phone: '311' };
    const order = dbToOrderData(row, 5);
    expect(order.idx).toBe(5);
    expect(order.externalId).toBe('');
    expect(order.estado).toBe('');
    expect(order.valor).toBe(0);
    expect(order.cantidad).toBe(1);
    expect(order.novedadSol).toBe(false);
  });
});

describe('truncate', () => {
  it('truncates long strings', () => {
    expect(truncate('Hello World', 5)).toBe('Hello…');
  });

  it('returns short strings unchanged', () => {
    expect(truncate('Hi', 10)).toBe('Hi');
  });
});

describe('getErrorMessage', () => {
  it('extracts message from Error instance', () => {
    expect(getErrorMessage(new Error('test fail'))).toBe('test fail');
  });

  it('returns string errors as-is', () => {
    expect(getErrorMessage('network down')).toBe('network down');
  });

  it('returns fallback for null', () => {
    expect(getErrorMessage(null)).toBe('Error desconocido');
  });

  it('returns fallback for undefined', () => {
    expect(getErrorMessage(undefined)).toBe('Error desconocido');
  });

  it('returns fallback for numeric errors', () => {
    expect(getErrorMessage(42)).toBe('Error desconocido');
  });

  it('returns fallback for object errors', () => {
    expect(getErrorMessage({ code: 500 })).toBe('Error desconocido');
  });
});

describe('dbToOrderData typed', () => {
  it('handles fully null DB row gracefully', () => {
    const order = dbToOrderData({}, 0);
    expect(order.nombre).toBe('');
    expect(order.phone).toBe('');
    expect(order.valor).toBe(0);
    expect(order.novedadSol).toBe(false);
    expect(order.externalId).toBe('');
    expect(order.dbId).toBeUndefined();
  });

  it('preserves valid DB values', () => {
    const order = dbToOrderData({
      id: 'db-123',
      external_id: 'EXT-456',
      nombre: 'Maria',
      phone: '3101234567',
      valor: 85000,
      estado: 'EN REPARTO',
      transportadora: 'TCC',
      novedad_sol: true,
    }, 5);
    expect(order.dbId).toBe('db-123');
    expect(order.externalId).toBe('EXT-456');
    expect(order.nombre).toBe('Maria');
    expect(order.valor).toBe(85000);
    expect(order.estado).toBe('EN REPARTO');
    expect(order.novedadSol).toBe(true);
    expect(order.idx).toBe(5);
  });
});

describe('normalizeColombianPhone', () => {
  it('canónico de 10 dígitos arrancando con 3 → queda igual', () => {
    expect(normalizeColombianPhone('3229372886')).toBe('3229372886');
  });

  it('con prefijo 57 (12 dígitos) → strip 57', () => {
    // Reportado 2026-05-05: cliente Cristian Mendez escribió "573229372886"
    // y la confirmación quedaba bloqueada. Este test asegura que esa entrada
    // se normaliza a la canónica 10-dígitos.
    expect(normalizeColombianPhone('573229372886')).toBe('3229372886');
  });

  it('con +57 y espacios → strip todo', () => {
    expect(normalizeColombianPhone('+57 322 937 2886')).toBe('3229372886');
  });

  it('con 57, paréntesis y guion → strip todo', () => {
    expect(normalizeColombianPhone('57 (322) 937-2886')).toBe('3229372886');
  });

  it('9 dígitos → null (incompleto)', () => {
    expect(normalizeColombianPhone('229372886')).toBeNull();
  });

  it('11 dígitos arrancando con 3 → null (no es ni canónico ni con 57)', () => {
    expect(normalizeColombianPhone('33229372886')).toBeNull();
  });

  it('10 dígitos arrancando con 6 (fijo) → null', () => {
    expect(normalizeColombianPhone('6012345678')).toBeNull();
  });

  it('12 dígitos arrancando con 57 pero no con 3 después → null', () => {
    // "576012345678" — código país 57 + fijo 60... — no es móvil válido.
    expect(normalizeColombianPhone('576012345678')).toBeNull();
  });

  it('cadena vacía → null', () => {
    expect(normalizeColombianPhone('')).toBeNull();
  });

  it('solo letras → null', () => {
    expect(normalizeColombianPhone('abcdefghij')).toBeNull();
  });
});

describe('isValidColombianPhone', () => {
  it('formas válidas devuelven true', () => {
    expect(isValidColombianPhone('3229372886')).toBe(true);
    expect(isValidColombianPhone('573229372886')).toBe(true);
    expect(isValidColombianPhone('+57 322 937 2886')).toBe(true);
  });

  it('formas inválidas devuelven false', () => {
    expect(isValidColombianPhone('229372886')).toBe(false);
    expect(isValidColombianPhone('6012345678')).toBe(false);
    expect(isValidColombianPhone('')).toBe(false);
  });
});

describe('isValidEcuadorianPhone', () => {
  it('formas válidas devuelven true', () => {
    expect(isValidEcuadorianPhone('983364222')).toBe(true);       // 9 díg
    expect(isValidEcuadorianPhone('0983364222')).toBe(true);      // trunk 0
    expect(isValidEcuadorianPhone('593983364222')).toBe(true);    // país
    expect(isValidEcuadorianPhone('+593 98 336 4222')).toBe(true);
  });
  it('formas inválidas devuelven false', () => {
    expect(isValidEcuadorianPhone('3229372886')).toBe(false);     // móvil CO
    expect(isValidEcuadorianPhone('83364222')).toBe(false);       // no empieza en 9
    expect(isValidEcuadorianPhone('')).toBe(false);
  });
  it('normaliza a forma canónica de 9 díg', () => {
    expect(normalizeEcuadorianPhone('0983364222')).toBe('983364222');
    expect(normalizeEcuadorianPhone('593983364222')).toBe('983364222');
  });
});

describe('isValidPhoneForCountry', () => {
  it('despacha por país de la tienda', () => {
    expect(isValidPhoneForCountry('983364222', 'EC')).toBe(true);
    expect(isValidPhoneForCountry('983364222', 'CO')).toBe(false);
    expect(isValidPhoneForCountry('3229372886', 'CO')).toBe(true);
    expect(isValidPhoneForCountry('3229372886', 'EC')).toBe(false);
    expect(isValidPhoneForCountry('3229372886')).toBe(true); // default CO
  });
});
