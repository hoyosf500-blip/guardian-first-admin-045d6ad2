import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PRIORIDAD_RIESGO, RIESGO_INFO, normalizarRiesgo, type NivelRiesgo } from '@/lib/riesgoChat';

// PRUEBA GUARDIANA. `src/lib/riesgoChat.ts` es un ESPEJO de
// `supabase/functions/_shared/senalConfirmacion.ts`: el servidor deriva el nivel
// y lo escribe en `orders.chat_riesgo`; el cliente lo lee y lo dibuja. Producción
// no puede importar cruzando ese límite (Deno de un lado, Vite del otro), así
// que las dos listas están escritas dos veces.
//
// Un espejo sin guardián miente apenas alguien agrega un nivel de un solo lado:
// el servidor guardaría 'X', el CHECK de la migración lo rechazaría o el cliente
// lo dibujaría en blanco. Esta prueba existe para que eso no compile en verde.

const RAIZ = process.cwd();
const SERVIDOR = path.join(RAIZ, 'supabase/functions/_shared/senalConfirmacion.ts');
const MIGRACION = path.join(RAIZ, 'supabase/migrations/20260822010000_senal_confirmacion_importchat.sql');

const leer = (p: string) => fs.readFileSync(p, 'utf8');

/** Extrae los niveles del `export type NivelRiesgo = 'a' | 'b' | ...` del servidor. */
function nivelesDelServidor(): string[] {
  const src = leer(SERVIDOR);
  const m = src.match(/export type NivelRiesgo\s*=\s*([^;]+);/);
  expect(m, 'no se encontró `export type NivelRiesgo` en el módulo del servidor').toBeTruthy();
  return [...m![1].matchAll(/"([a-z_]+)"|'([a-z_]+)'/g)].map((x) => x[1] ?? x[2]);
}

describe('el espejo cliente/servidor del riesgo de chat', () => {
  it('los dos lados conocen exactamente los mismos niveles', () => {
    expect(nivelesDelServidor().sort()).toEqual(Object.keys(PRIORIDAD_RIESGO).sort());
  });

  it('el CHECK de la migración acepta esos mismos niveles y ninguno más', () => {
    // Sin esto, agregar un nivel en los dos .ts igual reventaría el UPDATE con
    // un 23514 en producción, que es donde menos se quiere descubrirlo.
    const sql = leer(MIGRACION);
    const m = sql.match(/chat_riesgo IN \(([^)]+)\)/);
    expect(m, 'no se encontró el CHECK de chat_riesgo en la migración').toBeTruthy();
    const enSql = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(enSql.sort()).toEqual(Object.keys(PRIORIDAD_RIESGO).sort());
  });

  it('todo nivel tiene etiqueta, tasa y qué hacer — nadie ve un chip mudo', () => {
    for (const k of Object.keys(PRIORIDAD_RIESGO) as NivelRiesgo[]) {
      const i = RIESGO_INFO[k];
      expect(i, `falta RIESGO_INFO para ${k}`).toBeTruthy();
      expect(i.etiqueta.length).toBeGreaterThan(2);
      expect(i.queHacer.length).toBeGreaterThan(10);
      expect(i.tasa.length).toBeGreaterThan(0);
    }
  });

  it('los chips usan tokens del design system, nunca colores crudos', () => {
    // Un `text-red-500` suelto se ve bien en claro y desaparece en oscuro.
    for (const k of Object.keys(RIESGO_INFO) as NivelRiesgo[]) {
      expect(RIESGO_INFO[k].clase).not.toMatch(/\b(?:text|bg|border)-(?:red|green|yellow|blue|gray|slate)-\d{2,3}\b/);
    }
  });

  it('un valor desconocido de la base no se hace pasar por una medición', () => {
    expect(normalizarRiesgo('cualquier_cosa')).toBeNull();
    expect(normalizarRiesgo(null)).toBeNull();
    expect(normalizarRiesgo('')).toBeNull();
    expect(normalizarRiesgo('frio')).toBe('frio');
  });
});
