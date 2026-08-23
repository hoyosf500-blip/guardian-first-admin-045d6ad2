import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CANCEL_CULPA_INFO,
  CANCEL_CULPA_LABEL,
  CANCEL_CULPA_ORDER,
  CANCEL_CATEGORIA_LABEL,
  cancelCategoriaLabel,
  classifyCancel,
  type CancelCulpa,
} from '@/lib/cancelTaxonomy';

// PRUEBA GUARDIANA de las etiquetas del reporte de cancelaciones.
//
// Este reporte lo lee el dueño para decidir qué arreglar, no un desarrollador
// para depurar. Una etiqueta que describe el bucket ("Precio / oferta") en vez
// de decir qué pasó y dónde mirar convierte la pantalla en un gráfico bonito
// del que no sale ninguna acción. Estas pruebas fijan ese contrato.

describe('cada lado del problema se explica solo', () => {
  it('toda culpa tiene etiqueta, explicación y dónde mirar', () => {
    const culpas = Object.keys(CANCEL_CULPA_INFO) as CancelCulpa[];
    expect(culpas.length).toBeGreaterThan(3);
    for (const c of culpas) {
      const i = CANCEL_CULPA_INFO[c];
      expect(i.label.length, `${c}: falta etiqueta`).toBeGreaterThan(3);
      expect(i.que.length, `${c}: falta explicación`).toBeGreaterThan(20);
      expect(i.dondeMirar.length, `${c}: falta dónde mirar`).toBeGreaterThan(20);
    }
  });

  it('la etiqueta no es el nombre técnico del bucket', () => {
    // 'precio_oferta' → "Precio / oferta" era exactamente eso: repetir la clave
    // con espacios. No le dice nada a quien tiene que decidir.
    for (const c of Object.keys(CANCEL_CULPA_INFO) as CancelCulpa[]) {
      const normal = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
      expect(normal(CANCEL_CULPA_INFO[c].label), `${c} se llama igual que su clave`)
        .not.toBe(normal(c));
    }
  });

  it('las etiquetas no usan jerga interna', () => {
    const jerga = /\b(lead|bucket|flag|rpc|null|n\/a|status|query)\b/i;
    for (const c of Object.keys(CANCEL_CULPA_INFO) as CancelCulpa[]) {
      const i = CANCEL_CULPA_INFO[c];
      expect(jerga.test(i.label), `${c}: jerga en la etiqueta`).toBe(false);
      expect(jerga.test(i.que), `${c}: jerga en la explicación`).toBe(false);
    }
  });

  it('el mapa de etiquetas se deriva del de info — no son dos listas', () => {
    // Dos listas paralelas se separan sola la primera vez que alguien agrega
    // una culpa en una y se olvida de la otra.
    for (const c of Object.keys(CANCEL_CULPA_INFO) as CancelCulpa[]) {
      expect(CANCEL_CULPA_LABEL[c]).toBe(CANCEL_CULPA_INFO[c].label);
    }
    expect(Object.keys(CANCEL_CULPA_LABEL).sort()).toEqual(Object.keys(CANCEL_CULPA_INFO).sort());
  });

  it('el orden de la taxonomía cubre exactamente las mismas culpas', () => {
    expect([...CANCEL_CULPA_ORDER].sort()).toEqual(Object.keys(CANCEL_CULPA_INFO).sort());
  });

  it('"nadie anotó por qué" no se disfraza de causa', () => {
    // Es un dato faltante y tiene que decirlo en la cara: si se leyera como una
    // causa más, el 79% de agosto pasaría por explicación.
    const g = CANCEL_CULPA_INFO.generica;
    expect(g.label.toLowerCase()).toMatch(/nadie|sin|no se/);
    expect(g.dondeMirar.toLowerCase()).toMatch(/ciegas|falta|no es una nota/);
  });
});

