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
  matchBackMs: 1 * DAY,
  matchFwdMs: 45 * DAY,
  ...over,
});

/** Pedido Shopify con edad en minutos y teléfono. */
function ord(id: string, ageMin: number, phoneLast9 = "999593016"): ShopifyPendingLike {
  return { shopify_order_id: id, phoneLast9, createdAtMs: NOW - ageMin * MIN };
}
/** Map teléfono → [fechas de órdenes Dropi], por edad en minutos. */
function dropi(phone: string, ...ageMins: number[]): Map<string, number[]> {
  return new Map([[phone, ageMins.map((m) => NOW - m * MIN)]]);
}

describe("selectAutoPushCandidates", () => {
  it("sube un pedido limpio, con teléfono, pasada la gracia y no en Dropi", () => {
    const out = selectAutoPushCandidates([ord("A", 45)], new Map(), new Map(), baseOpts());
    expect(out.map((o) => o.shopify_order_id)).toEqual(["A"]);
  });

  it("NO toca un pedido más nuevo que la gracia (30 min) — Dropify puede subirlo solo", () => {
    const out = selectAutoPushCandidates([ord("A", 10)], new Map(), new Map(), baseOpts());
    expect(out).toHaveLength(0);
  });

  it("respeta el borde exacto de la gracia (>= minAge entra)", () => {
    const justAtGrace = { ...ord("A", 0), createdAtMs: NOW - 30 * MIN }; // edad == 30 min
    const out = selectAutoPushCandidates([justAtGrace], new Map(), new Map(), baseOpts());
    expect(out).toHaveLength(1);
  });

  it("NO persigue pedidos más viejos que el techo (3 días)", () => {
    const out = selectAutoPushCandidates([ord("A", 4 * 24 * 60)], new Map(), new Map(), baseOpts());
    expect(out).toHaveLength(0);
  });

  it("salta pedidos sin teléfono usable", () => {
    const out = selectAutoPushCandidates([ord("A", 45, "")], new Map(), new Map(), baseOpts());
    expect(out).toHaveLength(0);
  });

  // ── MISMO PEDIDO vs RECOMPRA (el fix del 2026-07-18) ──────────────────────
  it("NO sube si el MISMO pedido ya está en Dropi (orden Dropi cercana a la fecha)", () => {
    // pedido Shopify de hace 45 min, orden Dropi del mismo teléfono hace 40 min
    const d = dropi("999593016", 40);
    const out = selectAutoPushCandidates([ord("A", 45, "999593016")], d, new Map(), baseOpts());
    expect(out).toHaveLength(0);
  });

  it("SÍ sube una RECOMPRA: mismo teléfono pero su única orden Dropi es VIEJA (entregada)", () => {
    // pedido Shopify de hace 45 min, orden Dropi anterior de hace 90 días
    const d = dropi("999593016", 90 * 24 * 60);
    const out = selectAutoPushCandidates([ord("A", 45, "999593016")], d, new Map(), baseOpts());
    expect(out.map((o) => o.shopify_order_id)).toEqual(["A"]);
  });

  it("con varias órdenes Dropi (vieja + una cercana) cuenta la cercana → NO sube", () => {
    const d = dropi("999593016", 90 * 24 * 60, 42); // una vieja y una del mismo pedido
    const out = selectAutoPushCandidates([ord("A", 45, "999593016")], d, new Map(), baseOpts());
    expect(out).toHaveLength(0);
  });

  it("NO reintenta un pedido ya 'created' (idempotencia)", () => {
    const pushed = new Map<string, PushedRecord>([["A", { status: "created", pushedAtMs: NOW - HOUR }]]);
    const out = selectAutoPushCandidates([ord("A", 45)], new Map(), pushed, baseOpts());
    expect(out).toHaveLength(0);
  });

  it("NO reintenta un pedido 'pending' ni 'unknown' (en curso / requiere verificación humana)", () => {
    const pushed = new Map<string, PushedRecord>([
      ["A", { status: "pending", pushedAtMs: NOW - MIN }],
      ["B", { status: "unknown", pushedAtMs: NOW - 5 * HOUR }],
    ]);
    const out = selectAutoPushCandidates([ord("A", 45), ord("B", 45, "111111111")], new Map(), pushed, baseOpts());
    expect(out).toHaveLength(0);
  });

  it("un 'error' reciente NO se reintenta (enfriamiento); uno viejo SÍ", () => {
    const reciente = new Map<string, PushedRecord>([["A", { status: "error", pushedAtMs: NOW - 30 * MIN }]]);
    expect(selectAutoPushCandidates([ord("A", 45)], new Map(), reciente, baseOpts())).toHaveLength(0);

    const viejo = new Map<string, PushedRecord>([["A", { status: "error", pushedAtMs: NOW - 3 * HOUR }]]);
    expect(selectAutoPushCandidates([ord("A", 45)], new Map(), viejo, baseOpts())).toHaveLength(1);
  });

  it("ordena del más viejo al más nuevo y respeta el cap", () => {
    const orders = [ord("nuevo", 40), ord("viejo", 200, "222222222"), ord("medio", 90, "333333333")];
    const out = selectAutoPushCandidates(orders, new Map(), new Map(), baseOpts({ cap: 2 }));
    expect(out.map((o) => o.shopify_order_id)).toEqual(["viejo", "medio"]);
  });

  it("cap = 0 significa sin tope (devuelve todos los elegibles)", () => {
    const orders = [ord("A", 40), ord("B", 90, "222222222"), ord("C", 120, "333333333")];
    const out = selectAutoPushCandidates(orders, new Map(), new Map(), baseOpts({ cap: 0 }));
    expect(out).toHaveLength(3);
  });
});
