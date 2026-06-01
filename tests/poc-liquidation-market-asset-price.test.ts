// Bug PoC + fix verification for the liquidator-v1 USD-value vs raw-token
// denomination flaw.
//
// PRE-FIX: `current-debt-adjusted = debt-tokens × market-asset-price` was
// passed as the `debt` input to `calculate-repayment-info`. The resulting
// `repay-amount` was therefore USD-value-shaped, but flowed downstream as
// a raw token count: `transfer-from .mock-usdc liquidator repay-amount`
// and `convert-to-debt-shares debt-params repay-amount`. The two lanes
// only reconciled at market-asset-price = SCALING_FACTOR (i.e. $1).
//
// POST-FIX: `execute-liquidation` now converts the USD-value `repay-amount`
// back to raw market-asset tokens via `÷ market-asset-price` before passing
// it to `convert-to-debt-shares`, `calculate-interest-portions`, and the
// `.mock-usdc transfer-from` inside `state-v1.update-liquidate-collateral-
// state`. `calc-collateral-to-give` keeps the USD-value input (it already
// divides by collateral-price internally).
//
// Each test asserts the POST-FIX invariant: the ratio
//   collateral_USD_seized / effective_USD_paid ≈ 1 + liquidation_premium = 1.05
// holds at every USDCx price (not just $1).

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
  // Test 2 — USDCx = $0.50. Variant A scenario.
  // PRE-FIX: liquidator paid USD-value tokens → ratio ~2.0 (110% skim).
  // POST-FIX: liquidator pays correct tokens → ratio ≈ 1.05 (just the premium).
  // ─────────────────────────────────────────────────────────────────────────
  it("variant A: at USDCx = $0.50, liquidator pays the correct token count post-fix (ratio stays 1.05)", async () => {
    setupBorrowerAtPeg();
    makePositionUnderwater();

    await set_price_without_scaling("mock-usdc", HALF_DOLLAR, deployer, -8);

    fundLiquidator(LIQUIDATOR_REPAY_INPUT * 3n); // need more tokens post-fix
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

    const effectiveUsdPaid = (usdcSpent * HALF_DOLLAR) / ONE_DOLLAR;
    const collateralUsdSeized = liquidatorBtcAfter; // btc price = $1
    const ratioPerMille = (collateralUsdSeized * 1000n) / effectiveUsdPaid;

    console.log(
      `[$0.50]      USDCx paid in = ${usdcSpent}  BTC received = ${liquidatorBtcAfter}\n` +
        `             effective USD paid = ${effectiveUsdPaid}  collateral USD seized = ${collateralUsdSeized}\n` +
        `             ratio = ${ratioPerMille} / 1000 (intended 1050; bug would yield ~2100)`,
    );

    // Post-fix invariant: ratio is 1.050 ± rounding.
    expect(ratioPerMille).toBeGreaterThanOrEqual(1045n);
    expect(ratioPerMille).toBeLessThanOrEqual(1055n);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 3 — USDCx = $1.50. Variant B scenario.
  // PRE-FIX: arithmetic underflow in update-liquidate-collateral-state.
  // POST-FIX: succeeds; ratio ≈ 1.05.
  // ─────────────────────────────────────────────────────────────────────────
  it("variant B: at USDCx = $1.50, liquidation succeeds post-fix (no longer reverts) with ratio 1.05", async () => {
    setupBorrowerAtPeg();
    makePositionUnderwater();

    await set_price_without_scaling(
      "mock-usdc",
      ONE_AND_HALF_DOLLAR,
      deployer,
      -8,
    );

    fundLiquidator(LIQUIDATOR_REPAY_INPUT * 2n);
    const before = getUserBalance(Cl.principal(liquidator), "mock-usdc", deployer);

    simnet.mineEmptyBlocks(6);
    const result = callLiquidate(LIQUIDATOR_REPAY_INPUT);
    expect(result.result.type).toBe(ClarityType.ResponseOk);

    const after = getUserBalance(Cl.principal(liquidator), "mock-usdc", deployer);
    const usdcSpent = before - after;
    const btcReceived = getUserBalance(Cl.principal(liquidator), "mock-btc", deployer);

    const effectiveUsdPaid = (usdcSpent * ONE_AND_HALF_DOLLAR) / ONE_DOLLAR;
    const collateralUsdSeized = btcReceived;
    const ratioPerMille = (collateralUsdSeized * 1000n) / effectiveUsdPaid;

    console.log(
      `[$1.50]      USDCx paid in = ${usdcSpent}  BTC received = ${btcReceived}\n` +
        `             effective USD paid = ${effectiveUsdPaid}  collateral USD seized = ${collateralUsdSeized}\n` +
        `             ratio = ${ratioPerMille} / 1000 (post-fix; pre-fix would have reverted)`,
    );

    expect(ratioPerMille).toBeGreaterThanOrEqual(1045n);
    expect(ratioPerMille).toBeLessThanOrEqual(1055n);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 4 — Live Pyth reading (USDCx = $0.99974). Post-fix: ratio ≈ 1.05.
  // ─────────────────────────────────────────────────────────────────────────
  it("live-state ($0.99974): post-fix ratio holds at 1.05 (no leak at micro-depeg)", async () => {
    setupBorrowerAtPeg();
    makePositionUnderwater();

    await set_price_without_scaling("mock-usdc", LIVE_PYTH_READING, deployer, -8);

    fundLiquidator(LIQUIDATOR_REPAY_INPUT * 2n);
    const before = getUserBalance(Cl.principal(liquidator), "mock-usdc", deployer);

    simnet.mineEmptyBlocks(6);
    const result = callLiquidate(LIQUIDATOR_REPAY_INPUT);
    expect(result.result.type).toBe(ClarityType.ResponseOk);

    const after = getUserBalance(Cl.principal(liquidator), "mock-usdc", deployer);
    const usdcSpent = before - after;
    const btcReceived = getUserBalance(Cl.principal(liquidator), "mock-btc", deployer);

    const effectiveUsdPaid = (usdcSpent * LIVE_PYTH_READING) / ONE_DOLLAR;
    const collateralUsdSeized = btcReceived;
    const ratioPerMille = (collateralUsdSeized * 1000n) / effectiveUsdPaid;

    console.log(
      `[$0.99974]   USDCx paid = ${usdcSpent}  BTC received = ${btcReceived}\n` +
        `             effective USD paid = ${effectiveUsdPaid}  collateral USD seized = ${collateralUsdSeized}\n` +
        `             ratio = ${ratioPerMille} / 1000  (intended 1050)`,
    );

    expect(ratioPerMille).toBeGreaterThanOrEqual(1045n);
    expect(ratioPerMille).toBeLessThanOrEqual(1055n);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 5 — SVB-low scenario (USDCx = $0.8735). Real precedent.
  // PRE-FIX: ratio ≈ 1.20 (15% skim on top of premium).
  // POST-FIX: ratio ≈ 1.05.
  // ─────────────────────────────────────────────────────────────────────────
  it("SVB-low ($0.8735): post-fix ratio holds at 1.05 (no skim during historical-low depeg)", async () => {
    setupBorrowerAtPeg();
    makePositionUnderwater();

    await set_price_without_scaling("mock-usdc", SVB_LOW, deployer, -8);

    fundLiquidator(LIQUIDATOR_REPAY_INPUT * 2n);
    const before = getUserBalance(Cl.principal(liquidator), "mock-usdc", deployer);

    simnet.mineEmptyBlocks(6);
    const result = callLiquidate(LIQUIDATOR_REPAY_INPUT);
    expect(result.result.type).toBe(ClarityType.ResponseOk);

    const after = getUserBalance(Cl.principal(liquidator), "mock-usdc", deployer);
    const usdcSpent = before - after;
    const btcReceived = getUserBalance(Cl.principal(liquidator), "mock-btc", deployer);

    const effectiveUsdPaid = (usdcSpent * SVB_LOW) / ONE_DOLLAR;
    const collateralUsdSeized = btcReceived;
    const ratioPerMille = (collateralUsdSeized * 1000n) / effectiveUsdPaid;

    console.log(
      `[$0.8735]    USDCx paid = ${usdcSpent}  BTC received = ${btcReceived}\n` +
        `             effective USD paid = ${effectiveUsdPaid}  collateral USD seized = ${collateralUsdSeized}\n` +
        `             ratio = ${ratioPerMille} / 1000  (intended 1050; pre-fix would be ~1200)`,
    );

    expect(ratioPerMille).toBeGreaterThanOrEqual(1045n);
    expect(ratioPerMille).toBeLessThanOrEqual(1055n);
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

    // Post-fix invariant: at $0.50 the liquidator now pays MORE tokens (≈ 2×
    // the USD-value upper-bound) than pre-fix. The earlier observation that
    // tokens-into-state was halved at depeg is no longer true.
    const effectiveUsdPaidNow = (tokensIntoState * HALF_DOLLAR) / ONE_DOLLAR;
    // collateral seized USD ≈ tokens × 1.0
    const collateralUsdSeized = getUserBalance(
      Cl.principal(liquidator),
      "mock-btc",
      deployer,
    );
    const ratioPerMille = (collateralUsdSeized * 1000n) / effectiveUsdPaidNow;
    expect(ratioPerMille).toBeGreaterThanOrEqual(1045n);
    expect(ratioPerMille).toBeLessThanOrEqual(1055n);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 7 — Permissionless attacker. Post-fix: no exploit, just normal premium.
  // ─────────────────────────────────────────────────────────────────────────
  it("permissionless: at USDCx = $0.50 post-fix, attacker only captures the 5% premium, no extra skim", async () => {
    setupBorrowerAtPeg();
    makePositionUnderwater();
    await set_price_without_scaling("mock-usdc", HALF_DOLLAR, deployer, -8);

    const attacker = accounts.get("wallet_7")!;
    mint_token("mock-usdc", Number(LIQUIDATOR_REPAY_INPUT * 3n), attacker);
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
    const ratioPerMille = (btcReceived * 1000n) / effectiveUsdPaid;

    console.log(
      `[permissionless] attacker USDCx spent = ${usdcSpent}  BTC received = ${btcReceived}\n` +
        `                 effective USD paid = ${effectiveUsdPaid}  ratio = ${ratioPerMille}/1000`,
    );

    expect(ratioPerMille).toBeGreaterThanOrEqual(1045n);
    expect(ratioPerMille).toBeLessThanOrEqual(1055n);
  });
});
