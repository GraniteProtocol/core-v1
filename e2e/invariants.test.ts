import { describe, expect, it } from "vitest";
import { accountingHolds, accountingStats, gateStepDrift, resetAccounting } from "./invariants";

describe("accounting invariant", () => {
  it("accepts the total-assets + reserve = cash + debt identity and its rounding residue", () => {
    // 80 + 10 == 50 + 40.
    expect(accountingHolds({ totalAssets: 80n, reserve: 10n, cash: 50n, debt: 40n }).ok).toBe(true);
    // +3 units of floor-split residue is accepted.
    expect(accountingHolds({ totalAssets: 80n, reserve: 10n, cash: 50n, debt: 43n }).ok).toBe(true);
    // +4 units is real drift.
    expect(accountingHolds({ totalAssets: 80n, reserve: 10n, cash: 50n, debt: 44n }).ok).toBe(false);
    // Value appearing from nowhere is never rounding.
    expect(accountingHolds({ totalAssets: 84n, reserve: 10n, cash: 50n, debt: 40n }).ok).toBe(false);
  });

  it("gates movement by operation kind and accumulates its statistics", () => {
    resetAccounting();
    expect(gateStepDrift(0n, "non-debt").ok).toBe(true); // baseline
    expect(gateStepDrift(1n, "non-debt").ok).toBe(false); // no movement outside a debt op
    expect(gateStepDrift(1n, "debt").ok).toBe(true); // +3 allowed
    expect(gateStepDrift(4n, "debt").ok).toBe(true); // +3 delta
    expect(gateStepDrift(8n, "debt").ok).toBe(false); // +4 delta
    expect(gateStepDrift(9n, "non-debt").ok).toBe(false); // movement outside a debt op
    const stats = accountingStats();
    expect(stats.drift).toBe(9n);
    expect(stats.debtOps).toBe(3);
    expect(stats.maxStepDrift).toBe(4n);
    expect(stats.exactZero).toBe(false);
  });
});
