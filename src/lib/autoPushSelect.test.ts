// Test del "cerebro" del robot de auto-push (shopify-auto-push). El módulo puro
// vive en supabase/functions/_shared/ (lo importa la edge function Deno), pero el
// suite de Vitest solo mira src/**, así que el test vive acá y cruza el límite.
import { describe, it, expect } from "vitest";
import {
  selectAutoPushCandidates,
  type ShopifyPendingLike,
  type PushedRecord,
  type SelectOpts,
} from "../../supabase/functions/_shared/autoPushSelect";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000; // instante fijo

const baseOpts = (over: Partial<SelectOpts> = {}): SelectOpts => ({
  nowMs: NOW,
  minAgeMs: 30 * MIN,
  maxAgeMs: 3 * DAY,
  errorCooldownMs: 2 * HOUR,
  cap: 20,
  ...over,
});

/** Pedido Shopify con edad en minutos y teléfono. */
function ord(id: string, ageMin: number, phoneLast9 = "999593016"): ShopifyPendingLike {
  return { shopify_order_id: id, phoneLast9, createdAtMs: NOW - ageMin * MIN };
}

describe("selectAutoPushCandidates", () => {
  it("sube un pedido limpio, con teléfono, pasada la gracia y sin orden activa", () => {
    const out = selectAutoPushCandidates([ord("A", 45)], new Set(), new Map(), baseOpts());
    expect(out.map((o) => o.shopify_order_id)).toEqual(["A"]);
  });

  it("NO toca un pedido más nuevo que la gracia (30 min) — Dropify puede subirlo solo", () => {
    const out = selectAutoPushCandidates([ord("A", 10)], new Set(), new Map(), baseOpts());
    expect(out).toHaveLength(0);
  });

  it("respeta el borde exacto de la gracia (>= minAge entra)", () => {
    const justAtGrace = { ...ord("A", 0), createdAtMs: NOW - 30 * MIN }; // edad == 30 min
    const out = selectAutoPushCandidates([justAtGrace], new Set(), new Map(), baseOpts());
    expect(out).toHaveLength(1);
  });

  it("NO persigue pedidos más viejos que el techo (3 días)", () => {
    const out = selectAutoPushCandidates([ord("A", 4 * 24 * 60)], new Set(), new Map(), baseOpts());
    expect(out).toHaveLength(0);
  });

  it("salta pedidos sin teléfono usable", () => {
    const out = selectAutoPushCandidates([ord("A", 45, "")], new Set(), new Map(), baseOpts());
    expect(out).toHaveLength(0);
  });

  // ── DUPLICADO (orden activa) vs RECOMPRA (entregada) — regla del 2026-07-18 ──
  it("NO sube si el teléfono ya tiene una orden ACTIVA en Dropi (duplicado)", () => {
    const activos = new Set(["999593016"]); // este teléfono tiene una orden en curso
    const out = selectAutoPushCandidates([ord("A", 45, "999593016")], activos, new Map(), baseOpts());
    expect(out).toHaveLength(0);
  });

  it("SÍ sube una RECOMPRA: el teléfono NO está en el set de activos (su pedido viejo fue ENTREGADO)", () => {
    // El caller no mete en `dropiActivePhones` los teléfonos cuya única orden está entregada.
    const out = selectAutoPushCandidates([ord("A", 45, "999593016")], new Set(), new Map(), baseOpts());
    expect(out.map((o) => o.shopify_order_id)).toEqual(["A"]);
  });

  it("NO reintenta un pedido ya 'created' (idempotencia)", () => {
    const pushed = new Map<string, PushedRecord>([["A", { status: "created", pushedAtMs: NOW - HOUR }]]);
    const out = selectAutoPushCandidates([ord("A", 45)], new Set(), pushed, baseOpts());
    expect(out).toHaveLength(0);
  });

  it("NO reintenta un pedido 'pending' ni 'unknown' (en curso / requiere verificación humana)", () => {
    const pushed = new Map<string, PushedRecord>([
      ["A", { status: "pending", pushedAtMs: NOW - MIN }],
      ["B", { status: "unknown", pushedAtMs: NOW - 5 * HOUR }],
    ]);
    const out = selectAutoPushCandidates([ord("A", 45), ord("B", 45, "111111111")], new Set(), pushed, baseOpts());
    expect(out).toHaveLength(0);
  });

  it("un 'error' reciente NO se reintenta (enfriamiento); uno viejo SÍ", () => {
    const reciente = new Map<string, PushedRecord>([["A", { status: "error", pushedAtMs: NOW - 30 * MIN }]]);
    expect(selectAutoPushCandidates([ord("A", 45)], new Set(), reciente, baseOpts())).toHaveLength(0);

    const viejo = new Map<string, PushedRecord>([["A", { status: "error", pushedAtMs: NOW - 3 * HOUR }]]);
    expect(selectAutoPushCandidates([ord("A", 45)], new Set(), viejo, baseOpts())).toHaveLength(1);
  });

  it("ordena del más viejo al más nuevo y respeta el cap", () => {
    const orders = [ord("nuevo", 40), ord("viejo", 200, "222222222"), ord("medio", 90, "333333333")];
    const out = selectAutoPushCandidates(orders, new Set(), new Map(), baseOpts({ cap: 2 }));
    expect(out.map((o) => o.shopify_order_id)).toEqual(["viejo", "medio"]);
  });

  it("cap = 0 significa sin tope (devuelve todos los elegibles)", () => {
    const orders = [ord("A", 40), ord("B", 90, "222222222"), ord("C", 120, "333333333")];
    const out = selectAutoPushCandidates(orders, new Set(), new Map(), baseOpts({ cap: 0 }));
    expect(out).toHaveLength(3);
  });
});
