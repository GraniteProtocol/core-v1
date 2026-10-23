import { describe, expect, it } from "vitest";
import { accountingHolds } from "./invariants";

describe("accounting invariant", () => {
  it("rejects a mismatch", () => {
    expect(accountingHolds({ totalAssets: 100n, reserve: 10n, cash: 50n, debt: 40n }).ok).toBe(true);
    expect(accountingHolds({ totalAssets: 100n, reserve: 10n, cash: 50n, debt: 39n }).ok).toBe(false);
  });
});
