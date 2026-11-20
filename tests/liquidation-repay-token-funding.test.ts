import { beforeEach, describe, expect, it } from "vitest";
import { Cl, ClarityType, contractPrincipalCV } from "@stacks/transactions";
import {
  add_collateral,
  borrow,
  deposit,
  getUserBalance,
  initialize_ir,
  initialize_lp,
  initialize_staking_reward,
  mint_token,
  mint_token_to_contract,
  set_allowed_contracts,
  set_asset_cap,
  state_set_governance_contract,
  update_supported_collateral,
} from "./utils";
import {
  build_price_update,
  collateral_prices_cv,
  init_pyth,
  market_price_cv,
  set_initial_price,
  set_price_without_scaling,
  set_pyth_time_delta,
} from "./pyth";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const depositor = accounts.get("wallet_4")!;
const borrower = accounts.get("wallet_1")!;
const liquidator = accounts.get("wallet_5")!;
const btcCollateral = contractPrincipalCV(deployer, "mock-btc");
const flashLoanLiquidator = Cl.contractPrincipal(
  deployer,
  "mock-liquidator-with-flash-loan"
);

const ONE_DOLLAR = 100_000_000n;
// Pyth USDC/USD just below $1: the USD->token round-up pulls more tokens than the USD amount.
const PRICE_BELOW_ONE = 99_987_851n;
const SVB_LOW = 87_350_000n;
// The requested USD amount and the token amount execute-liquidation pulls for that amount at PRICE_BELOW_ONE.
const REPAY_USD = 16_666_666_667n;
const REPAY_TOKENS = 16_668_691_747n;
const FLASH_FEE = 1_666_667n;

const liquidationData = (repayAmount: bigint) =>
  simnet.callReadOnlyFn(
    "liquidator-v1",
    "get-liquidation-data",
    [
      Cl.principal(borrower),
      btcCollateral,
      Cl.uint(repayAmount),
      market_price_cv(),
      collateral_prices_cv(borrower, deployer),
    ],
    deployer
  ).result.value.value;

const setupFlashLoanPosition = () => {
  mint_token("mock-usdc", 100_000_000_000, depositor);
  deposit(100_000_000_000, depositor);

  update_supported_collateral("mock-btc", 90_000_000, 95_000_000, 5_000_000, 8, deployer);
  mint_token("mock-btc", 100_000_000_000, borrower);
  add_collateral("mock-btc", 20_000_000_000, deployer, borrower);
  borrow(18_000_000_000, borrower);

  update_supported_collateral("mock-btc", 40_000_000, 50_000_000, 20_000_000, 8, deployer);

  const allowed = simnet.callPublicFn(
    "flash-loan-v1",
    "set-allowed-contract",
    [flashLoanLiquidator],
    deployer
  );
  expect(allowed.result).toBeOk(Cl.bool(true));
  state_set_governance_contract(deployer);
  simnet.mineEmptyBlocks(6);
};

const runFlashLoan = () =>
  simnet.callPublicFn(
    "mock-liquidator-with-flash-loan",
    "liquidate-collateral",
    [
      Cl.buffer(build_price_update()),
      Cl.principal(borrower),
      Cl.uint(REPAY_USD),
      Cl.uint(1),
      flashLoanLiquidator,
    ],
    depositor
  );

