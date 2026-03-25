/**
 * PoC: slash-total-staked-lp-tokens underflow reverts bad-debt liquidation
 *
 * Bug:   staking-v1.clar lines 205-210 — double-floor rounding in the
 *        active/withdrawal slash split causes active-staked-lp-tokens-to-slash
 *        to exceed total-lp-tokens-staked, underflowing the subtraction on
 *        line 210 and reverting the entire bad-debt socialization tx.
 *
 * Root cause arithmetic (SF = 1e8):
 *   withdrawal-lp-token-rate      = floor(withdrawal * SF / total)
 *   withdrawal-lp-tokens-to-slash = floor(lp-tokens * rate / SF)
 *   active-to-slash               = lp-tokens - withdrawal-to-slash
 *
 *   When lp-tokens == total (full wipe) and withdrawal*SF % total != 0,
 *   withdrawal-to-slash < withdrawal  ⟹  active-to-slash > active  ⟹  underflow.
 *
 * Impact: bad-debt liquidation reverts → insolvent position stays open →
 *         protocol insolvency / griefing / liquidation freeze.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Cl, ClarityValue } from "@stacks/transactions";
import {
  initialize_ir,
  set_allowed_contracts,
  set_asset_cap,
  deposit,
  mint_token,
  update_supported_collateral,
  add_collateral,
  borrow,
  initialize_staking_reward,
} from "./utils";
import {
  init_pyth,
  set_initial_price,
  set_price,
  set_pyth_time_delta,
} from "./pyth";

/* ── accounts ── */
const accounts = simnet.getAccounts();
const deployer   = accounts.get("deployer")!;
const lp         = accounts.get("wallet_1")!;   // liquidity provider
const staker     = accounts.get("wallet_2")!;   // staker (creates unfinalized withdrawal)
const borrower1  = accounts.get("wallet_3")!;   // borrower who will go bad-debt
const liquidator = accounts.get("wallet_4")!;   // liquidator

const btc = Cl.contractPrincipal(deployer, "mock-btc");

/* ── helpers ── */
const stakeLpTokens = (user: string, amount: bigint) => {
  const r = simnet.callPublicFn("staking-v1", "stake", [Cl.uint(amount)], user);
  expect(r.result).toBeOk(Cl.bool(true));
};

const initiateUnstake = (user: string, amount: bigint) => {
  const r = simnet.callPublicFn(
    "staking-v1",
    "initiate-unstake",
    [Cl.uint(amount)],
    user
  );
  // returns (ok withdrawal-index)
  expect(r.result.type).toBe(7); // ResponseOk
};

const getStakingState = () => {
  const active = simnet.callReadOnlyFn(
    "staking-v1", "get-active-staked-lp-tokens", [], deployer
  );
  const total = simnet.callReadOnlyFn(
    "staking-v1", "get-total-staked-lp-tokens", [], deployer
  );
  return {
    active: active.result.value as bigint,
    total: total.result.value as bigint,
  };
};

const getUserLpBalance = (user: ClarityValue): bigint => {
  const r = simnet.callReadOnlyFn("state-v1", "get-balance", [user], deployer);
  return r.result.value.value as bigint;
};

