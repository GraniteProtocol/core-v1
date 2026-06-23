// Regression: unseizable-dust no longer blocks bad-debt socialization.
//
// Pre-fix, a bad-debt position partially liquidated down to an unseizable
// collateral dust could never be socialized: the gate skipped while any
// collateral value remained, and the dust could not be driven to zero (the
// conversion floored collateral-to-give to 0 and state-v1.transfer-to rejects a
// 0-amount transfer), so every clearing liquidation reverted with
// ERR-TRANSFER-NULL and the loss was stranded forever.
//
// Post-fix, socialize-bad-debt fires once no collateral is still seizable, so
// the liquidation that leaves the dust recognizes the loss in the same call.
// Scenario mirrors the original report (8-dec market+collateral, btc
// $60k -> ~$20k, 1.00000101 btc collateral, 30000 borrow).

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
import { init_pyth, set_pyth_time_delta, set_initial_price, set_price_without_scaling } from "./pyth";

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
const btc = contractPrincipalCV(deployer, "mock-btc");

const getBtcCollateral = (user: string): bigint => {
  const r = simnet.callReadOnlyFn("state-v1", "get-user-collateral", [Cl.principal(user), btc], deployer);
  if (r.result.type !== ClarityType.OptionalSome) return 0n;
  return r.result.value.data["amount"].value as bigint;
};
const getDebtShares = (user: string): bigint => {
  const r = simnet.callReadOnlyFn("state-v1", "get-borrow-repay-params", [Cl.principal(user)], deployer);
  return r.result.data["user-position"].value.data["debt-shares"].value as bigint;
};
const getTotalAssets = (): bigint => {
  const r = simnet.callReadOnlyFn("state-v1", "get-lp-params", [], deployer);
  return r.result.data["total-assets"].value as bigint;
};
const socializeFired = (res: any): boolean => JSON.stringify(res.events).includes("socialized-bad-debt");
const liquidate = (repay: bigint, minCol: bigint) =>
  simnet.callPublicFn(
    "liquidator-v1",
    "liquidate-collateral",
    [Cl.none(), btc, Cl.principal(borrower), Cl.uint(repay), Cl.uint(minCol)],
    liquidator,
  );

describe("Regression: unseizable dust no longer blocks bad-debt socialization", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 1_000_000_000_000_000n);
    initialize_ir_zero(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 60000n, deployer);
  });

  it("a liquidation that leaves unseizable dust socializes the bad debt in the same call", async () => {
    mint_token("mock-usdc", 50000_00000000, depositor);
    deposit(50000_00000000, depositor);

    update_supported_collateral("mock-btc", 51000000, 65000000, 10000000, 8, deployer);
    mint_token("mock-btc", 1_00000101, borrower);
    add_collateral("mock-btc", 1_00000101, deployer, borrower);
    borrow(30000_00000000, borrower);

    // Crash btc to ~$20k -> collateral ~$20k < debt $30k -> bad debt.
    await set_price_without_scaling("mock-btc", 1999923495619n, deployer);

    mint_token("mock-usdc", 1_000_000_00000000, liquidator);
    simnet.mineEmptyBlocks(6);

    const taBefore = getTotalAssets();

    // This liquidation seizes almost all collateral, leaving a 1-sat unseizable
    // remainder. Pre-fix it reverted the position into a permanent stranded
    // state; post-fix it socializes the uncovered debt in this same call.
    const liq1 = liquidate(1818114105036n, 1n);
    const dust = getBtcCollateral(borrower);
    const debtShares = getDebtShares(borrower);
    const taAfter = getTotalAssets();
    console.log(`[liq1] result=${liq1.result.type === ClarityType.ResponseOk ? "ok" : "err"} socialized=${socializeFired(liq1)} dust=${dust} debtShares=${debtShares} taBefore=${taBefore} taAfter=${taAfter}`);

    expect(liq1.result.type).toBe(ClarityType.ResponseOk);
    // The loss is recognized in this same liquidation...
    expect(socializeFired(liq1)).toBe(true);
    // ...the bad debt is written off the position...
    expect(debtShares).toBe(0n);
    // ...and total-assets is written down by the uncovered loss.
    expect(taAfter).toBeLessThan(taBefore);

    // The unseizable dust may remain on the now debt-free position - harmless.
    // It is no longer a stuck bad-debt: a further liquidation is rejected as a
    // healthy position (ERR-USER-POSITION-HEALTHY u30003), not stranded on the
    // zero-amount transfer guard (ERR-TRANSFER-NULL u101).
    const followUp = liquidate(100000000000000n, 0n);
    console.log(`[follow-up] err=${followUp.result.value?.value}`);
    expect(followUp.result.type).toBe(ClarityType.ResponseErr);
    expect(followUp.result.value.value).toBe(30003n);
  });
});
