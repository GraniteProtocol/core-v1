import { describe, expect, it } from "vitest";
import { accountingHolds } from "./invariants";

describe("accounting invariant", () => {
  it("accepts integer rounding residue and rejects real drift", () => {
    expect(accountingHolds({ totalAssets: 100n, reserve: 10n, cash: 50n, debt: 40n }).ok).toBe(true);
    // A liquidation whose interest split floors leaves up to a few units in open-interest.
    expect(accountingHolds({ totalAssets: 100n, reserve: 10n, cash: 50n, debt: 43n }).ok).toBe(true);
    expect(accountingHolds({ totalAssets: 100n, reserve: 10n, cash: 50n, debt: 44n }).ok).toBe(false);
    expect(accountingHolds({ totalAssets: 100n, reserve: 10n, cash: 50n, debt: 36n }).ok).toBe(false);
  });
});
