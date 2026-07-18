import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { renderHook, act } from '@testing-library/react';
import { CheckCircle2, BarChart3, Phone, Package } from 'lucide-react';

import { useTilt, rotationFromPointer } from './useTilt';
import { easeOutCubic, valueAtProgress } from './useCountUp';
import CountUp from './CountUp';
import TiltCard from './TiltCard';
import GaugeRing, { pctToDegrees } from './GaugeRing';
import Sparkline, { buildPolylinePoints } from './Sparkline';
import StatTile from './StatTile';
import RankRow from './RankRow';
import IconRail from './IconRail';
import HudTopbar from './HudTopbar';

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

// ─────────────────────────── useTilt ───────────────────────────

describe('rotationFromPointer', () => {
  const rect = { left: 0, top: 0, width: 200, height: 100 };

  it('no rota en el centro exacto', () => {
    expect(rotationFromPointer(100, 50, rect, 6)).toEqual({ rx: 0, ry: 0 });
  });

  it('llega al máximo en las esquinas', () => {
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

  it('no divide por cero con un rect de tamaño 0', () => {
    expect(rotationFromPointer(10, 10, { left: 0, top: 0, width: 0, height: 0 }, 6))
      .toEqual({ rx: 0, ry: 0 });
  });
});

describe('useTilt', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { writable: true, value: 1366 });
  });

  it('queda habilitado con puntero fino, pantalla ancha y sin reduced-motion', () => {
    stubMatchMedia({ '(pointer: fine)': true, '(prefers-reduced-motion: reduce)': false });
    const { result } = renderHook(() => useTilt());
    expect(result.current.enabled).toBe(true);
  });

  it('queda DESHABILITADO en táctil', () => {
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

  it('no escribe transform en el nodo si está deshabilitado', () => {
    stubMatchMedia({ '(pointer: fine)': false });
    const { result } = renderHook(() => useTilt());
    const node = document.createElement('div');
    (result.current.ref as { current: HTMLDivElement | null }).current = node;

    act(() => {
      result.current.tiltProps.onPointerMove({
        clientX: 0, clientY: 0,
        currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }) },
      } as never);
    });

    expect(node.style.transform).toBe('');
  });

  it('NO expone la rotación como estado de React (evita re-render por movimiento)', () => {
    stubMatchMedia({ '(pointer: fine)': true });
    const { result } = renderHook(() => useTilt());
    // Si volviera a existir `rotation`, cada onPointerMove re-renderizaría el
    // árbol de la card — en CallView eso re-corre el pipeline de validación
    // de dirección al ritmo del mouse.
    expect((result.current as Record<string, unknown>).rotation).toBeUndefined();
    expect(result.current.ref).toBeDefined();
  });
});

describe('useCountUp', () => {
  beforeEach(() => stubMatchMedia({}));

  it('anima desde el valor ANTERIOR, no desde 0, cuando el valor cambia', async () => {
    // Regresión real: con realtime, "por confirmar" reiniciaba desde 0 en cada
    // update y mostraba un número falso ~1.1s.
    const { rerender } = render(<CountUp value={40} duration={0} />);
    expect(screen.getByText('40')).toBeInTheDocument();

    const originalRaf = globalThis.requestAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    }) as typeof globalThis.requestAnimationFrame;

    try {
      rerender(<CountUp value={41} duration={1000} />);
      // Primer frame apenas arrancada la animación: debe estar cerca de 40,
      // nunca en 0.
      if (frames.length) act(() => { frames[0](performance.now() + 1); });
      const texto = screen.getByText(/^4[01]$/);
      expect(texto).toBeInTheDocument();
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
    }
  });
});

// ─────────────────────────── CountUp ───────────────────────────

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
    expect(valueAtProgress(3.456, 1, 2)).toBe(3.46);
  });

  it('maneja valores negativos', () => {
    expect(valueAtProgress(-40, 1)).toBe(-40);
  });
});

