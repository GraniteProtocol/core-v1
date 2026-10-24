import { describe, expect, it } from "vitest";
import { accountingHolds, accountingStats, gateStepDrift, resetAccounting } from "./invariants";

describe("accounting invariant", () => {
  it("accepts only a positive residue within the rounding window", () => {
    // 80 + 10 == 50 + 40.
    expect(accountingHolds({ totalAssets: 80n, reserve: 10n, cash: 50n, debt: 40n }).ok).toBe(true);
    // +3 units of floor-split residue is accepted.
    expect(accountingHolds({ totalAssets: 80n, reserve: 10n, cash: 50n, debt: 43n }).ok).toBe(true);
    // +4 units is real drift.
    expect(accountingHolds({ totalAssets: 80n, reserve: 10n, cash: 50n, debt: 44n }).ok).toBe(false);
    // Value appearing from nowhere is never rounding.
    expect(accountingHolds({ totalAssets: 81n, reserve: 10n, cash: 50n, debt: 40n }).ok).toBe(false);
    // Dropping the reserve term changes the sign and must fail.
    expect(accountingHolds({ totalAssets: 90n, reserve: 10n, cash: 50n, debt: 40n }).ok).toBe(false);
  });

  it("gates movement by operation kind, rejects negative movement, and accumulates statistics", () => {
    resetAccounting();
    expect(gateStepDrift(1n, "non-debt").ok).toBe(false); // the baseline residue after setup is 0
    resetAccounting();
    expect(gateStepDrift(0n, "non-debt").ok).toBe(true); // baseline
    expect(gateStepDrift(1n, "non-debt").ok).toBe(false); // no movement outside a debt op
    expect(gateStepDrift(1n, "debt").ok).toBe(true); // delta 0
    expect(gateStepDrift(4n, "debt").ok).toBe(true); // +3
    expect(gateStepDrift(8n, "debt").ok).toBe(false); // +4
    expect(gateStepDrift(7n, "debt").ok).toBe(false); // negative movement, even on a debt op
    expect(gateStepDrift(7n, "non-debt").ok).toBe(true); // no movement
    expect(gateStepDrift(8n, "non-debt").ok).toBe(false); // movement outside a debt op
    const stats = accountingStats();
    expect(stats.drift).toBe(8n);
    expect(stats.debtOps).toBe(4);
    expect(stats.maxStepDrift).toBe(4n);
    expect(stats.exactZero).toBe(false);
  });
});