describe('ninguna categoría queda sin nombre', () => {
  it('toda categoría del picklist tiene etiqueta legible', () => {
    for (const [k, v] of Object.entries(CANCEL_CATEGORIA_LABEL)) {
      expect(v.length, `${k}: etiqueta vacía`).toBeGreaterThan(2);
      expect(v).not.toBe(k);
    }
  });

  it('una categoría desconocida devuelve su clave, no un vacío', () => {
    // Mejor ver 'algo_raro' en pantalla que una barra sin nombre: la barra sin
    // nombre no se puede ni reportar.
    expect(cancelCategoriaLabel('algo_raro')).toBe('algo_raro');
  });

  it('lo que clasifica el motor tiene etiqueta', () => {
    const muestras = [
      'no contesta', 'muy caro el flete', 'se arrepintió', 'duplicado',
      'no reconoce el pedido', 'cambio de transportadora', '', 'sin stock',
    ];
    for (const m of muestras) {
      const c = classifyCancel(m);
      expect(CANCEL_CATEGORIA_LABEL[c.categoria], `sin etiqueta: ${c.categoria} (de "${m}")`)
        .toBeTruthy();
      expect(CANCEL_CULPA_INFO[c.culpa], `sin info de culpa: ${c.culpa}`).toBeTruthy();
    }
  });
});

describe('la pantalla usa las etiquetas nuevas', () => {
  const TAB = path.join(process.cwd(), 'src/components/logistics/CancelacionesTab.tsx');
  const src = fs.readFileSync(TAB, 'utf8');

  it('la portada NO está detrás del guard de motivos', () => {
    // El bug que se vino a arreglar: "¿De quién fue?" vivía dentro de
    // `hayMotivos &&`, así que con 0% de cobertura la pantalla no mostraba el
    // bloque que decía justamente que no había cobertura.
    const i = src.indexOf('<LadoDelProblema');
    expect(i, 'no se encontró la portada en la pantalla').toBeGreaterThan(-1);
    const guard = src.indexOf('{hayMotivos && (');
    expect(guard).toBeGreaterThan(-1);
    expect(i, 'la portada quedó dentro del guard de motivos').toBeLessThan(guard);
  });

  it('el producto se ordena por tasa, no por cantidad', () => {
    // `DimensionCard` con `pct={d.cancelados / total}` es el ranking por
    // cantidad: si vuelve para producto, las Gafas vuelven a encabezar.
    expect(src).toContain('<TasaPorProductoCard');
    expect(src).not.toMatch(/<DimensionCard[^>]*title="Por producto"/);
  });
});

describe('el vacio solo se afirma cuando termino de leer', () => {
  const TAB2 = path.join(process.cwd(), 'src/components/logistics/CancelacionesTab.tsx');
  const src2 = fs.readFileSync(TAB2, 'utf8');
  const lineas = src2.split('\n').map((l) => l.replace('\r', ''));

  it('`sinDatos` mira `loading`, no solo el total', () => {
    // Medido en producción el 23-ago-2026: durante 12 SEGUNDOS la pantalla
    // decía "No hubo cancelaciones en el período. Es un buen resultado, no un
    // error." con 244 cancelaciones reales. No es una pantalla en blanco: es
    // una afirmación falsa y tranquilizadora sobre datos que no se leyeron.
    //
    // Lo destapó el troceo por tramos (la consulta pasó de menos de 1s a 12s),
    // pero el defecto estaba desde antes: `sinDatos` nunca miró `loading`.
    const linea = lineas.find((l) => l.includes('const sinDatos') && l.includes('=')) || '';
    expect(linea, 'no se encontró la definición de sinDatos').not.toBe('');
    expect(
      linea.includes('!s.loading') || linea.includes('!loading'),
      '`sinDatos` no mira `loading`: el vacío se afirma mientras todavía carga',
    ).toBe(true);
  });

  it('mientras carga hay un mensaje propio, no el de "no hubo cancelaciones"', () => {
    // Doce segundos de pantalla muda también se leen como "está caído".
    const def = lineas.find((l) => l.includes('const leyendo') && l.includes('=')) || '';
    expect(def, 'no hay estado de carga propio').not.toBe('');
    expect(def.includes('s.loading') || def.includes('loading')).toBe(true);

    const iLeyendo = src2.indexOf('{leyendo ?');
    // El indexOf a secas caia en el COMENTARIO que documenta el bug (la
    // pantalla nombra el mensaje dos veces). Se busca el render, no el texto.
    const iVacio = src2.indexOf('<EmptyCard msg="No hubo cancelaciones');
    expect(iLeyendo, 'no hay rama de carga en el render').toBeGreaterThan(-1);
    expect(iLeyendo, 'la rama de carga tiene que ir ANTES del estado vacío').toBeLessThan(iVacio);
  });
});