describe('CountUp', () => {
  beforeEach(() => stubMatchMedia({}));

  it('con duration 0 muestra el valor final de una', () => {
    render(<CountUp value={42} duration={0} />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('termina en el valor final cuando la animación corre', async () => {
    // jsdom no avanza requestAnimationFrame solo: lo empujamos con un reloj
    // que salta muy por delante del duration para forzar el último frame.
    const originalRaf = globalThis.requestAnimationFrame;
    let clock = performance.now();
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      clock += 1000;
      setTimeout(() => cb(clock), 0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;

    try {
      render(<CountUp value={86} duration={20} />);
      await waitFor(() => expect(screen.getByText('86')).toBeInTheDocument());
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
    }
  });

  it('acepta sufijo', () => {
    render(<CountUp value={7} duration={0} suffix="%" />);
    expect(screen.getByText('7%')).toBeInTheDocument();
  });

  it('usa mono con tabular-nums (regla de oro del handoff)', () => {
    const { container } = render(<CountUp value={7} duration={0} />);
    const span = container.querySelector('span');
    expect(span?.className).toContain('font-mono');
    expect(span?.className).toContain('tabular-nums');
  });
});

// ─────────────────────────── TiltCard ───────────────────────────

describe('TiltCard', () => {
  beforeEach(() => stubMatchMedia({}));

  it('renderiza sus hijos', () => {
    render(<TiltCard><span>contenido</span></TiltCard>);
    expect(screen.getByText('contenido')).toBeInTheDocument();
  });

  it('siempre lleva la clase tilt-3d', () => {
    const { container } = render(<TiltCard>x</TiltCard>);
    expect(container.querySelector('.tilt-3d')).toBeTruthy();
  });

  it('aplica className a la card interna', () => {
    const { container } = render(<TiltCard className="mi-clase">x</TiltCard>);
    expect(container.querySelector('.mi-clase')).toBeTruthy();
  });

  it('muestra el sheen solo cuando se pide', () => {
    const { container: sin } = render(<TiltCard>x</TiltCard>);
    expect(sin.querySelector('.sheen')).toBeNull();
    const { container: con } = render(<TiltCard sheen>x</TiltCard>);
    expect(con.querySelector('.sheen')).toBeTruthy();
  });

  it('muestra los dos brackets cuando se piden', () => {
    const { container } = render(<TiltCard brackets>x</TiltCard>);
    expect(container.querySelectorAll('.corner-bracket')).toHaveLength(2);
  });
});

// ─────────────────────────── GaugeRing ───────────────────────────

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
  beforeEach(() => stubMatchMedia({}));

  it('muestra el porcentaje y su etiqueta', () => {
    render(<GaugeRing value={86} label="confirmación" duration={0} />);
    expect(screen.getByText('86')).toBeInTheDocument();
    expect(screen.getByText('confirmación')).toBeInTheDocument();
  });

  it('expone el valor a lectores de pantalla', () => {
    render(<GaugeRing value={86} label="confirmación" duration={0} />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '86');
  });
});

// ─────────────────────────── Sparkline ───────────────────────────

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

  it('invierte el eje Y: el valor mayor queda arriba', () => {
    const [bajo, alto] = buildPolylinePoints([0, 10], 120, 30).split(' ');
    expect(Number(alto.split(',')[1])).toBeLessThan(Number(bajo.split(',')[1]));
  });

  it('no divide por cero cuando todos los valores son iguales', () => {
    expect(buildPolylinePoints([7, 7, 7], 120, 30)).not.toContain('NaN');
  });
});

