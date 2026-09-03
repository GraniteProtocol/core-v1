// Bad-debt socialization keys on what a liquidation can still SEIZE, not on
// collateral value being non-zero.
//
// A maximum-repay liquidation floors twice around a division: repay-allowed is
// capped at ceil(collateral-value / (1 + premium)) and calc-collateral-to-give
// floors that back into token units. On an oracle price that is not a whole
// number of market-token units the round trip lands one unit short of the
// balance, leaving a residue that values above zero but converts to a zero
// seizure. The gate then skips socialization and every retry reverts u101 from
// state-v1.transfer-to, which rejects a zero-amount transfer.
//
// Live sBTC parameters throughout: max-LTV 50%, liquidation-LTV 65%, premium
// 10%, 8 decimals. Interest is zeroed so the debt figures stay exact across the
// mandatory 6-block liquidation gap.

import { beforeEach, describe, expect, it } from "vitest";
import { Cl, ClarityType, contractPrincipalCV } from "@stacks/transactions";
import {
  add_collateral,
  borrow,
  deposit,
  initialize_lp,
  initialize_staking_reward,
  mint_token,
  set_allowed_contracts,
  set_asset_cap,
  update_supported_collateral,
} from "./utils";
import {
  build_price_update,
  init_pyth,
  set_initial_price,
  set_price_without_scaling,
  set_pyth_time_delta,
} from "./pyth";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const depositor = accounts.get("wallet_4")!;
const borrower = accounts.get("wallet_1")!;
const liquidator = accounts.get("wallet_5")!;
const btc_collateral = contractPrincipalCV(deployer, "mock-btc");

const ONE_BTC = 100_000_000;
const DEPOSIT = 10_000_000_000_000; // $100,000
const BORROW = 3_000_000_000_000; // $30,000, half of the collateral value at open

// Prices carrying cents, as a real feed does. A whole-dollar price divides
// evenly and hides the defect: the same position at exactly $20,000.00 sweeps
// its balance to zero and socializes even unfixed.
const PRICE_OPEN = 60_000n;
const PRICE_UNDERWATER = 2_013_742_000_000n; // $20,137.42
const PRICE_PARTIAL = 4_521_355_000_000n; // $45,213.55

const initialize_ir_zero = (deployer: string) => {
  const res = simnet.callPublicFn(
    "linear-kinked-ir-v1",
    "update-ir-params",
    [Cl.uint(0), Cl.uint(0), Cl.uint(700_000_000_000), Cl.uint(0)],
    deployer,
  );
  expect(res.result.type).toBe(ClarityType.ResponseOk);
};

const openPosition = (collateralSats: number) => {
  mint_token("mock-usdc", DEPOSIT, depositor);
  deposit(DEPOSIT, depositor);

  update_supported_collateral("mock-btc", 50_000_000, 65_000_000, 10_000_000, 8, deployer);
  mint_token("mock-btc", collateralSats, borrower);
  add_collateral("mock-btc", collateralSats, deployer, borrower);
  borrow(BORROW, borrower);

  mint_token("mock-usdc", DEPOSIT, liquidator);
  simnet.mineEmptyBlocks(6);
};

const liquidate = (repayAmount: number) =>
  simnet.callPublicFn(
    "liquidator-v1",
    "liquidate-collateral",
    [
      Cl.buffer(build_price_update()),
      btc_collateral,
      Cl.principal(borrower),
      Cl.uint(repayAmount),
      Cl.uint(1),
    ],
    liquidator,
  );

const collateralLeft = (): bigint => {
  const res = simnet.callReadOnlyFn(
    "state-v1",
    "get-user-collateral",
    [Cl.principal(borrower), btc_collateral],
    deployer,
  );
  if (res.result.type !== ClarityType.OptionalSome) return 0n;
  return res.result.value.value["amount"].value as bigint;
};

const debtShares = (): bigint => {
  const res = simnet.callReadOnlyFn(
    "state-v1",
    "get-borrow-repay-params",
    [Cl.principal(borrower)],
    deployer,
  );
  return res.result.value["user-position"].value.value["debt-shares"].value as bigint;
};

const totalAssets = (): bigint => {
  const res = simnet.callReadOnlyFn("state-v1", "get-lp-params", [], deployer);
  return res.result.value["total-assets"].value as bigint;
};

const socializeEvent = (liq: any): any =>
  liq.events.find((e: any) => e.data?.value?.value?.["action"]?.value === "socialized-bad-debt");

