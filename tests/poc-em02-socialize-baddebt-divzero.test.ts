// E-M-02 regression PoC: DivisionByZero in socialize-bad-debt permanently
// blocks liquidation of a bad-debt-flagged-but-solvent position.
//
// is-bad-debt uses a premium-inclusive threshold (collateral-value < debt + reward),
// so a position that is actually solvent (collateral-value > debt) can still be
// flagged as bad debt. When such a position is fully paid off in one liquidation
// and all its collateral is seized, the state update zeroes debt-shares; then
// socialize-bad-debt re-reads the zeroed position and calls
// calculate-interest-portions(0, 0, 0) -> divide-round-up does (mod 0 0) ->
// DivisionByZero -> the whole liquidation reverts, leaving the position stuck.
//
// ABA's case: debt = 14, collateral-value = 16, discount 20%, liq-ltv 50%.
//   reward = floor(16 * 0.2) = 3  ->  16 < 14 + 3 = 17  -> bad-debt flagged
//   collateral-value 16 > debt 14                        -> actually solvent
//   total-repay = floor((14-8)*1e8/4e7) = 15, no-discount = ceil(16/1.2) = 14
//   repay-allowed = min(15,14) = 14 = debt              -> full payoff
//   collateral-to-give = floor(14*1.2) = 16 = cv         -> all collateral seized
//
// Fix: early-exit in socialize-bad-debt when remaining-debt = 0 (nothing to socialize).
// Independent of the E-M-01 fix (this is pre-existing in both original and fixed code).
//
// Zero interest (oi == total-debt-shares) keeps current-debt exactly 14 across the
// mandatory 6-block liquidation gap so the boundary holds.

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
import { init_pyth, set_pyth_time_delta, set_initial_price } from "./pyth";

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

describe("PoC E-M-02: socialize-bad-debt DivisionByZero on full-payoff bad-debt liquidation", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10_000_000_000_000n);
    initialize_ir_zero(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 1n, deployer);
  });

  it("full payoff of a bad-debt-flagged solvent position no longer reverts in socialize-bad-debt", () => {
    mint_token("mock-usdc", 1_000_000, depositor);
    deposit(1_000_000, depositor);

    // Healthy settings for the borrow (premium 5% so liq-ltv 95% passes is-valid).
    update_supported_collateral("mock-btc", 90_000_000, 95_000_000, 5_000_000, 8, deployer);
    mint_token("mock-btc", 16, borrower);
    add_collateral("mock-btc", 16, deployer, borrower);

    // current-debt = 14 tokens (LTV 14/16 = 87.5% < 90% max-ltv).
    borrow(14, borrower);

    // Drop to liq-ltv 50% / premium 20%: underwater, and bad-debt-flagged
    // (cv 16 < debt 14 + reward 3 = 17) while actually solvent (16 > 14).
    update_supported_collateral("mock-btc", 40_000_000, 50_000_000, 20_000_000, 8, deployer);

    mint_token("mock-usdc", 1_000_000, liquidator);
    simnet.mineEmptyBlocks(6);

    const result = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [Cl.none(), btc_collateral, Cl.principal(borrower), Cl.uint(1_000_000), Cl.uint(1)],
      liquidator,
    );
    console.log(`[E-M-02] liquidate result type=${result.result.type} value=${JSON.stringify(result.result.value)}`);

    // Pre-fix: DivisionByZero in socialize-bad-debt -> revert. Post-fix: succeeds.
    expect(result.result.type).toBe(ClarityType.ResponseOk);

    // The liquidation fully cleared the debt; the position is not bricked.
    const post = simnet.callReadOnlyFn(
      "state-v1",
      "get-borrow-repay-params",
      [Cl.principal(borrower)],
      deployer,
    );
    expect(post.result.value["user-position"].value.value["debt-shares"].value).toBe(0n);
  });
});
