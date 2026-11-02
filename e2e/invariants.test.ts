import { describe, expect, it } from "vitest";
import { accountingHolds, accountingStats, accountingSurplus, gateStepDrift, resetAccounting } from "./invariants";

describe("accounting invariant", () => {
  it("accepts only a positive surplus within the rounding window", () => {
    // 80 + 10 == 50 + 40, with no uncollected protocol interest.
    expect(
      accountingHolds({ totalAssets: 80n, reserve: 10n, cash: 50n, debt: 40n, protocolOpenInterest: 0n }).ok,
    ).toBe(true);
    // +2 units of share-rounding residue is accepted.
    expect(
      accountingHolds({ totalAssets: 80n, reserve: 10n, cash: 50n, debt: 42n, protocolOpenInterest: 0n }).ok,
    ).toBe(true);
    // +3 units is real surplus drift.
    expect(
      accountingHolds({ totalAssets: 80n, reserve: 10n, cash: 50n, debt: 43n, protocolOpenInterest: 0n }).ok,
    ).toBe(false);
    // Value appearing from nowhere is never rounding.
    expect(
      accountingHolds({ totalAssets: 81n, reserve: 10n, cash: 50n, debt: 40n, protocolOpenInterest: 0n }).ok,
    ).toBe(false);
    // Dropping the reserve term changes the sign and must fail.
    expect(
      accountingHolds({ totalAssets: 90n, reserve: 10n, cash: 50n, debt: 40n, protocolOpenInterest: 0n }).ok,
    ).toBe(false);
  });

  it("excludes uncollected protocol interest from the surplus", () => {
    // Accrual with a 25% reserve: 10 units of protocol interest were added to open-interest and
    // not to reserve-balance. The raw gap is +10, the surplus is unchanged.
    expect(
      accountingHolds({ totalAssets: 80n, reserve: 10n, cash: 50n, debt: 50n, protocolOpenInterest: 10n }).ok,
    ).toBe(true);
    // A repay collecting 10 units of protocol interest moves 10 units from open-interest into the
    // reserve: the raw gap falls by 10, the surplus still moves only by the floor residue.
    expect(
      accountingHolds({ totalAssets: 80n, reserve: 20n, cash: 60n, debt: 40n, protocolOpenInterest: 0n }).ok,
    ).toBe(true);
    // Forgetting the protocol term turns a clean repayment into +10 of apparent surplus.
    expect(
      accountingHolds({ totalAssets: 80n, reserve: 10n, cash: 50n, debt: 50n, protocolOpenInterest: 0n }).ok,
    ).toBe(false);
  });

  it("gates movement by operation kind, rejects negative movement, and accumulates statistics", () => {
    resetAccounting();
    expect(gateStepDrift(1n, "non-debt").ok).toBe(false); // the baseline surplus after setup is 0
    resetAccounting();
    expect(gateStepDrift(0n, "non-debt").ok).toBe(true); // baseline
    expect(gateStepDrift(1n, "non-debt").ok).toBe(false); // no movement outside a debt op
    expect(gateStepDrift(1n, "debt").ok).toBe(true); // delta 0
    expect(gateStepDrift(3n, "debt").ok).toBe(true); // +2
    expect(gateStepDrift(6n, "debt").ok).toBe(false); // +3
    expect(gateStepDrift(5n, "debt").ok).toBe(false); // negative movement, even on a debt op
    expect(gateStepDrift(5n, "non-debt").ok).toBe(true); // no movement
    expect(gateStepDrift(6n, "non-debt").ok).toBe(false); // movement outside a debt op
    expect(gateStepDrift(6n, "debt", false).ok).toBe(true); // an aborted debt op changed nothing
    expect(gateStepDrift(7n, "debt", false).ok).toBe(false); // and still may not move the surplus
    const stats = accountingStats();
    expect(stats.drift).toBe(7n);
    expect(stats.debtOps).toBe(4);
    expect(stats.maxStepDrift).toBe(3n);
    expect(stats.exactZero).toBe(false);
  });

  it("keeps the surplus unchanged when a bad-debt write-off is booked net of the protocol part", () => {
    const before = { totalAssets: 1000n, reserve: 200n, cash: 400n, debt: 900n, protocolOpenInterest: 100n };
    const writtenOff = 100n;
    const protocolPart = 10n;
    // socialize-user-bad-debt receives the debt already net of the protocol part: debt and
    // protocol-open-interest fall by their full and protocol parts, total assets plus reserve fall
    // by the net amount, and the surplus does not move.
    const after = {
      totalAssets: before.totalAssets - 60n,
      reserve: before.reserve - 30n,
      cash: before.cash,
      debt: before.debt - writtenOff,
      protocolOpenInterest: before.protocolOpenInterest - protocolPart,
    };
    expect(accountingSurplus(before)).toBe(0n);
    expect(accountingSurplus(after)).toBe(0n);
    expect(accountingHolds(after).ok).toBe(true);
    // Booking the gross amount instead would manufacture the protocol part as surplus.
    const grossBooked = { ...after, totalAssets: before.totalAssets - 90n, reserve: before.reserve - 10n };
    expect(accountingSurplus(grossBooked)).toBe(10n);
    expect(accountingHolds(grossBooked).ok).toBe(false);
  });
});
