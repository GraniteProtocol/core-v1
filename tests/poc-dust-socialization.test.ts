// Regression guard for the bad-debt socialization fix: it must NOT over-socialize.
//
// The fix makes socialize-bad-debt fire once no collateral is still SEIZABLE,
// rather than only when collateral value hits exactly zero. This guards the
// other side of that line: while genuinely seizable collateral remains, a
// bad-debt liquidation must still DEFER socialization, so liquidators recover
// that collateral first and the borrower's collateral is not written off while
// it is still recoverable. Full seizure must still socialize the uncovered loss.
//
// One insolvent bad-debt position (collateral value 800 << debt 1400), two ways:
//   * partial liquidation leaving SEIZABLE collateral -> defers (no writedown).
//   * full seizure                                    -> socializes the loss.

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
import { init_pyth, set_pyth_time_delta, set_initial_price, set_price } from "./pyth";

const initialize_ir_zero = (deployer: string) => {
  const res = simnet.callPublicFn(
    "linear-kinked-ir-v1",
    "update-ir-params",
    [Cl.uint(0), Cl.uint(0), Cl.uint(700_000_000_000), Cl.uint(0)],
    deployer,
  );
  expect(res.result.type).toBe(ClarityType.ResponseOk);
};

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const depositor = accounts.get("wallet_4")!;
const borrower = accounts.get("wallet_1")!;
const liquidator = accounts.get("wallet_5")!;
const btc_collateral = contractPrincipalCV(deployer, "mock-btc");

const getTotalAssets = (): bigint => {
  const r = simnet.callReadOnlyFn("state-v1", "get-lp-params", [], deployer);
  return r.result.data["total-assets"].value as bigint;
};

const getDebtShares = (user: string): bigint => {
  const r = simnet.callReadOnlyFn(
    "state-v1",
    "get-borrow-repay-params",
    [Cl.principal(user)],
    deployer,
  );
  return r.result.data["user-position"].value.data["debt-shares"].value as bigint;
};

const getBtcCollateral = (user: string): bigint => {
  const r = simnet.callReadOnlyFn(
    "state-v1",
    "get-user-collateral",
    [Cl.principal(user), btc_collateral],
    deployer,
  );
  if (r.result.type !== ClarityType.OptionalSome) return 0n;
  return r.result.value.data["amount"].value as bigint;
};

const socializeFired = (result: any): boolean =>
  JSON.stringify(result.events).includes("socialized-bad-debt");

// Deposit 1,000,000; open a position (16 btc collateral @ price 100 -> value
// 1600, borrow 1400 at 87.5% LTV); then crash btc to 50 so collateral value is
// 800 << debt 1400 -> the position is genuinely insolvent and bad-debt flagged.
const setupInsolventPosition = async () => {
  mint_token("mock-usdc", 1_000_000, depositor);
  deposit(1_000_000, depositor);

  update_supported_collateral("mock-btc", 90_000_000, 95_000_000, 5_000_000, 8, deployer);
  mint_token("mock-btc", 16, borrower);
  add_collateral("mock-btc", 16, deployer, borrower);
  borrow(1400, borrower);

  mint_token("mock-usdc", 1_000_000, liquidator);
  simnet.mineEmptyBlocks(6);

  // Refresh both prices (fresh VAAs) and crash btc to 50.
  await set_price("mock-usdc", 1n, deployer);
  await set_price("mock-btc", 50n, deployer);
};

describe("Socialization fix guard: seizable collateral defers, full seizure socializes", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10_000_000_000_000n);
    initialize_ir_zero(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 100n, deployer);
  });

  it("partial liquidation leaving seizable collateral defers socialization (no over-socialization)", async () => {
    await setupInsolventPosition();

    const taBefore = getTotalAssets();

    // Repay a sliver (100 of ~1400 debt). Seizes a little collateral, leaves the rest.
    const res = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [Cl.none(), btc_collateral, Cl.principal(borrower), Cl.uint(100), Cl.uint(1)],
      liquidator,
    );
    expect(res.result.type).toBe(ClarityType.ResponseOk);

    const taAfter = getTotalAssets();
    const btcLeft = getBtcCollateral(borrower);
    const debtShares = getDebtShares(borrower);
    console.log(
      `[skip] taBefore=${taBefore} taAfter=${taAfter} btcLeft=${btcLeft} debtShares=${debtShares} socialized=${socializeFired(res)}`,
    );

    // Seizable collateral remains, so the liquidation correctly defers: a later
    // liquidation recovers that collateral before any writedown.
    expect(btcLeft).toBeGreaterThan(0n);
    expect(socializeFired(res)).toBe(false);
    // total-assets is unchanged and the position keeps its debt - nothing is
    // written off while collateral is still recoverable (no over-socialization).
    expect(taAfter).toBe(taBefore);
    expect(debtShares).toBeGreaterThan(0n);
  });

  it("full collateral seizure of the same position socializes the uncovered loss", async () => {
    await setupInsolventPosition();

    const taBefore = getTotalAssets();

    // Repay 762 -> seizes all 16 collateral (800/(1.05) maps to the full deposit)
    // while leaving debt uncovered, so remaining-debt > 0 and collateral hits 0.
    const res = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [Cl.none(), btc_collateral, Cl.principal(borrower), Cl.uint(762), Cl.uint(1)],
      liquidator,
    );
    expect(res.result.type).toBe(ClarityType.ResponseOk);

    const taAfter = getTotalAssets();
    const btcLeft = getBtcCollateral(borrower);
    const debtShares = getDebtShares(borrower);
    console.log(
      `[fire] taBefore=${taBefore} taAfter=${taAfter} btcLeft=${btcLeft} debtShares=${debtShares} socialized=${socializeFired(res)}`,
    );

    // All collateral seized -> total-collateral-value == 0 -> socialization runs.
    expect(btcLeft).toBe(0n);
    expect(socializeFired(res)).toBe(true);
    // total-assets is written down by the uncollateralised loss.
    expect(taAfter).toBeLessThan(taBefore);
  });
});