describe('Sparkline', () => {
  it('no renderiza nada con menos de 2 puntos', () => {
    const { container } = render(<Sparkline data={[1]} color="red" />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renderiza una polyline con 2+ puntos', () => {
    const { container } = render(<Sparkline data={[1, 4, 2]} color="red" />);
    expect(container.querySelector('polyline')).toBeTruthy();
  });

  it('se oculta a lectores de pantalla (es decorativo)', () => {
    const { container } = render(<Sparkline data={[1, 4, 2]} color="red" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

// ─────────────────────────── StatTile ───────────────────────────

describe('StatTile', () => {
  beforeEach(() => stubMatchMedia({}));

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

  it('propaga el title para conservar los tooltips explicativos', () => {
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

// ─────────────────────────── RankRow ───────────────────────────

describe('RankRow', () => {
  it('muestra posición, nombre y porcentaje', () => {
    render(<RankRow position={1} name="Mayra" pct={86} />);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText(/Mayra/)).toBeInTheDocument();
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

  it('recorta el ancho de la barra a 100%', () => {
    const { container } = render(<RankRow position={1} name="X" pct={140} />);
    expect((container.querySelector('[data-testid="rank-bar-fill"]') as HTMLElement).style.width).toBe('100%');
  });

  it('no deja ancho negativo', () => {
    const { container } = render(<RankRow position={1} name="X" pct={-10} />);
    expect((container.querySelector('[data-testid="rank-bar-fill"]') as HTMLElement).style.width).toBe('0%');
  });
});

// ─────────────────────────── IconRail ───────────────────────────

const ITEMS = [
  { path: '/dashboard', icon: BarChart3, label: 'Dashboard' },
  { path: '/confirmar', icon: Phone, label: 'Confirmar' },
  { path: '/seguimiento', icon: Package, label: 'Seguimiento' },
];

describe('IconRail', () => {
  it('anuncia cada sección por aria-label aunque no dibuje texto', () => {
    render(<IconRail items={ITEMS} activePath="/confirmar" onNavigate={() => {}} />);
    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirmar' })).toBeInTheDocument();
  });

  it('marca el ítem activo con aria-current', () => {
    render(<IconRail items={ITEMS} activePath="/confirmar" onNavigate={() => {}} />);
    expect(screen.getByRole('button', { name: 'Confirmar' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  it('considera activo un sub-path', () => {
    render(<IconRail items={ITEMS} activePath="/seguimiento/detalle" onNavigate={() => {}} />);
    expect(screen.getByRole('button', { name: 'Seguimiento' })).toHaveAttribute('aria-current', 'page');
  });

  it('llama onNavigate con el path al hacer click', () => {
    const onNavigate = vi.fn();
    render(<IconRail items={ITEMS} activePath="/dashboard" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(onNavigate).toHaveBeenCalledWith('/confirmar');
  });

  it('dibuja el texto cuando showLabels está activo (móvil)', () => {
    render(<IconRail items={ITEMS} activePath="/dashboard" onNavigate={() => {}} showLabels />);
    expect(screen.getByText('Seguimiento')).toBeInTheDocument();
  });

  it('expone un nav con etiqueta accesible', () => {
    render(<IconRail items={ITEMS} activePath="/dashboard" onNavigate={() => {}} />);
    expect(screen.getByRole('navigation', { name: 'Secciones del CRM' })).toBeInTheDocument();
  });

  it('renderiza top y bottom', () => {
    render(
      <IconRail items={ITEMS} activePath="/dashboard" onNavigate={() => {}}
        top={<span>marca</span>} bottom={<span>usuario</span>} />,
    );
    expect(screen.getByText('marca')).toBeInTheDocument();
    expect(screen.getByText('usuario')).toBeInTheDocument();
  });
});

// ─────────────────────────── HudTopbar ───────────────────────────

describe('HudTopbar', () => {
  it('muestra el título', () => {
    render(<HudTopbar title="Confirmar" />);
    expect(screen.getByRole('heading', { name: 'Confirmar' })).toBeInTheDocument();
  });

  it('muestra la sección en mayúsculas tras una barra', () => {
    render(<HudTopbar title="Confirmar" section="operadora" />);
    expect(screen.getByText('/ OPERADORA')).toBeInTheDocument();
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