describe("liquidation repay token funding", () => {
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

  it("get-liquidation-data exposes the token amount execute-liquidation will pull", async () => {
    setupFlashLoanPosition();
    await set_price_without_scaling("mock-usdc", PRICE_BELOW_ONE, deployer);

    const data = liquidationData(REPAY_USD);
    expect(data["repay-amount"].value).toBe(REPAY_USD);
    expect(data["repay-amount-tokens"].value).toBe(REPAY_TOKENS);

    await set_price_without_scaling("mock-usdc", ONE_DOLLAR, deployer);
    const atPeg = liquidationData(REPAY_USD);
    expect(atPeg["repay-amount-tokens"].value).toBe(atPeg["repay-amount"].value);
  });

  it("a flash loan funded with the token amount plus the fee succeeds at a price below $1", async () => {
    setupFlashLoanPosition();
    await set_price_without_scaling("mock-usdc", PRICE_BELOW_ONE, deployer);

    mint_token_to_contract(
      "mock-usdc",
      Number(REPAY_TOKENS + FLASH_FEE),
      flashLoanLiquidator,
      deployer
    );
    const stateBefore = getUserBalance(
      Cl.contractPrincipal(deployer, "state-v1"),
      "mock-usdc",
      deployer
    );
    const governanceBefore = getUserBalance(
      Cl.contractPrincipal(deployer, "governance-v1"),
      "mock-usdc",
      deployer
    );

    const result = runFlashLoan();
    expect(result.result).toBeOk(Cl.bool(true));

    const stateAfter = getUserBalance(
      Cl.contractPrincipal(deployer, "state-v1"),
      "mock-usdc",
      deployer
    );
    const governanceAfter = getUserBalance(
      Cl.contractPrincipal(deployer, "governance-v1"),
      "mock-usdc",
      deployer
    );

    expect(stateAfter - stateBefore).toBe(REPAY_TOKENS);
    expect(governanceAfter - governanceBefore).toBe(FLASH_FEE);
    expect(getUserBalance(flashLoanLiquidator, "mock-usdc", deployer)).toBe(0n);

    const seizedCollateral = getUserBalance(
      flashLoanLiquidator,
      "mock-btc",
      deployer
    );
    const paidUsd = (REPAY_TOKENS * PRICE_BELOW_ONE) / ONE_DOLLAR;
    const ratioPerMille = (seizedCollateral * 1000n) / paidUsd;
    expect(ratioPerMille).toBeGreaterThanOrEqual(1195n);
    expect(ratioPerMille).toBeLessThanOrEqual(1205n);
  });

  it("a flash loan funded with the USD amount in tokens aborts when it reclaims its principal (err u1)", async () => {
    setupFlashLoanPosition();
    await set_price_without_scaling("mock-usdc", PRICE_BELOW_ONE, deployer);

    mint_token_to_contract(
      "mock-usdc",
      Number(REPAY_USD + FLASH_FEE),
      flashLoanLiquidator,
      deployer
    );

    const result = runFlashLoan();
    expect(result.result).toBeErr(Cl.uint(1));
  });

  it("keeps the seized-collateral to paid-USD ratio at 1 + premium at $0.8735", async () => {
    mint_token("mock-usdc", 100_000_000_000, depositor);
    deposit(100_000_000_000, depositor);
    update_supported_collateral("mock-btc", 90_000_000, 95_000_000, 5_000_000, 8, deployer);
    mint_token("mock-btc", 20_000_000_000, borrower);
    add_collateral("mock-btc", 20_000_000_000, deployer, borrower);
    borrow(18_000_000_000, borrower);
    update_supported_collateral("mock-btc", 4_000_000, 5_000_000, 5_000_000, 8, deployer);

    await set_price_without_scaling("mock-usdc", SVB_LOW, deployer);

    const repayUsd = 5_000_000_000n;
    const quote = liquidationData(repayUsd);
    expect(quote["repay-amount"].value).toBe(repayUsd);
    const repayTokens = quote["repay-amount-tokens"].value as bigint;

    mint_token("mock-usdc", Number(repayTokens * 2n), liquidator);
    const before = getUserBalance(Cl.principal(liquidator), "mock-usdc", deployer);

    simnet.mineEmptyBlocks(6);
    const result = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.buffer(build_price_update()),
        btcCollateral,
        Cl.principal(borrower),
        Cl.uint(repayUsd),
        Cl.uint(1),
      ],
      liquidator
    );
    expect(result.result.type).toBe(ClarityType.ResponseOk);

    const after = getUserBalance(Cl.principal(liquidator), "mock-usdc", deployer);
    const tokensPaid = before - after;
    expect(tokensPaid).toBe(repayTokens);

    const seizedCollateral = getUserBalance(Cl.principal(liquidator), "mock-btc", deployer);
    const paidUsd = (tokensPaid * SVB_LOW) / ONE_DOLLAR;
    const ratioPerMille = (seizedCollateral * 1000n) / paidUsd;
    expect(ratioPerMille).toBeGreaterThanOrEqual(1045n);
    expect(ratioPerMille).toBeLessThanOrEqual(1055n);
  });
});
