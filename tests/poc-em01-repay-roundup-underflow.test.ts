// E-M-01 regression PoC: integer floor on total-collaterals-liquid-value lets
// calculate-repayment-info return repay-allowed = debt + 1, and the USD->token
// round-up then pushes paid-shares past the borrower's debt-shares, underflowing
// the bare `-` at state-v1 L843 (immutable) and reverting the liquidation.
//
// The fix adds two caps in the upgradable liquidator-v1:
//   Cap 1 (USD domain)   - repay-allowed = min(repay-allowed, debt) in calculate-repayment-info
//   Cap 2 (token domain) - repay-amount  = min(repay-amount, current-debt) in execute-liquidation
//
// Test A probes Cap 1 directly via the read-only `liquidate`: with the floored
// total-collaterals-liquid-value the formula yields repay-allowed = debt + 1.
// Test B drives the full liquidate-collateral path at the same boundary and
// asserts it no longer reverts.
//
// The existing poc-liquidation-market-asset-price.test.ts uses only round
// amounts (divisible, debt %5 == 0), so it never reaches this boundary.

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

// Zero interest rates so accrue-interest over the mandatory 6-block liquidation
// gap leaves open-interest == total-debt-shares. This is the regime E-M-01's
// derivation uses: at zero interest the convert-to-debt-shares floor cannot
// absorb the +1 over-repayment, so the floor-boundary excess reaches state-v1.
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

const SCALING = 100_000_000n; // 1e8
const DISCOUNT_20 = 20_000_000n; // 20%
const LIQ_LTV_50 = 50_000_000n; // 50%

describe("PoC E-M-01: integer-floor repay-allowed > debt underflow", () => {
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

  // ───────────────────────────────────────────────────────────────────────
  // Test A — read-only `liquidate` at the floor boundary.
  // debt = 9, total-collaterals-liquid-value = 5 (= floor(11 * 0.5)),
  // collateral-value = 11, discount 20%, collateral-liquid-ltv 50%.
  // Continuous repay-allowed would be 8.75 <= 9; the floor inflates it to 10.
  // Invariant Cap 1 enforces: repay-allowed <= debt.
  // ───────────────────────────────────────────────────────────────────────
  it("read-only: repay-allowed never exceeds debt at the floor boundary", () => {
    const res = simnet.callReadOnlyFn(
      "liquidator-v1",
      "liquidate",
      [
        Cl.uint(9), //  debt (USD value)
        Cl.uint(5), //  total-collaterals-liquid-value (floored)
        Cl.uint(11), // collateral-value
        Cl.uint(DISCOUNT_20), // liquidation-discount
        Cl.uint(LIQ_LTV_50), // collateral-liquid-ltv
        Cl.uint(1_000_000), // deposited-collateral-amount
        Cl.uint(SCALING), //  collateral-price ($1)
        Cl.uint(1_000_000), // liquidator-repay-amount (full)
        Cl.uint(8), //  collateral-decimals
      ],
      deployer,
    );

    expect(res.result.type).toBe(ClarityType.ResponseOk);
    const info = res.result.value.data["repayment-info"];
    const repayAllowed = info.data["repay-allowed"].value;
    const debt = info.data["debt"].value;
    console.log(`[A] repay-allowed=${repayAllowed} debt=${debt}`);

    // Pre-fix: repay-allowed = 10 > debt = 9.
    expect(repayAllowed).toBeLessThanOrEqual(debt);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test B — full liquidate-collateral at the same boundary.
  // current-debt = 9 tokens, collateral = 11 BTC ($1), liq-ltv dropped to 50%.
  // Pre-fix: repay-allowed = 10 -> repay-amount(tokens) = 10 -> paid-shares = 10
  // > debt-shares = 9 -> underflow at state-v1 L843 -> revert.
  // Post-fix: caps clamp to 9, liquidation succeeds.
  // ───────────────────────────────────────────────────────────────────────
  it("full-chain: liquidation at the floor boundary no longer underflows", () => {
    // LP funds the market.
    mint_token("mock-usdc", 1_000_000, depositor);
    deposit(1_000_000, depositor);

    // Healthy collateral settings for the borrow. Premium 5% here so the high
    // liq-ltv passes is-valid-liqLTV-and-liqPremium (liq-ltv < SCALING^2/(SCALING+premium));
    // the 20% premium that drives the floor-boundary math is set on the drop below.
    update_supported_collateral("mock-btc", 90_000_000, 95_000_000, 5_000_000, 8, deployer);
    mint_token("mock-btc", 11, borrower);
    add_collateral("mock-btc", 11, deployer, borrower);

    // current-debt = 9 tokens (LTV 9/11 = 81.8% < 90% max-ltv).
    borrow(9, borrower);

    // Drop liq-ltv to 50% so the position is liquidatable; premium 20% (= the
    // liquidation-discount the formula uses). 50% < 83.33% inverted-discount cap.
    update_supported_collateral("mock-btc", 40_000_000, Number(LIQ_LTV_50), Number(DISCOUNT_20), 8, deployer);

    mint_token("mock-usdc", 1_000_000, liquidator);
    simnet.mineEmptyBlocks(6);

    const result = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [Cl.none(), btc_collateral, Cl.principal(borrower), Cl.uint(1_000_000), Cl.uint(1)],
      liquidator,
    );
    console.log(`[B] liquidate result type=${result.result.type} value=${JSON.stringify(result.result.value)}`);

    expect(result.result.type).toBe(ClarityType.ResponseOk);

    // The boundary liquidation must actually clear the debt (paid-shares clamped
    // to the position's debt-shares), not silently no-op.
    const post = simnet.callReadOnlyFn(
      "state-v1",
      "get-borrow-repay-params",
      [Cl.principal(borrower)],
      deployer,
    );
    expect(post.result.data["user-position"].value.data["debt-shares"].value).toBe(0n);
  });
});