describe("bad-debt socialization on an unseizable collateral residue", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 100_000_000_000_000_000n);
    initialize_ir_zero(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", PRICE_OPEN, deployer);
  });

  it("writes the debt off once the residue is too small to seize", async () => {
    openPosition(ONE_BTC + 101);
    await set_price_without_scaling("mock-btc", PRICE_UNDERWATER, deployer);
    const assetsBefore = totalAssets();

    const res = liquidate(DEPOSIT);
    expect(res.result.type, "a maximum-repay liquidation of an insolvent position must succeed").toBe(
      ClarityType.ResponseOk,
    );

    // The seizure math cannot take this last unit, so nothing further can be
    // recovered from the position and the loss is the protocol's.
    expect(collateralLeft(), "the seizure leaves a one-unit residue at this price").toBe(1n);
    expect(socializeEvent(res), "socialization must fire on an unseizable residue").toBeDefined();
    expect(debtShares(), "the position must be left with no outstanding debt").toBe(0n);
    expect(totalAssets(), "the uncovered loss must be written down").toBeLessThan(assetsBefore);
  });

  it("writes the debt off when the balance sweeps to zero", async () => {
    openPosition(ONE_BTC);
    await set_price_without_scaling("mock-btc", PRICE_UNDERWATER, deployer);
    const assetsBefore = totalAssets();

    const res = liquidate(DEPOSIT);
    expect(res.result.type, "a maximum-repay liquidation of an insolvent position must succeed").toBe(
      ClarityType.ResponseOk,
    );

    // A whole collateral balance divides evenly and is seized in full. This path
    // socialized before the gate changed and must keep behaving identically.
    expect(collateralLeft(), "a whole balance is seized in full at this price").toBe(0n);
    expect(socializeEvent(res), "socialization must fire when the balance is emptied").toBeDefined();
    expect(debtShares(), "the position must be left with no outstanding debt").toBe(0n);
    expect(totalAssets(), "the uncovered loss must be written down").toBeLessThan(assetsBefore);
  });

  it("defers the write-off while bad debt still has seizable collateral", async () => {
    openPosition(ONE_BTC + 101);
    await set_price_without_scaling("mock-btc", PRICE_UNDERWATER, deployer);
    const assetsBefore = totalAssets();

    // $1,000 against $30,000 of debt on an insolvent position: bad debt is
    // flagged, but almost the whole balance is still recoverable.
    const res = liquidate(100_000_000_000);
    expect(res.result.type, "a partial liquidation of an insolvent position must succeed").toBe(
      ClarityType.ResponseOk,
    );

    expect(socializeEvent(res), "recoverable collateral must not be written off").toBeUndefined();
    expect(collateralLeft(), "the bulk of the collateral is still seizable").toBeGreaterThan(1n);
    expect(debtShares(), "the debt must survive a deferred write-off").toBeGreaterThan(0n);
    expect(totalAssets(), "nothing may be written down while collateral is recoverable").toBe(
      assetsBefore,
    );
  });

  it("leaves a partial liquidation of a solvent position retryable", async () => {
    openPosition(ONE_BTC + 101);
    await set_price_without_scaling("mock-btc", PRICE_PARTIAL, deployer);
    const assetsBefore = totalAssets();

    // Unhealthy but solvent: collateral value $45,213 covers the $30,000 debt
    // plus the liquidation premium, so this is the ordinary partial-liquidation
    // path and the gate must not touch it.
    const first = liquidate(50_000_000_000);
    expect(first.result.type, "a partial liquidation must succeed").toBe(ClarityType.ResponseOk);
    const afterFirst = collateralLeft();

    const second = liquidate(50_000_000_000);
    expect(second.result.type, "a retry of a partial liquidation must still succeed").toBe(
      ClarityType.ResponseOk,
    );

    expect(socializeEvent(first), "a solvent position must not be socialized").toBeUndefined();
    expect(socializeEvent(second), "a solvent position must not be socialized on retry").toBeUndefined();
    expect(afterFirst, "the first liquidation must seize collateral").toBeLessThan(BigInt(ONE_BTC + 101));
    expect(collateralLeft(), "the retry must seize collateral too").toBeLessThan(afterFirst);
    expect(debtShares(), "a partial liquidation must leave the debt outstanding").toBeGreaterThan(0n);
    expect(totalAssets(), "no write-down may happen on the partial-liquidation path").toBe(
      assetsBefore,
    );
  });
});