/* ── test ── */
describe("PoC: slash-total-staked-lp-tokens underflow", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10000000000000n);
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 100n, deployer);
  });

  it("bad-debt liquidation reverts when unfinalized withdrawals cause slash underflow", async () => {
    // ────────────────────────────────────────────────────────────
    // Step 1 — LP deposits liquidity
    // ────────────────────────────────────────────────────────────
    const depositAmount = 100_000_000_000; // 100k USDC (6 dec)
    mint_token("mock-usdc", depositAmount, lp);
    deposit(depositAmount, lp);

    // ────────────────────────────────────────────────────────────
    // Step 2 — Staker deposits, stakes, then initiates partial unstake
    //
    // We choose amounts so that:
    //   active = 2,  withdrawal = 1,  total = 3
    // This is the minimal counterexample from the bug report.
    // ────────────────────────────────────────────────────────────
    mint_token("mock-usdc", 3, staker);
    deposit(3, staker);

    // Stake all 3 LP tokens
    stakeLpTokens(staker, 3n);

    // Initiate unstake of 1 staked-lp-token → moves 1 LP token to withdrawal queue
    initiateUnstake(staker, 1n);

    // Verify staking state: active = 2, total = 3
    const state = getStakingState();
    expect(state.active).toBe(2n);
    expect(state.total).toBe(3n);

    // ────────────────────────────────────────────────────────────
    // Step 3 — Borrower posts collateral and borrows
    // ────────────────────────────────────────────────────────────
    update_supported_collateral(
      "mock-btc",
      90_000_000,  // max-ltv  90%
      95_000_000,  // liq-ltv  95%
      5_000_000,   // liq-discount 5%
      8,           // decimals
      deployer
    );

    mint_token("mock-btc", 200_000_000, borrower1);
    add_collateral("mock-btc", 200_000_000, deployer, borrower1);
    borrow(18_000_000_000, borrower1);

    // Confirm position is healthy
    let healthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    const healthBefore = healthRes.result.value.data["position-health"].value;
    expect(healthBefore).toBeGreaterThanOrEqual(100_000_000n); // ≥ 1.0

    // ────────────────────────────────────────────────────────────
    // Step 4 — BTC price drops 6%: 100 → 94 USDC
    //          collateral value: 2 BTC * 94 = 188 USDC
    //          debt: 180 USDC,  reward: 188 * 5% = 9.4
    //          bad-debt check: 188 < 180 + 9.4 = 189.4  →  bad debt
    //          No governance action — pure market event.
    // ────────────────────────────────────────────────────────────
    await set_price("mock-btc", 94n, deployer);

    // Confirm position is unhealthy
    healthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    const healthAfter = healthRes.result.value.data["position-health"].value;
    expect(healthAfter).toBeLessThan(100_000_000n); // < 1.0

    // ────────────────────────────────────────────────────────────
    // Step 5 — Attempt liquidation → should trigger bad-debt
    //          socialization → slash-total-staked-lp-tokens
    //          After fix: should succeed without underflow
    // ────────────────────────────────────────────────────────────
    mint_token("mock-usdc", 20_000_000_000, liquidator);

    // Advance past the 6-block time-lock between borrowing and liquidation
    simnet.mineEmptyBlocks(6);
    // refresh prices after mining blocks
    await set_price("mock-usdc", 1n, deployer);
    await set_price("mock-btc", 94n, deployer);

    // After fix, liquidation should succeed (bad debt socialized correctly)
    const result = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.none(),                   // pyth price feed data
        btc,                         // collateral token
        Cl.principal(borrower1),     // user to liquidate
        Cl.uint(20_000_000_000),     // liquidator-repay-amount
        Cl.uint(1),                  // min-collateral-expected
      ],
      liquidator
    );

    expect(result.result).toBeOk(Cl.bool(true));
  });

  it("arithmetic proof: single division avoids active-to-slash > active", () => {
    // Verify that the fixed single-division approach works correctly
    // for the counterexample that previously caused underflow.
    //
    // Old buggy code (double floor):
    //   rate = floor(withdrawal * SF / total)
    //   withdrawal-to-slash = floor(lp-tokens * rate / SF)
    //
    // Fixed code (single floor):
    //   withdrawal-to-slash = floor(lp-tokens * withdrawal / total)

    const SF = 100_000_000n;
    const total      = 3n;
    const active     = 2n;
    const withdrawal = 1n;
    const lpTokens   = 3n; // full wipe: lp-tokens == total

    // Old buggy calculation
    const buggyRate              = (withdrawal * SF) / total;         // floor(1e8/3) = 33333333
    const buggyWithdrawalToSlash = (lpTokens * buggyRate) / SF;      // floor(3*33333333/1e8) = 0
    const buggyActiveToSlash     = lpTokens - buggyWithdrawalToSlash; // 3 - 0 = 3

    console.log("=== Buggy (double floor) ===");
    console.log(`rate                  = ${buggyRate}`);
    console.log(`withdrawal-to-slash   = ${buggyWithdrawalToSlash}`);
    console.log(`active-to-slash       = ${buggyActiveToSlash}`);
    console.log(`active (actual)       = ${active}`);
    console.log(`UNDERFLOW?            = ${buggyActiveToSlash > active}`);

    // The old code tries to subtract 3 from active=2 → underflow
    expect(buggyWithdrawalToSlash).toBe(0n);
    expect(buggyActiveToSlash).toBe(3n);
    expect(buggyActiveToSlash).toBeGreaterThan(active); // proves underflow in old code

    // Fixed calculation (single division)
    const fixedWithdrawalToSlash = (lpTokens * withdrawal) / total;   // floor(3*1/3) = 1
    const fixedActiveToSlash     = lpTokens - fixedWithdrawalToSlash;  // 3 - 1 = 2

    console.log("\n=== Fixed (single floor) ===");
    console.log(`withdrawal-to-slash   = ${fixedWithdrawalToSlash}`);
    console.log(`active-to-slash       = ${fixedActiveToSlash}`);
    console.log(`active (actual)       = ${active}`);
    console.log(`UNDERFLOW?            = ${fixedActiveToSlash > active}`);

    // Fixed code: active-to-slash == active, no underflow
    expect(fixedWithdrawalToSlash).toBe(1n);
    expect(fixedActiveToSlash).toBe(2n);
    expect(fixedActiveToSlash).toBeLessThanOrEqual(active); // no underflow
  });
});
