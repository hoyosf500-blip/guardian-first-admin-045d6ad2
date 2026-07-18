# Rediseño 3D Command Center — Tandas 0-2 · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir la capa de presentación `ui3d` (primitivos + utilidades CSS), reemplazar el shell de la app por rail de 80px + topbar HUD, y aplicar el look completo al Dashboard.

**Architecture:** Dos niveles sin lógica de negocio. (1) CSS: keyframes y clases sin estado en `src/index.css`. (2) React: primitivos puros en `src/components/ui3d/` que reciben solo `number`/`string`/`ReactNode` — nunca hooks de datos, queries ni el cliente de Supabase. Las pantallas consumen los primitivos; ningún archivo de pantalla reimplementa tilt, count-up ni gauge.

**Tech Stack:** React 18 · TypeScript (no strict) · Tailwind · Vitest + Testing Library (jsdom) · recharts · framer-motion · lucide-react. Alias `@/` → `./src/`.

**Spec:** `docs/superpowers/specs/2026-07-18-rediseno-3d-command-center-design.md`

---

## Reglas que aplican a TODAS las tareas

1. **Cero cambio funcional.** No se agregan ni modifican `useEffect`, `useState` de datos, arrays de dependencias, llamadas a `supabase`, ni condicionales de negocio. Si una tarea parece necesitarlo, parar y preguntar.
2. **Cero cambio de texto.** Ningún copy ni nombre de métrica cambia. "Tasa personal" sigue siendo "Tasa personal", "No respondió" sigue siendo "No respondió".
3. **Los `title=` explicativos se conservan.** `DashboardTab` tiene tooltips largos que documentan cómo se calcula cada métrica. Se copian tal cual al markup nuevo.
4. **Nada de hex hardcodeado** en componentes: todo sale de tokens (`hsl(var(--accent))`, `text-success`, etc.) para que el light mode siga funcionando.
5. **Ningún componente nuevo usa `backdrop-filter`.** El spec permitía glass en cards; al
   escribir los primitivos quedó claro que no hace falta ninguno: `bg-card/40` sobre la
   aurora ya da la profundidad, y así se cumple al pie el pedido del handoff ("sin
   `backdrop-filter`, para no pesar en internet lento"). Los `.glass-panel` que ya existen
   en `ConfirmarTab` y `AuthPage` **no se tocan en estas tandas**.
6. Al terminar cada tarea: `npm run test` y `npm run build` deben pasar.

## Estructura de archivos

**Crear:**

| Archivo | Responsabilidad |
|---|---|
| `src/components/ui3d/useTilt.ts` | Hook: decide si el tilt aplica y calcula la rotación |
| `src/components/ui3d/useTilt.test.ts` | Tests del hook |
| `src/components/ui3d/TiltCard.tsx` | Card con perspective + rotación |
| `src/components/ui3d/TiltCard.test.tsx` | |
| `src/components/ui3d/CountUp.tsx` | Cifra animada + helpers puros de easing |
| `src/components/ui3d/CountUp.test.tsx` | |
| `src/components/ui3d/GaugeRing.tsx` | Anillo cónico de porcentaje + `pctToDegrees` |
| `src/components/ui3d/GaugeRing.test.tsx` | |
| `src/components/ui3d/Sparkline.tsx` | Polyline SVG + `buildPolylinePoints` |
| `src/components/ui3d/Sparkline.test.tsx` | |
| `src/components/ui3d/StatTile.tsx` | Chip + cifra + label + sparkline |
| `src/components/ui3d/StatTile.test.tsx` | |
| `src/components/ui3d/RankRow.tsx` | Fila de ranking con barra |
| `src/components/ui3d/RankRow.test.tsx` | |
| `src/components/ui3d/AuroraBackdrop.tsx` | Blobs difuminados + retícula en perspectiva |
| `src/components/ui3d/IconRail.tsx` | Rail 80px, ícono + micro-label |
| `src/components/ui3d/IconRail.test.tsx` | |
| `src/components/ui3d/HudTopbar.tsx` | Topbar 52px con rótulo HUD |
| `src/components/ui3d/HudTopbar.test.tsx` | |
| `src/components/ui3d/index.ts` | Barrel de exportación |

**Modificar:**

| Archivo | Qué |
|---|---|
| `src/index.css` | Agregar keyframes y clases del bloque "Movimiento 3D" |
| `src/components/ProtectedLayout.tsx` | Reemplazar `<aside>` por `<IconRail>` y `<header>` por `<HudTopbar>` |
| `src/components/tabs/DashboardTab.tsx` | Consumir `TiltCard`/`GaugeRing`/`StatTile`/`RankRow`/`CountUp`; restilizar los 2 gráficos recharts |

---

# TANDA 0 — Capa `ui3d`

### Task 1: Rama + capa CSS de movimiento

**Files:**
- Modify: `src/index.css` (insertar después de la línea 378, al cierre de `.icon-chip`)

- [ ] **Step 1: Crear la rama**

```bash
cd "c:/Users/hoyos/Desktop/guardian-first-admin-90d8e5be"
git checkout -b redesign/3d-command-center
```

- [ ] **Step 2: Agregar el bloque CSS**

Insertar en `src/index.css` inmediatamente después del cierre de `.icon-chip` (línea 378), todavía dentro del `@layer base`:

```css
  /* ─────────────────────────────────────────────────────────
     MOVIMIENTO 3D — keyframes y clases sin estado del handoff.
     Todo anima solo transform/opacity (compositor GPU).
     Se apaga entero bajo prefers-reduced-motion (final del bloque).
     ───────────────────────────────────────────────────────── */

  @keyframes gb-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
  @keyframes gb-spin  { to { transform: rotate(360deg); } }
  @keyframes gb-draw  { to { stroke-dashoffset: 0; } }
  @keyframes gb-rise  { from { transform: scaleY(0); opacity: 0; } to { transform: scaleY(1); opacity: 1; } }
  @keyframes gb-pulse { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }
  @keyframes gb-sheen {
    0%        { transform: translateX(-130%) skewX(-18deg); }
    55%, 100% { transform: translateX(320%) skewX(-18deg); }
  }

  /* Card inclinable — la rotación la inyecta useTilt por style inline */
  .tilt-3d {
    transition: transform .35s cubic-bezier(.2,.7,.3,1), box-shadow .35s ease;
    transform-style: preserve-3d;
    will-change: transform;
  }

  /* Rótulo HUD — mono, espaciado, mayúsculas. Usa --subtle (AA sobre el fondo) */
  .hud-label {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: .2em;
    text-transform: uppercase;
    color: hsl(var(--subtle));
  }

  /* Brackets de esquina de la card hero */
  .corner-bracket { position: absolute; width: 18px; height: 18px; opacity: .6; pointer-events: none; }
  .corner-bracket-tl { top: 14px; left: 14px;  border-top: 2px solid hsl(var(--cyan)); border-left: 2px solid hsl(var(--cyan)); }
  .corner-bracket-tr { top: 14px; right: 14px; border-top: 2px solid hsl(var(--cyan)); border-right: 2px solid hsl(var(--cyan)); }

  /* Barrido holográfico — el contenedor necesita position:relative + overflow:hidden */
  .sheen {
    position: absolute; inset: 0 auto 0 0; width: 38%;
    pointer-events: none;
    background: linear-gradient(100deg, transparent, hsl(0 0% 100% / .09), transparent);
    animation: gb-sheen 7s ease-in-out infinite;
  }

  /* Retícula en perspectiva del fondo aurora */
  .perspective-floor {
    position: absolute; left: 0; right: 0; bottom: 0; height: 260px;
    pointer-events: none;
    background-image:
      linear-gradient(hsl(var(--accent) / .16) 1px, transparent 1px),
      linear-gradient(90deg, hsl(var(--accent) / .16) 1px, transparent 1px);
    background-size: 44px 44px;
    transform: perspective(420px) rotateX(62deg);
    transform-origin: bottom;
    -webkit-mask: linear-gradient(to top, #000, transparent);
    mask: linear-gradient(to top, #000, transparent);
    opacity: .5;
  }

  /* Blob difuminado del fondo aurora */
  .aurora-blob {
    position: absolute; border-radius: 50%;
    filter: blur(20px); pointer-events: none;
    animation: gb-float 11s ease-in-out infinite;
  }

  /* Trazo SVG que se dibuja al montar (sparklines, líneas de gráfico) */
  .spark-draw { stroke-dasharray: 300; stroke-dashoffset: 300; animation: gb-draw 1.4s ease .3s forwards; }

  /* Accesibilidad — apagar TODO el movimiento de esta capa */
  @media (prefers-reduced-motion: reduce) {
    .tilt-3d { transition: none !important; transform: none !important; }
    .sheen, .aurora-blob { animation: none !important; }
    .spark-draw { animation: none !important; stroke-dashoffset: 0 !important; }
  }
```

- [ ] **Step 3: Verificar que el build compila el CSS**

Run: `npm run build`
Expected: build exitoso, sin warnings de CSS.

- [ ] **Step 4: Commit**

```bash
git add src/index.css
git commit -m "style(ui3d): keyframes y clases de movimiento 3D (tilt, sheen, HUD, aurora)"
```

---

### Task 2: `useTilt` — el hook que decide si el tilt aplica

**Files:**
- Create: `src/components/ui3d/useTilt.ts`
- Test: `src/components/ui3d/useTilt.test.ts`

Este hook es el único lugar donde se decide si el tilt corre. Ninguna pantalla debe repetir esa decisión.

- [ ] **Step 1: Escribir el test que falla**

Crear `src/components/ui3d/useTilt.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTilt, rotationFromPointer } from './useTilt';

/** Sustituye window.matchMedia por un stub que responde según la query. */
function stubMatchMedia(matches: Record<string, boolean>) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: matches[query] ?? false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe('rotationFromPointer', () => {
  const rect = { left: 0, top: 0, width: 200, height: 100 };

  it('no rota en el centro exacto', () => {
    expect(rotationFromPointer(100, 50, rect, 6)).toEqual({ rx: 0, ry: 0 });
  });

  it('llega al máximo en las esquinas y nunca lo pasa', () => {
    const topLeft = rotationFromPointer(0, 0, rect, 6);
    expect(topLeft.rx).toBeCloseTo(6);
    expect(topLeft.ry).toBeCloseTo(-6);

    const bottomRight = rotationFromPointer(200, 100, rect, 6);
    expect(bottomRight.rx).toBeCloseTo(-6);
    expect(bottomRight.ry).toBeCloseTo(6);
  });

  it('recorta cuando el puntero sale del elemento', () => {
    const out = rotationFromPointer(-500, -500, rect, 6);
    expect(Math.abs(out.rx)).toBeLessThanOrEqual(6);
    expect(Math.abs(out.ry)).toBeLessThanOrEqual(6);
  });
});

describe('useTilt', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'innerWidth', { writable: true, value: 1366 });
  });

  it('queda habilitado con puntero fino, pantalla ancha y sin reduced-motion', () => {
    stubMatchMedia({ '(pointer: fine)': true, '(prefers-reduced-motion: reduce)': false });
    const { result } = renderHook(() => useTilt());
    expect(result.current.enabled).toBe(true);
  });

  it('queda DESHABILITADO en táctil (sin puntero fino)', () => {
    stubMatchMedia({ '(pointer: fine)': false, '(prefers-reduced-motion: reduce)': false });
    const { result } = renderHook(() => useTilt());
    expect(result.current.enabled).toBe(false);
  });

  it('queda DESHABILITADO con prefers-reduced-motion', () => {
    stubMatchMedia({ '(pointer: fine)': true, '(prefers-reduced-motion: reduce)': true });
    const { result } = renderHook(() => useTilt());
    expect(result.current.enabled).toBe(false);
  });

  it('queda DESHABILITADO en pantalla angosta (móvil)', () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, value: 375 });
    stubMatchMedia({ '(pointer: fine)': true, '(prefers-reduced-motion: reduce)': false });
    const { result } = renderHook(() => useTilt());
    expect(result.current.enabled).toBe(false);
  });

  it('no acumula rotación si está deshabilitado', () => {
    stubMatchMedia({ '(pointer: fine)': false });
    const { result } = renderHook(() => useTilt());
    act(() => {
      result.current.tiltProps.onPointerMove({
        clientX: 0, clientY: 0,
        currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }) },
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });
    expect(result.current.rotation).toEqual({ rx: 0, ry: 0 });
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/components/ui3d/useTilt.test.ts`
Expected: FAIL — `Failed to resolve import "./useTilt"`.

- [ ] **Step 3: Implementar el hook**

Crear `src/components/ui3d/useTilt.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/** Inclinación máxima en grados. El handoff pide ≤ 6°. */
const MAX_DEG = 6;
/** Debajo de este ancho consideramos móvil y no inclinamos. */
const MIN_WIDTH_PX = 768;

export interface Rotation { rx: number; ry: number }
interface Rect { left: number; top: number; width: number; height: number }

/**
 * Convierte la posición del puntero en rotación, normalizada al centro del
 * elemento. Pura y exportada para poder testear la matemática sin DOM.
 * El resultado siempre queda dentro de [-maxDeg, maxDeg].
 */
export function rotationFromPointer(
  clientX: number, clientY: number, rect: Rect, maxDeg: number = MAX_DEG,
): Rotation {
  if (rect.width === 0 || rect.height === 0) return { rx: 0, ry: 0 };
  const clamp = (n: number) => Math.max(-1, Math.min(1, n));
  // -1 (borde izquierdo/superior) .. +1 (borde derecho/inferior)
  const px = clamp(((clientX - rect.left) / rect.width) * 2 - 1);
  const py = clamp(((clientY - rect.top) / rect.height) * 2 - 1);
  // El eje X se invierte: mouse abajo => la card se inclina hacia atrás.
  return { rx: -py * maxDeg, ry: px * maxDeg };
}

/**
 * Decide si el tilt 3D aplica y expone los handlers.
 *
 * Se apaga en táctil, con prefers-reduced-motion y en pantallas angostas.
 * Es el ÚNICO lugar donde vive esa decisión — las pantallas no la repiten.
 */
export function useTilt(maxDeg: number = MAX_DEG) {
  const [enabled, setEnabled] = useState(false);
  const [rotation, setRotation] = useState<Rotation>({ rx: 0, ry: 0 });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const finePointer = window.matchMedia('(pointer: fine)').matches;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wideEnough = window.innerWidth >= MIN_WIDTH_PX;
    setEnabled(finePointer && !reducedMotion && wideEnough);
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (!enabled) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setRotation(rotationFromPointer(e.clientX, e.clientY, rect, maxDeg));
  }, [enabled, maxDeg]);

  const onPointerLeave = useCallback(() => {
    if (!enabled) return;
    setRotation({ rx: 0, ry: 0 });
  }, [enabled]);

  return { enabled, rotation, tiltProps: { onPointerMove, onPointerLeave } };
}
```

- [ ] **Step 4: Correr los tests**

Run: `npx vitest run src/components/ui3d/useTilt.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui3d/useTilt.ts src/components/ui3d/useTilt.test.ts
git commit -m "feat(ui3d): hook useTilt con apagado en táctil, móvil y reduced-motion"
```

---

### Task 3: `TiltCard`

**Files:**
- Create: `src/components/ui3d/TiltCard.tsx`
- Test: `src/components/ui3d/TiltCard.test.tsx`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/components/ui3d/TiltCard.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TiltCard from './TiltCard';

describe('TiltCard', () => {
  it('renderiza sus hijos', () => {
    render(<TiltCard><span>contenido</span></TiltCard>);
    expect(screen.getByText('contenido')).toBeInTheDocument();
  });

  it('aplica la clase pasada por className a la card interna', () => {
    const { container } = render(<TiltCard className="mi-clase">x</TiltCard>);
    expect(container.querySelector('.mi-clase')).toBeTruthy();
  });

  it('siempre lleva la clase tilt-3d', () => {
    const { container } = render(<TiltCard>x</TiltCard>);
    expect(container.querySelector('.tilt-3d')).toBeTruthy();
  });

  it('muestra el sheen solo cuando se pide', () => {
    const { container: sin } = render(<TiltCard>x</TiltCard>);
    expect(sin.querySelector('.sheen')).toBeNull();
    const { container: con } = render(<TiltCard sheen>x</TiltCard>);
    expect(con.querySelector('.sheen')).toBeTruthy();
  });

  it('muestra los brackets de esquina solo cuando se piden', () => {
    const { container } = render(<TiltCard brackets>x</TiltCard>);
    expect(container.querySelectorAll('.corner-bracket')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/components/ui3d/TiltCard.test.tsx`
Expected: FAIL — `Failed to resolve import "./TiltCard"`.

- [ ] **Step 3: Implementar el componente**

Crear `src/components/ui3d/TiltCard.tsx`:

```tsx
import type { ReactNode } from 'react';
import { useTilt } from './useTilt';

interface TiltCardProps {
  children: ReactNode;
  /** Clases de la card interna (fondo, borde, padding, radio). */
  className?: string;
  /** Distancia de perspectiva del contenedor, en px. */
  perspective?: number;
  /** Barrido holográfico lento (solo para la card hero de cada pantalla). */
  sheen?: boolean;
  /** Brackets cian en las esquinas superiores (card hero). */
  brackets?: boolean;
}

/**
 * Card con inclinación 3D al mover el puntero.
 *
 * La perspective va en el contenedor externo y la rotación en el interno —
 * es la única forma de que rotateX/rotateY se vean en 3D. Si useTilt está
 * deshabilitado (táctil, móvil, reduced-motion) no se aplica ningún transform.
 *
 * Presentación pura: no recibe hooks de datos ni el cliente de Supabase.
 */
export default function TiltCard({
  children, className = '', perspective = 900, sheen = false, brackets = false,
}: TiltCardProps) {
  const { enabled, rotation, tiltProps } = useTilt();

  return (
    <div style={{ perspective: `${perspective}px` }}>
      <div
        {...tiltProps}
        className={`tilt-3d relative overflow-hidden ${className}`}
        style={enabled ? { transform: `rotateX(${rotation.rx}deg) rotateY(${rotation.ry}deg)` } : undefined}
      >
        {brackets && (
          <>
            <span className="corner-bracket corner-bracket-tl" aria-hidden="true" />
            <span className="corner-bracket corner-bracket-tr" aria-hidden="true" />
          </>
        )}
        {sheen && <span className="sheen" aria-hidden="true" />}
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Correr los tests**

Run: `npx vitest run src/components/ui3d/TiltCard.test.tsx`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui3d/TiltCard.tsx src/components/ui3d/TiltCard.test.tsx
git commit -m "feat(ui3d): TiltCard con perspective, sheen y brackets opcionales"
```

---

### Task 4: `CountUp`

**Files:**
- Create: `src/components/ui3d/CountUp.tsx`
- Test: `src/components/ui3d/CountUp.test.tsx`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/components/ui3d/CountUp.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import CountUp, { easeOutCubic, valueAtProgress } from './CountUp';

describe('easeOutCubic', () => {
  it('empieza en 0 y termina en 1', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it('va más rápido al principio que al final', () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});

describe('valueAtProgress', () => {
  it('devuelve 0 al empezar y el valor final al terminar', () => {
    expect(valueAtProgress(80, 0)).toBe(0);
    expect(valueAtProgress(80, 1)).toBe(80);
  });

  it('redondea a entero cuando no se piden decimales', () => {
    expect(Number.isInteger(valueAtProgress(80, 0.37))).toBe(true);
  });

  it('respeta los decimales pedidos', () => {
    expect(valueAtProgress(10, 1, 2)).toBe(10);
    expect(valueAtProgress(3.456, 1, 2)).toBe(3.46);
  });

  it('maneja valores negativos', () => {
    expect(valueAtProgress(-40, 1)).toBe(-40);
  });
});

describe('CountUp', () => {
  it('con duration 0 muestra el valor final de una', () => {
    render(<CountUp value={42} duration={0} />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('termina en el valor final aunque anime', async () => {
    render(<CountUp value={86} duration={20} />);
    await waitFor(() => expect(screen.getByText('86')).toBeInTheDocument());
  });

  it('acepta sufijo', () => {
    render(<CountUp value={7} duration={0} suffix="%" />);
    expect(screen.getByText('7%')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/components/ui3d/CountUp.test.tsx`
Expected: FAIL — `Failed to resolve import "./CountUp"`.

- [ ] **Step 3: Implementar el componente**

Crear `src/components/ui3d/CountUp.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';

/** Easing del handoff: arranca rápido y frena al final. */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Valor mostrado en un punto del recorrido (0..1). Puro para poder testearlo
 * sin requestAnimationFrame.
 */
export function valueAtProgress(target: number, progress: number, decimals = 0): number {
  const raw = target * easeOutCubic(Math.max(0, Math.min(1, progress)));
  const factor = Math.pow(10, decimals);
  return Math.round(raw * factor) / factor;
}

interface CountUpProps {
  value: number;
  /** Milisegundos de animación. 0 = sin animar (útil en tests). */
  duration?: number;
  decimals?: number;
  suffix?: string;
  prefix?: string;
  className?: string;
}

/**
 * Cifra que sube desde 0 hasta su valor al montar.
 *
 * Con prefers-reduced-motion o duration 0 muestra el valor final directo.
 * Presentación pura: recibe un number, no consulta nada.
 */
export default function CountUp({
  value, duration = 1100, decimals = 0, suffix = '', prefix = '', className = '',
}: CountUpProps) {
  const skip = duration <= 0
    || (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  const [shown, setShown] = useState(() => (skip ? value : 0));
  const frameRef = useRef<number>();

  useEffect(() => {
    if (skip) { setShown(value); return; }

    const start = performance.now();
    const tick = (now: number) => {
      const progress = (now - start) / duration;
      if (progress >= 1) { setShown(value); return; }
      setShown(valueAtProgress(value, progress, decimals));
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);

    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [value, duration, decimals, skip]);

  return (
    <span className={`font-mono tabular-nums ${className}`}>
      {prefix}{shown.toFixed(decimals)}{suffix}
    </span>
  );
}
```

- [ ] **Step 4: Correr los tests**

Run: `npx vitest run src/components/ui3d/CountUp.test.tsx`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui3d/CountUp.tsx src/components/ui3d/CountUp.test.tsx
git commit -m "feat(ui3d): CountUp con easing easeOutCubic y respeto a reduced-motion"
```

---

### Task 5: `GaugeRing`

**Files:**
- Create: `src/components/ui3d/GaugeRing.tsx`
- Test: `src/components/ui3d/GaugeRing.test.tsx`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/components/ui3d/GaugeRing.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import GaugeRing, { pctToDegrees } from './GaugeRing';

describe('pctToDegrees', () => {
  it('mapea 0 a 0° y 100 a 360°', () => {
    expect(pctToDegrees(0)).toBe(0);
    expect(pctToDegrees(100)).toBe(360);
  });

  it('mapea la mitad a media vuelta', () => {
    expect(pctToDegrees(50)).toBe(180);
  });

  it('recorta fuera de rango en vez de dar la vuelta', () => {
    expect(pctToDegrees(140)).toBe(360);
    expect(pctToDegrees(-20)).toBe(0);
  });

  it('trata NaN como 0 para no romper el conic-gradient', () => {
    expect(pctToDegrees(NaN)).toBe(0);
  });
});

describe('GaugeRing', () => {
  it('muestra el porcentaje y su etiqueta', () => {
    render(<GaugeRing value={86} label="confirmación" duration={0} />);
    expect(screen.getByText('86%')).toBeInTheDocument();
    expect(screen.getByText('confirmación')).toBeInTheDocument();
  });

  it('expone el valor a lectores de pantalla', () => {
    render(<GaugeRing value={86} label="confirmación" duration={0} />);
    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('aria-valuenow', '86');
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/components/ui3d/GaugeRing.test.tsx`
Expected: FAIL — `Failed to resolve import "./GaugeRing"`.

- [ ] **Step 3: Implementar el componente**

Crear `src/components/ui3d/GaugeRing.tsx`:

```tsx
import CountUp from './CountUp';

/**
 * Porcentaje → grados para el conic-gradient. Recorta fuera de rango y trata
 * NaN como 0: un NaN acá rompe el gradiente y deja el anillo en blanco.
 */
export function pctToDegrees(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct)) * 3.6;
}

interface GaugeRingProps {
  /** Porcentaje 0-100. */
  value: number;
  /** Texto bajo la cifra (ej. "confirmación"). */
  label?: string;
  /** Diámetro en px. */
  size?: number;
  /** Grosor del anillo en px. */
  thickness?: number;
  duration?: number;
}

/**
 * Anillo tipo gauge del handoff: arco cónico índigo→violeta→cian sobre pista
 * tenue, con halo y la cifra al centro.
 *
 * El arco se dibuja con conic-gradient + mask radial (un donut), que es más
 * barato de animar que un stroke SVG. Presentación pura.
 */
export default function GaugeRing({
  value, label, size = 210, thickness = 20, duration = 1100,
}: GaugeRingProps) {
  const deg = pctToDegrees(value);
  const donutMask = `radial-gradient(farthest-side, transparent calc(100% - ${thickness}px), #000 calc(100% - ${thickness - 1}px))`;

  return (
    <div
      role="meter"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ? `Tasa de ${label}` : 'Tasa'}
      className="relative"
      style={{ width: size, height: size }}
    >
      {/* Halo difuminado que gira lento detrás del anillo */}
      <div
        aria-hidden="true"
        className="absolute rounded-full aurora-blob"
        style={{
          inset: -16,
          background: 'conic-gradient(from 0deg, hsl(var(--accent)), hsl(var(--accent2)), hsl(var(--cyan)), hsl(var(--accent)))',
          opacity: 0.3,
        }}
      />
      {/* Pista + arco de progreso */}
      <div
        aria-hidden="true"
        className="absolute inset-0 rounded-full"
        style={{
          background: `conic-gradient(from 200deg, hsl(var(--accent)) 0deg, hsl(var(--accent2)) ${deg * 0.55}deg, hsl(var(--cyan)) ${deg}deg, hsl(var(--foreground) / .06) ${deg}deg)`,
          WebkitMask: donutMask,
          mask: donutMask,
          boxShadow: '0 0 50px -6px hsl(var(--accent) / .6)',
          transition: 'background 700ms ease',
        }}
      />
      {/* Cifra central */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-[56px] font-bold leading-none text-foreground num-glow-accent">
          <CountUp value={value} duration={duration} />
          <span className="text-2xl" style={{ color: 'hsl(var(--accent2))' }}>%</span>
        </div>
        {label && <div className="text-[11px] text-muted-foreground mt-1">{label}</div>}
      </div>
    </div>
  );
}
```

> Nota: el `<span>%</span>` va fuera de `CountUp` porque `CountUp` ya renderiza su propio `<span>` mono; anidarlo con `suffix` haría que el `%` herede el tamaño de 56px.

- [ ] **Step 4: Correr los tests**

Run: `npx vitest run src/components/ui3d/GaugeRing.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui3d/GaugeRing.tsx src/components/ui3d/GaugeRing.test.tsx
git commit -m "feat(ui3d): GaugeRing conic con pctToDegrees y rol meter accesible"
```

---

### Task 6: `Sparkline`

**Files:**
- Create: `src/components/ui3d/Sparkline.tsx`
- Test: `src/components/ui3d/Sparkline.test.tsx`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/components/ui3d/Sparkline.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import Sparkline, { buildPolylinePoints } from './Sparkline';

describe('buildPolylinePoints', () => {
  it('devuelve cadena vacía con menos de 2 puntos', () => {
    expect(buildPolylinePoints([], 120, 30)).toBe('');
    expect(buildPolylinePoints([5], 120, 30)).toBe('');
  });

  it('reparte los puntos a lo ancho', () => {
    const pts = buildPolylinePoints([0, 10], 120, 30).split(' ');
    expect(pts).toHaveLength(2);
    expect(pts[0].startsWith('0,')).toBe(true);
    expect(pts[1].startsWith('120,')).toBe(true);
  });

  it('invierte el eje Y: el valor mayor queda arriba (y menor)', () => {
    const [bajo, alto] = buildPolylinePoints([0, 10], 120, 30).split(' ');
    const yBajo = Number(bajo.split(',')[1]);
    const yAlto = Number(alto.split(',')[1]);
    expect(yAlto).toBeLessThan(yBajo);
  });

  it('no divide por cero cuando todos los valores son iguales', () => {
    const pts = buildPolylinePoints([7, 7, 7], 120, 30);
    expect(pts).not.toContain('NaN');
  });
});

describe('Sparkline', () => {
  it('no renderiza nada con menos de 2 puntos', () => {
    const { container } = render(<Sparkline data={[1]} color="var(--x)" />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renderiza una polyline con 2+ puntos', () => {
    const { container } = render(<Sparkline data={[1, 4, 2]} color="var(--x)" />);
    expect(container.querySelector('polyline')).toBeTruthy();
  });

  it('se oculta a lectores de pantalla (es decorativo)', () => {
    const { container } = render(<Sparkline data={[1, 4, 2]} color="var(--x)" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/components/ui3d/Sparkline.test.tsx`
Expected: FAIL — `Failed to resolve import "./Sparkline"`.

- [ ] **Step 3: Implementar el componente**

Crear `src/components/ui3d/Sparkline.tsx`:

```tsx
/**
 * Convierte una serie en el atributo `points` de un <polyline>.
 *
 * El eje Y va invertido (en SVG, y=0 es arriba). Si todos los valores son
 * iguales el rango es 0 y la línea se dibuja plana al medio — sin dividir
 * por cero.
 */
export function buildPolylinePoints(data: number[], width: number, height: number): string {
  if (!data || data.length < 2) return '';
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min;
  const stepX = width / (data.length - 1);

  return data
    .map((value, i) => {
      const x = i * stepX;
      const norm = range === 0 ? 0.5 : (value - min) / range;
      const y = height - norm * height;
      return `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`;
    })
    .join(' ');
}

interface SparklineProps {
  data: number[];
  /** Color del trazo. Pasar un token: `hsl(var(--success))`. */
  color: string;
  width?: number;
  height?: number;
  className?: string;
}

/**
 * Línea de tendencia decorativa que se dibuja al montar.
 *
 * Es decorativa: va con aria-hidden porque el número que acompaña ya comunica
 * el dato. Presentación pura.
 */
export default function Sparkline({
  data, color, width = 120, height = 30, className = '',
}: SparklineProps) {
  const points = buildPolylinePoints(data, width, height);
  if (!points) return null;

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      className={className}
      style={{ overflow: 'visible' }}
    >
      <polyline
        className="spark-draw"
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 5px ${color})` }}
      />
    </svg>
  );
}
```

- [ ] **Step 4: Correr los tests**

Run: `npx vitest run src/components/ui3d/Sparkline.test.tsx`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui3d/Sparkline.tsx src/components/ui3d/Sparkline.test.tsx
git commit -m "feat(ui3d): Sparkline con buildPolylinePoints puro y trazo animado"
```

---

### Task 7: `StatTile`

**Files:**
- Create: `src/components/ui3d/StatTile.tsx`
- Test: `src/components/ui3d/StatTile.test.tsx`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/components/ui3d/StatTile.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CheckCircle2 } from 'lucide-react';
import StatTile from './StatTile';

describe('StatTile', () => {
  it('muestra el valor y la etiqueta', () => {
    render(<StatTile icon={CheckCircle2} label="Confirmados" value={42} tone="success" duration={0} />);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Confirmados')).toBeInTheDocument();
  });

  it('muestra el texto extra cuando se pasa', () => {
    render(<StatTile icon={CheckCircle2} label="Total" value={63} tone="accent" extra="12 pendientes" duration={0} />);
    expect(screen.getByText('12 pendientes')).toBeInTheDocument();
  });

  it('atenúa la tarjeta cuando el valor es 0', () => {
    const { container } = render(<StatTile icon={CheckCircle2} label="Cancelados" value={0} tone="danger" duration={0} />);
    expect(container.querySelector('.opacity-75')).toBeTruthy();
  });

  it('no atenúa cuando el valor es distinto de 0', () => {
    const { container } = render(<StatTile icon={CheckCircle2} label="Cancelados" value={3} tone="danger" duration={0} />);
    expect(container.querySelector('.opacity-75')).toBeNull();
  });

  it('propaga el title al contenedor para conservar los tooltips explicativos', () => {
    render(<StatTile icon={CheckCircle2} label="Tasa" value={80} tone="accent" title="Cómo se calcula" duration={0} />);
    expect(screen.getByTitle('Cómo se calcula')).toBeInTheDocument();
  });

  it('renderiza sparkline solo con 2+ puntos', () => {
    const { container: sin } = render(<StatTile icon={CheckCircle2} label="X" value={1} tone="accent" spark={[3]} duration={0} />);
    expect(sin.querySelector('polyline')).toBeNull();
    const { container: con } = render(<StatTile icon={CheckCircle2} label="X" value={1} tone="accent" spark={[3, 5]} duration={0} />);
    expect(con.querySelector('polyline')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/components/ui3d/StatTile.test.tsx`
Expected: FAIL — `Failed to resolve import "./StatTile"`.

- [ ] **Step 3: Implementar el componente**

Crear `src/components/ui3d/StatTile.tsx`:

```tsx
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import TiltCard from './TiltCard';
import CountUp from './CountUp';
import Sparkline from './Sparkline';

export type StatTone = 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** Clases por tono. Todo sale de tokens para que el light mode siga válido. */
const TONE: Record<StatTone, { chip: string; text: string; stroke: string }> = {
  accent:  { chip: 'bg-accent/14 border-accent/30 text-accent',    text: 'text-accent',    stroke: 'hsl(var(--accent))' },
  success: { chip: 'bg-success/14 border-success/30 text-success', text: 'text-success',   stroke: 'hsl(var(--success))' },
  warning: { chip: 'bg-warning/14 border-warning/30 text-warning', text: 'text-warning',   stroke: 'hsl(var(--warning))' },
  danger:  { chip: 'bg-danger/14 border-danger/30 text-danger',    text: 'text-danger',    stroke: 'hsl(var(--danger))' },
  info:    { chip: 'bg-info/14 border-info/30 text-info',          text: 'text-info',      stroke: 'hsl(var(--info))' },
  neutral: { chip: 'bg-muted/60 border-border text-muted-foreground', text: 'text-foreground', stroke: 'hsl(var(--muted-foreground))' },
};

interface StatTileProps {
  icon: LucideIcon;
  label: string;
  value: number;
  tone: StatTone;
  /** Serie para la línea de tendencia. Con menos de 2 puntos no se dibuja. */
  spark?: number[];
  /** Texto o badge bajo la cifra (ej. "12 pendientes" o un <TrendBadge/>). */
  extra?: ReactNode;
  /** Tooltip explicativo — conservar los que ya existen en las pantallas. */
  title?: string;
  duration?: number;
}

/**
 * Tarjeta de KPI: chip con ícono, cifra grande animada, etiqueta y sparkline.
 *
 * Cuando el valor es 0 se atenúa, igual que hacía el Dashboard antes del
 * rediseño: un cero apagado se lee distinto de un dato real. Presentación pura.
 */
export default function StatTile({
  icon: Icon, label, value, tone, spark = [], extra, title, duration = 1100,
}: StatTileProps) {
  const t = TONE[tone];
  const isZero = value === 0;

  return (
    <TiltCard
      perspective={1200}
      className={[
        'rounded-2xl p-4 h-full flex flex-col justify-between',
        'bg-card/40 border',
        isZero ? 'border-border/50 opacity-75' : 'border-border',
      ].join(' ')}
    >
      <div title={title}>
        <div className="flex items-center justify-between">
          <span className={`w-9 h-9 rounded-xl border flex items-center justify-center ${t.chip}`}>
            <Icon size={17} aria-hidden="true" />
          </span>
          {spark.length > 1 && (
            <span className="w-20">
              <Sparkline data={spark} color={t.stroke} height={26} />
            </span>
          )}
        </div>

        <div
          className={`text-[34px] font-bold leading-none mt-3 ${isZero ? 'text-muted-foreground' : t.text}`}
        >
          <CountUp value={value} duration={duration} />
        </div>

        <div className="hud-label mt-2">{label}</div>

        {extra && <div className="mt-2">{extra}</div>}
      </div>
    </TiltCard>
  );
}
```

- [ ] **Step 4: Correr los tests**

Run: `npx vitest run src/components/ui3d/StatTile.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui3d/StatTile.tsx src/components/ui3d/StatTile.test.tsx
git commit -m "feat(ui3d): StatTile con tonos por token, sparkline y atenuado en cero"
```

---

### Task 8: `RankRow`

**Files:**
- Create: `src/components/ui3d/RankRow.tsx`
- Test: `src/components/ui3d/RankRow.test.tsx`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/components/ui3d/RankRow.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import RankRow from './RankRow';

describe('RankRow', () => {
  it('muestra posición, nombre y porcentaje', () => {
    render(<RankRow position={1} name="Mayra" pct={86} />);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('Mayra')).toBeInTheDocument();
    expect(screen.getByText('86%')).toBeInTheDocument();
  });

  it('usa la inicial del nombre en el avatar', () => {
    render(<RankRow position={2} name="carolina" pct={81} />);
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('marca la fila propia con la etiqueta Tú', () => {
    render(<RankRow position={1} name="Mayra" pct={86} isMe />);
    expect(screen.getByText('Tú')).toBeInTheDocument();
  });

  it('no muestra la etiqueta Tú en las demás filas', () => {
    render(<RankRow position={2} name="Carolina" pct={81} />);
    expect(screen.queryByText('Tú')).toBeNull();
  });

  it('muestra el detalle cuando se pasa', () => {
    render(<RankRow position={1} name="Mayra" pct={86} detail="63 gest." />);
    expect(screen.getByText('63 gest.')).toBeInTheDocument();
  });

  it('recorta el ancho de la barra a 100% aunque el pct se pase', () => {
    const { container } = render(<RankRow position={1} name="X" pct={140} />);
    const fill = container.querySelector('[data-testid="rank-bar-fill"]') as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });

  it('no deja ancho negativo', () => {
    const { container } = render(<RankRow position={1} name="X" pct={-10} />);
    const fill = container.querySelector('[data-testid="rank-bar-fill"]') as HTMLElement;
    expect(fill.style.width).toBe('0%');
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/components/ui3d/RankRow.test.tsx`
Expected: FAIL — `Failed to resolve import "./RankRow"`.

- [ ] **Step 3: Implementar el componente**

Crear `src/components/ui3d/RankRow.tsx`:

```tsx
interface RankRowProps {
  position: number;
  name: string;
  /** Porcentaje 0-100 que llena la barra. */
  pct: number;
  /** Texto secundario a la derecha del nombre (ej. "63 gest."). */
  detail?: string;
  /** Resalta la fila del usuario actual. */
  isMe?: boolean;
}

/**
 * Fila del ranking del equipo: posición, avatar con inicial, nombre, detalle,
 * porcentaje y barra proporcional.
 *
 * La fila propia va con fondo de acento y glow — el handoff quiere que la
 * operadora se encuentre de un vistazo. Presentación pura.
 */
export default function RankRow({ position, name, pct, detail, isMe = false }: RankRowProps) {
  const width = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const initial = (name || '?')[0].toUpperCase();

  return (
    <div
      className={[
        'flex flex-col gap-2 px-4 py-3 rounded-2xl border',
        isMe
          ? 'bg-accent/12 border-accent/32 glow-accent'
          : 'bg-card/30 border-border',
      ].join(' ')}
    >
      <div className="flex items-center gap-3">
        <span
          className={`font-mono tabular-nums w-6 text-center font-bold text-[15px] ${
            position === 1 ? 'text-warning num-glow-accent' : 'text-muted-foreground'
          }`}
        >
          {position}
        </span>
        <span
          aria-hidden="true"
          className={`w-9 h-9 rounded-xl flex items-center justify-center text-[13px] font-bold ${
            isMe ? 'bg-accent-gradient text-white glow-accent' : 'bg-muted/60 text-muted-foreground'
          }`}
        >
          {initial}
        </span>
        <span className="flex-1 min-w-0 text-[13px] font-semibold text-foreground truncate">
          {name}
          {isMe && (
            <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-accent/25 text-accent">
              Tú
            </span>
          )}
        </span>
        {detail && <span className="font-mono tabular-nums text-xs text-muted-foreground">{detail}</span>}
        <span className="font-mono tabular-nums text-sm font-bold text-success">{Math.round(pct)}%</span>
      </div>

      <div className="h-1 rounded-full bg-foreground/7 overflow-hidden">
        <div
          data-testid="rank-bar-fill"
          className="h-full rounded-full bg-accent-gradient"
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Correr los tests**

Run: `npx vitest run src/components/ui3d/RankRow.test.tsx`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui3d/RankRow.tsx src/components/ui3d/RankRow.test.tsx
git commit -m "feat(ui3d): RankRow con barra recortada y resaltado de la fila propia"
```

---

### Task 9: `AuroraBackdrop` + barrel

**Files:**
- Create: `src/components/ui3d/AuroraBackdrop.tsx`
- Create: `src/components/ui3d/index.ts`

Sin test propio: es un fondo puramente decorativo, sin lógica ni ramas. Lo cubre la verificación visual de la Tanda 1.

- [ ] **Step 1: Crear `AuroraBackdrop`**

Crear `src/components/ui3d/AuroraBackdrop.tsx`:

```tsx
/**
 * Capa de fondo decorativa: dos blobs índigo/violeta que flotan y una retícula
 * en perspectiva al pie.
 *
 * Va en position:absolute con pointer-events:none, así que nunca intercepta
 * clicks. El contenedor padre debe ser relative + overflow-hidden.
 */
export default function AuroraBackdrop() {
  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden pointer-events-none">
      <div
        className="aurora-blob"
        style={{
          left: '-8%', top: '-10%', width: 340, height: 340,
          background: 'radial-gradient(circle, hsl(var(--accent) / .30), transparent 70%)',
        }}
      />
      <div
        className="aurora-blob"
        style={{
          right: '-6%', top: '20%', width: 300, height: 300,
          background: 'radial-gradient(circle, hsl(var(--accent2) / .24), transparent 70%)',
          animationDirection: 'reverse',
          animationDuration: '14s',
        }}
      />
      <div className="perspective-floor" />
    </div>
  );
}
```

- [ ] **Step 2: Crear el barrel**

Crear `src/components/ui3d/index.ts`:

```ts
export { default as TiltCard } from './TiltCard';
export { default as CountUp, easeOutCubic, valueAtProgress } from './CountUp';
export { default as GaugeRing, pctToDegrees } from './GaugeRing';
export { default as Sparkline, buildPolylinePoints } from './Sparkline';
export { default as StatTile } from './StatTile';
export type { StatTone } from './StatTile';
export { default as RankRow } from './RankRow';
export { default as AuroraBackdrop } from './AuroraBackdrop';
export { default as IconRail } from './IconRail';
export { default as HudTopbar } from './HudTopbar';
export { useTilt, rotationFromPointer } from './useTilt';
```

> El barrel referencia `IconRail` y `HudTopbar`, que se crean en las Tasks 10 y 11. Hasta entonces el import falla — por eso el barrel se commitea recién en la Task 11, no acá.

- [ ] **Step 3: Verificar que la suite completa sigue verde**

Run: `npm run test`
Expected: PASS — los tests previos del repo más los 48 nuevos de `ui3d`
(useTilt 8 · TiltCard 5 · CountUp 9 · GaugeRing 6 · Sparkline 7 · StatTile 6 · RankRow 7).

- [ ] **Step 4: Commit (solo AuroraBackdrop)**

```bash
git add src/components/ui3d/AuroraBackdrop.tsx
git commit -m "feat(ui3d): AuroraBackdrop con blobs flotantes y retícula en perspectiva"
```

---

# TANDA 1 — Shell: rail + topbar HUD

### Task 10: `IconRail`

**Files:**
- Create: `src/components/ui3d/IconRail.tsx`
- Test: `src/components/ui3d/IconRail.test.tsx`

Rail de 80px con **ícono + micro-label** — desviación deliberada del mockup (que es solo-ícono con tooltip), documentada en el spec: las asesoras navegan por la palabra y el tooltip no existe en táctil.

- [ ] **Step 1: Escribir el test que falla**

Crear `src/components/ui3d/IconRail.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BarChart3, Phone, Package } from 'lucide-react';
import IconRail from './IconRail';

const ITEMS = [
  { path: '/dashboard', icon: BarChart3, label: 'Dashboard' },
  { path: '/confirmar', icon: Phone, label: 'Confirmar' },
  { path: '/seguimiento', icon: Package, label: 'Seguimiento' },
];

describe('IconRail', () => {
  it('muestra el micro-label de cada ítem', () => {
    render(<IconRail items={ITEMS} activePath="/confirmar" onNavigate={() => {}} />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Confirmar')).toBeInTheDocument();
    expect(screen.getByText('Seguimiento')).toBeInTheDocument();
  });

  it('marca el ítem activo con aria-current', () => {
    render(<IconRail items={ITEMS} activePath="/confirmar" onNavigate={() => {}} />);
    expect(screen.getByRole('button', { name: /Confirmar/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /Dashboard/ })).not.toHaveAttribute('aria-current');
  });

  it('considera activo un sub-path (ej. /seguimiento?lista=x)', () => {
    render(<IconRail items={ITEMS} activePath="/seguimiento/detalle" onNavigate={() => {}} />);
    expect(screen.getByRole('button', { name: /Seguimiento/ })).toHaveAttribute('aria-current', 'page');
  });

  it('llama onNavigate con el path al hacer click', () => {
    const onNavigate = vi.fn();
    render(<IconRail items={ITEMS} activePath="/dashboard" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: /Confirmar/ }));
    expect(onNavigate).toHaveBeenCalledWith('/confirmar');
  });

  it('expone un nav con etiqueta accesible', () => {
    render(<IconRail items={ITEMS} activePath="/dashboard" onNavigate={() => {}} />);
    expect(screen.getByRole('navigation', { name: 'Secciones del CRM' })).toBeInTheDocument();
  });

  it('renderiza el contenido de top y bottom', () => {
    render(
      <IconRail
        items={ITEMS}
        activePath="/dashboard"
        onNavigate={() => {}}
        top={<span>marca</span>}
        bottom={<span>usuario</span>}
      />,
    );
    expect(screen.getByText('marca')).toBeInTheDocument();
    expect(screen.getByText('usuario')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/components/ui3d/IconRail.test.tsx`
Expected: FAIL — `Failed to resolve import "./IconRail"`.

- [ ] **Step 3: Implementar el componente**

Crear `src/components/ui3d/IconRail.tsx`:

```tsx
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export interface RailItem {
  path: string;
  icon: LucideIcon;
  label: string;
}

interface IconRailProps {
  items: RailItem[];
  activePath: string;
  onNavigate: (path: string) => void;
  /** Bloque de marca / selector de tienda, arriba del nav. */
  top?: ReactNode;
  /** Bloque de usuario, al pie. */
  bottom?: ReactNode;
  className?: string;
}

/**
 * Rail de navegación de 80px: ícono con chip + micro-label en mono.
 *
 * El mockup pide solo-ícono con tooltip al hover; acá va con micro-label
 * porque las asesoras navegan por la palabra y el tooltip no existe en
 * táctil (decisión registrada en el spec).
 *
 * Presentación pura: recibe los ítems ya filtrados por rol y un callback de
 * navegación. No conoce roles, rutas ni react-router.
 */
export default function IconRail({
  items, activePath, onNavigate, top, bottom, className = '',
}: IconRailProps) {
  return (
    <div className={`w-20 flex flex-col flex-shrink-0 h-full ${className}`}>
      {top && <div className="flex-shrink-0">{top}</div>}

      <nav aria-label="Secciones del CRM" className="flex-1 overflow-y-auto py-3 px-2 space-y-1">
        {items.map(item => {
          const Icon = item.icon;
          const isActive = activePath.startsWith(item.path);
          return (
            <button
              key={item.path}
              onClick={() => onNavigate(item.path)}
              aria-current={isActive ? 'page' : undefined}
              className={[
                'w-full flex flex-col items-center gap-1 py-2.5 rounded-xl cursor-pointer',
                'transition-colors duration-200',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                isActive
                  ? 'bg-accent/14 border border-accent/30 text-accent glow-accent'
                  : 'border border-transparent text-muted-foreground hover:text-foreground hover:bg-card/60',
              ].join(' ')}
            >
              <Icon size={19} aria-hidden="true" />
              <span
                className="font-mono text-[9px] uppercase tracking-[0.08em] leading-none truncate max-w-full px-1"
              >
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>

      {bottom && <div className="flex-shrink-0">{bottom}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Correr los tests**

Run: `npx vitest run src/components/ui3d/IconRail.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui3d/IconRail.tsx src/components/ui3d/IconRail.test.tsx
git commit -m "feat(ui3d): IconRail de 80px con ícono y micro-label"
```

---

### Task 11: `HudTopbar` + barrel

**Files:**
- Create: `src/components/ui3d/HudTopbar.tsx`
- Test: `src/components/ui3d/HudTopbar.test.tsx`
- Create: `src/components/ui3d/index.ts` (contenido ya definido en la Task 9, Step 2)

- [ ] **Step 1: Escribir el test que falla**

Crear `src/components/ui3d/HudTopbar.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HudTopbar from './HudTopbar';

describe('HudTopbar', () => {
  it('muestra el título', () => {
    render(<HudTopbar title="Confirmar" />);
    expect(screen.getByRole('heading', { name: 'Confirmar' })).toBeInTheDocument();
  });

  it('muestra la sección en mayúsculas separada por barra', () => {
    render(<HudTopbar title="Confirmar" section="cola de llamadas" />);
    expect(screen.getByText('/ COLA DE LLAMADAS')).toBeInTheDocument();
  });

  it('omite la sección cuando no se pasa', () => {
    render(<HudTopbar title="Confirmar" />);
    expect(screen.queryByText(/^\//)).toBeNull();
  });

  it('muestra el chip de sistema en línea', () => {
    render(<HudTopbar title="X" />);
    expect(screen.getByText('Sistema en línea')).toBeInTheDocument();
  });

  it('muestra el botón de menú solo cuando hay onMenu', () => {
    const { rerender } = render(<HudTopbar title="X" />);
    expect(screen.queryByRole('button', { name: 'Abrir menú' })).toBeNull();
    rerender(<HudTopbar title="X" onMenu={() => {}} />);
    expect(screen.getByRole('button', { name: 'Abrir menú' })).toBeInTheDocument();
  });

  it('llama onMenu al hacer click', () => {
    const onMenu = vi.fn();
    render(<HudTopbar title="X" onMenu={onMenu} />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir menú' }));
    expect(onMenu).toHaveBeenCalledTimes(1);
  });

  it('renderiza el slot derecho', () => {
    render(<HudTopbar title="X" right={<span>reloj</span>} />);
    expect(screen.getByText('reloj')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/components/ui3d/HudTopbar.test.tsx`
Expected: FAIL — `Failed to resolve import "./HudTopbar"`.

- [ ] **Step 3: Implementar el componente**

Crear `src/components/ui3d/HudTopbar.tsx`:

```tsx
import { Menu } from 'lucide-react';
import type { ReactNode } from 'react';

interface HudTopbarProps {
  title: string;
  /** Subtítulo mono tras una barra (ej. "/ COLA DE LLAMADAS"). */
  section?: string;
  /** Reloj, toggle de tema, avatar. */
  right?: ReactNode;
  /** Si se pasa, aparece el botón hamburguesa (solo móvil). */
  onMenu?: () => void;
}

/**
 * Barra superior HUD de 52px: título de sección, rótulo mono, chip de estado
 * y slot derecho.
 *
 * Presentación pura: no sabe qué ruta está activa ni quién es el usuario;
 * recibe strings y nodos.
 */
export default function HudTopbar({ title, section, right, onMenu }: HudTopbarProps) {
  return (
    <header className="h-[52px] flex-shrink-0 flex items-center justify-between gap-3 px-4 border-b border-border bg-surface/80">
      <div className="flex items-center gap-3 min-w-0">
        {onMenu && (
          <button
            onClick={onMenu}
            aria-label="Abrir menú"
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-card transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <Menu size={18} aria-hidden="true" />
          </button>
        )}
        <h1 className="text-sm font-semibold text-foreground truncate">{title}</h1>
        {section && (
          <span className="hud-label truncate hidden sm:block">/ {section.toUpperCase()}</span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="hidden md:inline-flex items-center gap-2 hud-label" style={{ color: 'hsl(var(--cyan))' }}>
          <span
            aria-hidden="true"
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: 'hsl(var(--cyan))', boxShadow: '0 0 8px hsl(var(--cyan))', animation: 'gb-pulse 2s infinite' }}
          />
          Sistema en línea
        </span>
        {right}
      </div>
    </header>
  );
}
```

- [ ] **Step 4: Correr los tests**

Run: `npx vitest run src/components/ui3d/HudTopbar.test.tsx`
Expected: PASS — 7 tests.

- [ ] **Step 5: Crear el barrel**

Crear `src/components/ui3d/index.ts` con exactamente el contenido definido en la Task 9, Step 2.

- [ ] **Step 6: Verificar la suite completa**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/ui3d/HudTopbar.tsx src/components/ui3d/HudTopbar.test.tsx src/components/ui3d/index.ts
git commit -m "feat(ui3d): HudTopbar de 52px con rótulo mono y chip de sistema; barrel"
```

---

### Task 12: Cablear el shell en `ProtectedLayout`

**Files:**
- Modify: `src/components/ProtectedLayout.tsx:184-294`

Se reemplaza el `<aside>` (líneas 184-267) y el `<header>` (líneas 270-294). **Todo lo demás del archivo queda intacto**: los providers, el heartbeat, la redención de invitación, los tres early-returns, el filtrado de `NAV_ITEMS`, `orderedTabs` y `OpeningReportGate`.

- [ ] **Step 1: Agregar el import**

En `src/components/ProtectedLayout.tsx`, después de la línea 20 (`import type { LucideIcon } ...`):

```tsx
import { IconRail, HudTopbar, AuroraBackdrop } from '@/components/ui3d';
```

- [ ] **Step 2: Reemplazar el `<aside>`**

Reemplazar íntegramente el bloque de las líneas 184-267 por:

```tsx
        <aside
          aria-label="Navegación principal"
          className={[
            'flex flex-col flex-shrink-0 z-50',
            'bg-surface/70 border-r border-border',
            isMobile
              ? 'fixed inset-y-0 left-0 w-64 transition-transform duration-300 ease-out'
              : 'relative',
            isMobile && !sidebarOpen ? '-translate-x-full' : 'translate-x-0',
          ].join(' ')}
        >
          <IconRail
            className={isMobile ? 'w-64' : 'w-20'}
            items={orderedTabs}
            activePath={activePath}
            onNavigate={(path) => { navigate(path); if (isMobile) setSidebarOpen(false); }}
            top={
              <>
                <div className="h-[52px] px-2 flex items-center justify-center border-b border-border">
                  <div
                    className="w-9 h-9 rounded-xl bg-accent-gradient flex items-center justify-center shadow-glow overflow-hidden"
                    title={brandName}
                  >
                    {brandLogoUrl
                      ? <img src={brandLogoUrl} alt="" className="w-full h-full object-cover" />
                      : <Package size={17} className="text-white" aria-hidden="true" />}
                  </div>
                  {isMobile && (
                    <button
                      onClick={() => setSidebarOpen(false)}
                      aria-label="Cerrar menú"
                      className="ml-auto p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-card transition-colors duration-200 cursor-pointer"
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
                <div className="px-2 pt-2">
                  <StoreSelector />
                </div>
              </>
            }
            bottom={
              <div className="p-2 border-t border-border flex flex-col items-center gap-1.5">
                <div
                  className="w-9 h-9 rounded-xl bg-accent/20 border border-accent/30 flex items-center justify-center text-xs font-bold text-accent"
                  title={`${profile?.display_name || 'Usuario'} · ${
                    isAdmin ? 'Administrador'
                    : store.activeStore?.role === 'owner' ? 'Dueño'
                    : store.activeStore?.role === 'supervisor' ? 'Supervisor'
                    : 'Operadora'
                  }`}
                  aria-hidden="true"
                >
                  {userInitial}
                </div>
                <button
                  onClick={signOut}
                  aria-label="Cerrar sesión"
                  title="Cerrar sesión"
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-card transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                >
                  <LogOut size={14} />
                </button>
              </div>
            }
          />
        </aside>
```

> `StoreSelector` queda dentro del rail de 80px. Verificar en el Step 5 que no se desborda; si lo hace, envolverlo en `overflow-hidden` — **no** cambiar su código.

- [ ] **Step 3: Reemplazar el `<header>`**

Reemplazar íntegramente el bloque de las líneas 270-294 por:

```tsx
          <HudTopbar
            title={activeLabel}
            section={brandName}
            onMenu={isMobile ? () => setSidebarOpen(true) : undefined}
            right={
              <>
                <LiveClock />
                <button onClick={toggleTheme}
                  aria-label={theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
                  className="w-8 h-8 rounded-lg bg-card border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
                  {theme === 'dark' ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
                </button>
                <div className="w-8 h-8 rounded-lg bg-accent/20 border border-accent/30 flex items-center justify-center text-xs font-bold text-accent"
                  aria-label={`Usuario: ${profile?.display_name || 'Usuario'}`}
                  title={profile?.display_name || 'Usuario'}>
                  {userInitial}
                </div>
              </>
            }
          />
```

- [ ] **Step 4: Poner la aurora detrás del contenido**

Reemplazar el `<main>` (que tras los pasos anteriores queda justo debajo del `HudTopbar`) por:

```tsx
          <main className="relative flex-1 overflow-y-auto p-4 md:p-6 bg-aurora">
            <AuroraBackdrop />
            <div className="relative">
              <OpeningReportGate>
                <div className="mb-3"><SyncFreshness /></div>
                {isConfirmar && <CounterBar />}
                <Suspense fallback={<InlineRouteLoader />}>
                  <Outlet />
                </Suspense>
              </OpeningReportGate>
            </div>
          </main>
```

- [ ] **Step 5: Verificar en vivo**

```bash
npm run dev
```

Abrir `http://localhost:8080` y comprobar, **en tema oscuro y claro**:
- El rail mide 80px y cada ítem muestra ícono + palabra.
- El ítem activo tiene fondo índigo y glow; navegar cambia el activo.
- La topbar mide 52px y muestra `Título / NOMBRE-TIENDA` y el chip cian latiendo.
- `StoreSelector` no se desborda del rail.
- El contenido de la página se ve por encima de la aurora (no queda tapado).
- A 375px (DevTools) el rail se colapsa y la hamburguesa lo abre y lo cierra.

- [ ] **Step 6: Verificar tests y build**

Run: `npm run test && npm run build`
Expected: ambos PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/ProtectedLayout.tsx
git commit -m "feat(shell): rail de 80px con micro-label + topbar HUD 52px + aurora"
```

---

# TANDA 2 — Dashboard

> Antes de empezar: releer `src/components/tabs/DashboardTab.tsx` completo. Los números de línea de abajo son del archivo **antes** de esta tanda; cada paso los corre.

### Task 13: Hero del Dashboard con `GaugeRing`

**Files:**
- Modify: `src/components/tabs/DashboardTab.tsx:506-533`

- [ ] **Step 1: Agregar el import**

Junto a los demás imports de `DashboardTab.tsx`:

```tsx
import { TiltCard, GaugeRing, StatTile, RankRow } from '@/components/ui3d';
```

- [ ] **Step 2: Reemplazar la card hero**

Reemplazar el bloque de las líneas 508-533 (el `<div className="md:col-span-4 bg-surface ...">` completo, hasta su `</div>` de cierre) por:

```tsx
            {/* Hero: Tasa de confirmación */}
            <TiltCard
              sheen
              brackets
              className="md:col-span-4 bg-card/40 border border-border rounded-3xl p-6 flex flex-col items-center gap-4"
            >
              <div className="w-full flex items-center justify-between">
                <span
                  className="hud-label"
                  title="Tasa personal: tus confirmados / los que tuvieron respuesta hoy (conf+canc, SIN noresp). Es la confirmación madura estándar COD. NO sobre el inflow total del día — eso lo ves en /admin → Productividad."
                >
                  Tasa personal
                </span>
                <TrendBadge current={tasa} previous={yesterdayData.tasa} suffix="%" />
              </div>

              <GaugeRing value={tasa} label="confirmación" size={190} />

              <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold ${tasaBg} ${tasaColor}`}>
                {tasa >= CONF_TARGET_PCT ? `En meta (${CONF_TARGET_PCT}%)` : tasa >= CONF_TARGET_PCT - 5 ? 'Cerca de la meta' : 'Por debajo de la meta'}
              </div>
            </TiltCard>
```

> El texto de los tres estados de meta y el `title` largo se copian **carácter por carácter** del original. `tasaBg`, `tasaColor`, `CONF_TARGET_PCT`, `TrendBadge` y `yesterdayData` ya existen en el archivo — no se declara nada nuevo.
>
> `tasaStroke` queda sin uso tras este cambio: eliminar su declaración solo si ESLint la marca como no usada (el repo tiene `noUnusedLocals: false`, así que puede no quejarse; `npm run lint` es el árbitro).

- [ ] **Step 3: Verificar**

Run: `npm run test && npm run lint && npm run build`
Expected: los tres PASS.

- [ ] **Step 4: Verificar en vivo**

`npm run dev` → `http://localhost:8080/dashboard`. El anillo debe animarse al montar y llegar al mismo porcentaje que mostraba antes.

- [ ] **Step 5: Commit**

```bash
git add src/components/tabs/DashboardTab.tsx
git commit -m "style(dashboard): hero con GaugeRing, sheen y brackets"
```

---

### Task 14: KPIs del Dashboard con `StatTile`

**Files:**
- Modify: `src/components/tabs/DashboardTab.tsx` (el bloque `{[...].map(...)}` de KPIs compactos, líneas 536-568 del archivo original)

- [ ] **Step 1: Reemplazar el bloque de KPIs**

Reemplazar íntegramente el `{[ ... ].map((k) => { ... })}` por:

```tsx
            {/* Compact KPIs */}
            {[
              { icon: CheckCircle2, label: 'Confirmados', value: counter.conf, prev: yesterdayData.conf, tone: 'success' as const, spark: sparkData.conf },
              { icon: XCircle, label: 'Cancelados', value: counter.canc, prev: yesterdayData.canc, tone: 'danger' as const, spark: sparkData.canc },
              { icon: PhoneOff, label: 'No respondió', value: counter.noresp, prev: yesterdayData.noresp, tone: 'neutral' as const, spark: [] as number[] },
              { icon: Package, label: 'Total pedidos', value: totalOrders, prev: 0, tone: 'accent' as const, spark: sparkData.total, extra: `${statusBreakdown.pendientes} pendientes` },
            ].map((k) => (
              <div key={k.label} className="md:col-span-2">
                <StatTile
                  icon={k.icon}
                  label={k.label}
                  value={k.value}
                  tone={k.tone}
                  spark={k.spark}
                  extra={
                    k.extra
                      ? <span className="text-[11px] font-medium text-accent">{k.extra}</span>
                      : <TrendBadge current={k.value} previous={k.prev} />
                  }
                />
              </div>
            ))}
```

> Las etiquetas quedan idénticas: "Confirmados", "Cancelados", "No respondió", "Total pedidos". `MiniSparkline`, `CHART_SUCCESS`, `CHART_DANGER` y `CHART_ACCENT` dejan de usarse **acá** pero siguen usados por los gráficos de la Task 15 — no borrarlos.

- [ ] **Step 2: Verificar**

Run: `npm run test && npm run lint && npm run build`
Expected: los tres PASS.

- [ ] **Step 3: Verificar en vivo**

`npm run dev` → `/dashboard`. Las 4 tarjetas deben inclinarse al pasar el mouse, las cifras subir desde 0, y la de valor 0 verse atenuada.

- [ ] **Step 4: Commit**

```bash
git add src/components/tabs/DashboardTab.tsx
git commit -m "style(dashboard): KPIs compactos con StatTile"
```

---

### Task 15: Gráficos restilizados y ranking con `RankRow`

**Files:**
- Modify: `src/components/tabs/DashboardTab.tsx` (bloque de gráficos, líneas 572-619 del original; bloque de ranking, líneas 622+)

Los gráficos **siguen en recharts** — solo cambia el envoltorio y el trazo. La razón está en el spec: el selector 7d/15d/30d hace inviable el diseño de barras con números adentro del mockup.

- [ ] **Step 1: Envolver los dos gráficos en `TiltCard`**

Reemplazar `<div className="bg-surface border border-border rounded-xl p-5 hover:border-border-strong transition-colors duration-200">` por `<TiltCard className="bg-card/40 border border-border rounded-2xl p-5">` en **ambos** gráficos, y sus `</div>` de cierre correspondientes por `</TiltCard>`.

- [ ] **Step 2: Dar el trazo con gradiente a la línea de tasa**

Dentro del `<AreaChart>`, agregar un segundo gradiente al `<defs>` existente, después del `tGrad`:

```tsx
                      <linearGradient id="tLine" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor={CHART_ACCENT} />
                        <stop offset="100%" stopColor="hsl(var(--cyan))" />
                      </linearGradient>
```

Y cambiar el `<Area>` para que use ese trazo con glow:

```tsx
                    <Area type="monotone" dataKey="tasa" stroke="url(#tLine)" strokeWidth={3} fill="url(#tGrad)" style={{ filter: `drop-shadow(0 0 8px ${CHART_ACCENT})` }} dot={{ r: 2, fill: CHART_ACCENT, strokeWidth: 0 }} activeDot={{ r: 4, strokeWidth: 2, stroke: hsl('--background') }} />
```

- [ ] **Step 3: Redondear la barra superior del apilado**

En el `<BarChart>`, cambiar solo el `radius` de la última barra apilada para que la pila cierre redondeada:

```tsx
                    <Bar dataKey="noresp" stackId="a" fill={CHART_MUTED} radius={[6, 6, 0, 0]} name="noresp" />
```

> Las tres `<Bar>` mantienen sus `dataKey`, `stackId`, `fill` y `name`. La leyenda y su `formatter` no se tocan: "Confirmados" / "Cancelados" / "No respondió" siguen igual.

- [ ] **Step 4: Reemplazar la tabla de ranking por `RankRow`**

Reemplazar el bloque `<div className="overflow-x-auto"><table ...>...</table></div>` (dentro del `motion.div` del ranking) por:

```tsx
              <div className="p-4 flex flex-col gap-2.5">
                {operatorRanking.map((op, idx) => (
                  <RankRow
                    key={op.operatorId}
                    position={idx + 1}
                    name={op.name}
                    pct={op.tasa}
                    detail={`${op.total} gest.`}
                    isMe={op.operatorId === user?.id}
                  />
                ))}
              </div>
```

> Campos verificados contra `interface OperatorStat` (`DashboardTab.tsx:60`):
> `{ name, operatorId, conf, canc, noresp, total, tasa }`. Es `name`, **no** `displayName`.
>
> El encabezado de la tarjeta (`Users` + "Ranking del equipo hoy") **se conserva tal cual**. Se pierde el tooltip de la columna "Tasa pers." al desaparecer el `<th>`: moverlo al encabezado de la tarjeta como `title` para no perder la explicación:
>
> ```tsx
> <h3 className="text-sm font-semibold text-foreground" title="Tasa personal de cada operadora: confirmados / lo gestionado (conf+canc+noresp). NO sobre el inflow total del día.">Ranking del equipo hoy</h3>
> ```

- [ ] **Step 5: Verificar**

Run: `npm run test && npm run lint && npm run build`
Expected: los tres PASS.

- [ ] **Step 6: Verificar en vivo — revisión completa de la tanda**

`npm run dev` → `/dashboard`, en **oscuro y claro**, y a **375px**:
- Los dos gráficos siguen respondiendo al hover con tooltip y leyenda.
- Cambiar el período 7d/15d/30d actualiza ambos gráficos.
- El ranking muestra a cada operadora con su barra; la fila propia lleva "Tú" y glow.
- Los números del ranking coinciden con los que mostraba la tabla anterior.
- A 375px las tarjetas no se inclinan y los grids caen a 1-2 columnas.

- [ ] **Step 7: Commit**

```bash
git add src/components/tabs/DashboardTab.tsx
git commit -m "style(dashboard): gráficos con trazo gradiente y ranking con RankRow"
```

---

### Task 16: Cierre de las tandas 0-2

- [ ] **Step 1: Suite completa y build limpio**

```bash
npm run test && npm run lint && npm run build
```
Expected: los tres PASS.

- [ ] **Step 2: Auditar el diff en busca de cambios funcionales**

```bash
git diff main...redesign/3d-command-center -- src/components/ProtectedLayout.tsx src/components/tabs/DashboardTab.tsx
```

Revisar que en esos dos archivos **no** aparezcan: `useEffect` nuevos, `supabase.`, `useState` de datos, cambios en arrays de dependencias, ni textos modificados. Si aparece algo, revertir ese pedazo.

- [ ] **Step 3: Subir la rama**

```bash
git push -u origin redesign/3d-command-center
```

- [ ] **Step 4: Reportar al dueño**

Resumir qué entró (capa `ui3d`, shell, Dashboard), qué falta (tandas 3-9) y pedirle que mire la rama antes de seguir.

---

## Notas para quien ejecute

- **No mergear a `main` todavía.** Las tandas 3-9 van en la misma rama y el PR se abre al final. (Excepción a la autorización permanente de auto-merge: acá el dueño pidió explícitamente rama + PR al final.)
- **Ninguna tarea toca edge functions ni migraciones.** Si una parece necesitarlo, es señal de que se salió del alcance.
- Si un test del repo que ya existía se pone rojo, **no ajustar el test**: significa que el rediseño cambió comportamiento. Parar y reportar.
