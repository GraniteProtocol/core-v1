import { beforeEach, describe, expect, it } from "vitest";
import { Cl, contractPrincipalCV } from "@stacks/transactions";
import {
  add_collateral,
  borrow,
  deposit,
  initialize_ir,
  mint_token,
  update_supported_collateral,
  set_allowed_contracts,
  scalingFactor,
  repay,
  set_asset_cap,
  initialize_staking_reward,
  expectUserUSDCBalance,
  mint_token_to_contract,
  expectUserBTCBalance,
} from "./utils";
import { tx } from "@hirosystems/clarinet-sdk";
import {
  init_pyth,
  set_initial_price,
  set_price,
  set_price_without_scaling,
  set_pyth_time_delta,
} from "./pyth";

const accounts = simnet.getAccounts();
const borrower1 = accounts.get("wallet_1")!;
const borrower2 = accounts.get("wallet_2")!;
const depositor = accounts.get("wallet_4")!;
const deployer = accounts.get("deployer")!;
const btc_collateral_contract = contractPrincipalCV(deployer, "mock-btc");
const flashLoanCallbackContract = Cl.contractPrincipal(
  deployer,
  "mock-liquidator-with-flash-loan"
);

describe("liquidation tests", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(100000, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10000000000000n); // 100k USDC
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 1n, deployer);
    await set_initial_price("mock-eth", 1n, deployer);
  });

  it("should return partial collateral - market decimals == collateral decimals", () => {
    const debt = Cl.uint(515000000000);
    const totalCollateralsLiquidValue = Cl.uint(499968000000);
    const liquidationDiscount = Cl.uint(10000000);
    const collateralLiquidLTV = Cl.uint(90000000);
    const liquidatorRepayAmount = Cl.uint(100000000000);
    const collateralDecimals = Cl.uint(8);

    const collateralPrice = 2250000000000n;
    const depositedCollateral = 7200000n;
    const collateralValue = collateralPrice * depositedCollateral;

    const args = [
      debt,
      totalCollateralsLiquidValue,
      Cl.uint(collateralValue),
      liquidationDiscount,
      collateralLiquidLTV,
      Cl.uint(depositedCollateral),
      Cl.uint(collateralPrice),
      liquidatorRepayAmount,
      collateralDecimals,
    ];
    const result = simnet.callReadOnlyFn(
      "liquidator-v1",
      "liquidate",
      args,
      borrower1
    );
    expect(result.result.value.data["repay-amount"]).toStrictEqual(
      Cl.uint(100000000000)
    );
    const collateralToGive =
      result.result.value.data["collateral-to-give"].value;
    expect(collateralToGive).toStrictEqual(4888888n);
    expect(collateralToGive).toBeLessThan(depositedCollateral);
  });

  it("should return partial collateral - market decimals < collateral decimals", () => {
    const debt = Cl.uint(2418649660n);
    const totalCollateralsLiquidValue = Cl.uint(2412203876n);
    const liquidationDiscount = Cl.uint(10000000n);
    const collateralLiquidLTV = Cl.uint(80000000n);
    const liquidatorRepayAmount = Cl.uint(53714866n);
    const collateralDecimals = Cl.uint(10);

    const collateralPrice = 54827924n;
    const depositedCollateral = 549948753641n;
    const collateralValue = collateralPrice * depositedCollateral;

    const args = [
      debt,
      totalCollateralsLiquidValue,
      Cl.uint(collateralValue),
      liquidationDiscount,
      collateralLiquidLTV,
      Cl.uint(depositedCollateral),
      Cl.uint(collateralPrice),
      liquidatorRepayAmount,
      collateralDecimals,
    ];
    const result = simnet.callReadOnlyFn(
      "liquidator-v1",
      "liquidate",
      args,
      borrower1
    );
    expect(result.result.value.data["repay-amount"]).toStrictEqual(
      Cl.uint(53714866n)
    );
    const collateralToGive =
      result.result.value.data["collateral-to-give"].value;
    expect(collateralToGive).toStrictEqual(10776689600n);
    expect(collateralToGive).toBeLessThan(depositedCollateral);
  });

  it("should return partial collateral - market decimals > collateral decimals", () => {
    const debt = Cl.uint(2418649660n);
    const totalCollateralsLiquidValue = Cl.uint(2407804240n);
    const liquidationDiscount = Cl.uint(10000000n);
    const collateralLiquidLTV = Cl.uint(80000000n);
    const liquidatorRepayAmount = Cl.uint(90378500n);
    const collateralDecimals = Cl.uint(6);

    const collateralPrice = 54727924n;
    const depositedCollateral = 54994875n;
    const collateralValue = collateralPrice * depositedCollateral;

    const args = [
      debt,
      totalCollateralsLiquidValue,
      Cl.uint(collateralValue),
      liquidationDiscount,
      collateralLiquidLTV,
      Cl.uint(depositedCollateral),
      Cl.uint(collateralPrice),
      liquidatorRepayAmount,
      collateralDecimals,
    ];
    const result = simnet.callReadOnlyFn(
      "liquidator-v1",
      "liquidate",
      args,
      borrower1
    );
    expect(result.result.value.data["repay-amount"]).toStrictEqual(
      Cl.uint(90378500n)
    );
    const collateralToGive =
      result.result.value.data["collateral-to-give"].value;
    expect(collateralToGive).toStrictEqual(1816556n);
    expect(collateralToGive).toBeLessThan(depositedCollateral);
  });

  it("should return full collateral - market decimals == collateral decimals", () => {
    const debt = Cl.uint(515000000000);
    const totalCollateralsLiquidValue = Cl.uint(499968000000);
    const liquidationDiscount = Cl.uint(10000000);
    const collateralLiquidLTV = Cl.uint(90000000);
    const liquidatorRepayAmount = Cl.uint(147272727273);
    const collateralDecimals = Cl.uint(8);

    const collateralPrice = 2250000000000n;
    const depositedCollateral = 7200000n;
    const collateralValue = collateralPrice * depositedCollateral;

    const args = [
      debt,
      totalCollateralsLiquidValue,
      Cl.uint(collateralValue),
      liquidationDiscount,
      collateralLiquidLTV,
      Cl.uint(depositedCollateral),
      Cl.uint(collateralPrice),
      liquidatorRepayAmount,
      collateralDecimals,
    ];
    const result = simnet.callReadOnlyFn(
      "liquidator-v1",
      "liquidate",
      args,
      borrower1
    );
    expect(result.result.value.data["repay-amount"]).toStrictEqual(
      Cl.uint(147272727273)
    );
    expect(result.result.value.data["collateral-to-give"]).toStrictEqual(
      Cl.uint(depositedCollateral)
    );
  });

  it("should return full collateral - market decimals < collateral decimals", () => {
    const debt = Cl.uint(515000000000);
    const totalCollateralsLiquidValue = Cl.uint(499968000000);
    const liquidationDiscount = Cl.uint(10000000);
    const collateralLiquidLTV = Cl.uint(90000000);
    const liquidatorRepayAmount = Cl.uint(147272727273);
    const collateralDecimals = Cl.uint(10);

    const collateralPrice = 2250000000000n;
    const depositedCollateral = 7200000n;
    const collateralValue = collateralPrice * depositedCollateral;

    const args = [
      debt,
      totalCollateralsLiquidValue,
      Cl.uint(collateralValue),
      liquidationDiscount,
      collateralLiquidLTV,
      Cl.uint(depositedCollateral),
      Cl.uint(collateralPrice),
      liquidatorRepayAmount,
      collateralDecimals,
    ];
    const result = simnet.callReadOnlyFn(
      "liquidator-v1",
      "liquidate",
      args,
      borrower1
    );
    expect(result.result.value.data["repay-amount"]).toStrictEqual(
      Cl.uint(147272727273)
    );
    expect(result.result.value.data["collateral-to-give"]).toStrictEqual(
      Cl.uint(depositedCollateral)
    );
  });

  it("should return full collateral - market decimals > collateral decimals", () => {
    const debt = Cl.uint(2418649660n);
    const totalCollateralsLiquidValue = Cl.uint(1972244800n);
    const liquidationDiscount = Cl.uint(10000000n);
    const collateralLiquidLTV = Cl.uint(80000000n);
    const liquidatorRepayAmount = Cl.uint(2241187273n);
    const collateralDecimals = Cl.uint(6);

    const collateralPrice = 43827924n;
    const depositedCollateral = 54994875n;
    const collateralValue = collateralPrice * depositedCollateral;

    const args = [
      debt,
      totalCollateralsLiquidValue,
      Cl.uint(collateralValue),
      liquidationDiscount,
      collateralLiquidLTV,
      Cl.uint(depositedCollateral),
      Cl.uint(collateralPrice),
      liquidatorRepayAmount,
      collateralDecimals,
    ];
    const result = simnet.callReadOnlyFn(
      "liquidator-v1",
      "liquidate",
      args,
      borrower1
    );
    expect(result.result.value.data["repay-amount"]).toStrictEqual(
      Cl.uint(2241187273n)
    );
    expect(result.result.value.data["collateral-to-give"]).toStrictEqual(
      Cl.uint(depositedCollateral)
    );
  });

  it("repay amount should return expected value since it does not exceed collateral value - market decimals == collateral decimals", () => {
    const debt = Cl.uint(515000000000);
    const totalCollateralsLiquidValue = Cl.uint(499968000000);
    const liquidationDiscount = Cl.uint(12000000);
    const collateralLiquidLTV = Cl.uint(70000000);
    const liquidatorRepayAmount = Cl.uint(69592592592);
    const collateralDecimals = Cl.uint(8);

    const collateralPrice = 2000000000000n;
    const depositedCollateral = 62500000n;
    const collateralValue = collateralPrice * depositedCollateral;

    const args = [
      debt,
      totalCollateralsLiquidValue,
      Cl.uint(collateralValue),
      liquidationDiscount,
      collateralLiquidLTV,
      Cl.uint(depositedCollateral),
      Cl.uint(collateralPrice),
      liquidatorRepayAmount,
      collateralDecimals,
    ];
    const result = simnet.callReadOnlyFn(
      "liquidator-v1",
      "liquidate",
      args,
      borrower1
    );
    expect(result.result.value.data["repay-amount"]).toStrictEqual(
      Cl.uint(69592592592)
    );
    expect(result.result.value.data["collateral-to-give"]).toStrictEqual(
      Cl.uint(3897185)
    );
  });

  it("should liquidate correctly for single collaterals", async () => {
    mint_token("mock-usdc", 100000000000, depositor);
    deposit(100000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      90000000,
      95000000,
      5000000,
      8,
      deployer
    );
    mint_token("mock-btc", 100000000000, borrower1);
    add_collateral("mock-btc", 20000000000, deployer, borrower1);

    borrow(18000000000, borrower1);

    // User should have 100 assets after borrow
    const userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(18000000000n);

    // account health should be more than 100
    let accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(105555555n)
    );

    update_supported_collateral(
      "mock-btc",
      40000000,
      50000000,
      2000000,
      8,
      deployer
    );

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(55555555n)
    );

    mint_token("mock-usdc", 18181818181, depositor);
    let liquidate = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.none(),
        btc_collateral_contract,
        Cl.principal(borrower1),
        Cl.uint(18181818181),
        Cl.uint(1),
      ],
      depositor
    );
    expect(liquidate.result).toBeOk(Cl.bool(true));

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(100000000n)
    );
  });

  it("should liquidate fail for zero repay amount", async () => {
    mint_token("mock-usdc", 100000000000, depositor);
    deposit(100000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      90000000,
      95000000,
      5000000,
      8,
      deployer
    );
    mint_token("mock-btc", 100000000000, borrower1);
    add_collateral("mock-btc", 20000000000, deployer, borrower1);

    borrow(18000000000, borrower1);

    // User should have 100 assets after borrow
    const userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(18000000000n);

    // account health should be more than 100
    let accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(105555555n)
    );

    update_supported_collateral(
      "mock-btc",
      40000000,
      50000000,
      2000000,
      8,
      deployer
    );

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(55555555n)
    );

    let pre = simnet.callReadOnlyFn(
      "mock-btc",
      "get-balance",
      [Cl.principal(depositor)],
      borrower1
    ).result.value.value;

    let liquidate = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.none(),
        btc_collateral_contract,
        Cl.principal(borrower1),
        Cl.uint(0),
        Cl.uint(1),
      ],
      depositor
    );
    expect(liquidate.result).toBeErr(Cl.uint(30010));

    let post = simnet.callReadOnlyFn(
      "mock-btc",
      "get-balance",
      [Cl.principal(depositor)],
      borrower1
    );

    expect(post.result.value.value).toStrictEqual(pre);

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(55555555n)
    );
  });

  it("should not allow liquidation in the same block", async () => {
    mint_token("mock-usdc", 100000000000, depositor);
    deposit(100000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      90000000,
      95000000,
      5000000,
      8,
      deployer
    );
    mint_token("mock-btc", 100000000000, borrower1);
    add_collateral("mock-btc", 20000000000, deployer, borrower1);

    let block = simnet.mineBlock([
      // borrow
      tx.callPublicFn(
        "borrower-v1",
        "borrow",
        [Cl.none(), Cl.uint(18000000000)],
        borrower1
      ),
      // make position insolvant
      tx.callPublicFn(
        "state-v1",
        "update-collateral-settings",
        [
          Cl.contractPrincipal(deployer, "mock-btc"),
          Cl.uint(40000000),
          Cl.uint(50000000),
          Cl.uint(2000000),
          Cl.uint(8),
        ],
        deployer
      ),
      // mint assets
      tx.callPublicFn(
        "mock-usdc",
        "mint",
        [Cl.uint(18181818181), Cl.principal(borrower1)],
        borrower1
      ),
      // liquidate collateral should fail
      tx.callPublicFn(
        "liquidator-v1",
        "liquidate-collateral",
        [
          Cl.none(),
          btc_collateral_contract,
          Cl.principal(borrower1),
          Cl.uint(18181818181),
          Cl.uint(1),
        ],
        borrower1
      ),
    ]);

    let length = block.length;
    block.forEach((txn, index) => {
      if (index == length - 1) {
        expect(txn.result).toBeErr(Cl.uint(113)); // ERR-LIQUIDATION-NOT-ALLOWED
      } else {
        expect(txn.result).toBeOk(Cl.bool(true));
      }
    });
  });

  it("should liquidate correctly for multiple collaterals", async () => {
    mint_token("mock-usdc", 100000000000, depositor);
    deposit(100000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      90000000,
      95000000,
      5000000,
      8,
      deployer
    );
    update_supported_collateral(
      "mock-eth",
      70000000,
      80000000,
      10000000,
      8,
      deployer
    );
    mint_token("mock-btc", 100000000000, borrower1);
    mint_token("mock-eth", 100000000000, borrower1);
    add_collateral("mock-btc", 20000000000, deployer, borrower1);
    add_collateral("mock-eth", 30000000000, deployer, borrower1);

    borrow(39000000000, borrower1);

    // User should have 100 assets after borrow
    const userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(39000000000n);

    // account health should be more than 100
    let accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(110256410n)
    );

    update_supported_collateral(
      "mock-btc",
      40000000,
      50000000,
      10000000,
      8,
      deployer
    );

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(87179487n)
    );

    mint_token("mock-usdc", 17777777777, depositor);

    let liquidate = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.none(),
        btc_collateral_contract,
        Cl.principal(borrower1),
        Cl.uint(17777777777),
        Cl.uint(18000000000),
      ],
      depositor
    );
    expect(liquidate.result).toBeErr(Cl.uint(30007)); // 30007 - ERR-SLIPPAGE

    liquidate = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.none(),
        btc_collateral_contract,
        Cl.principal(borrower1),
        Cl.uint(17777777777),
        Cl.uint(1),
      ],
      depositor
    );
    expect(liquidate.result).toBeOk(Cl.bool(true));

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(100000000n)
    );
  });

  it("should correctly update account health if market asset decreases", async () => {
    mint_token("mock-usdc", 100000000000, depositor);
    deposit(100000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      70000000,
      80000000,
      10000000,
      8,
      deployer
    );
    mint_token("mock-btc", 100000000000, borrower1);
    add_collateral("mock-btc", 20000000000, deployer, borrower1);
    simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(10000000000)],
      borrower1
    );

    await set_price("mock-usdc", scalingFactor / 2n, deployer);

    let accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(3n)
    );

    repay(10000000000, borrower1);
  });

  it("should liquidate correctly for single collaterals with bad debt", async () => {
    mint_token("mock-usdc", 100000000000, depositor);
    deposit(100000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      90000000,
      95000000,
      5000000,
      8,
      deployer
    );
    mint_token("mock-btc", 100000000000, borrower1);
    add_collateral("mock-btc", 20000000000, deployer, borrower1);

    borrow(18000000000, borrower1);

    // User should have 100 assets after borrow
    const userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(18000000000n);

    // account health should be more than 100
    let accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(105555555n)
    );

    update_supported_collateral(
      "mock-btc",
      40000000,
      50000000,
      20000000,
      8,
      deployer
    );

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(55555555n)
    );

    mint_token("mock-usdc", 18181818181, depositor);
    let liquidate = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.none(),
        btc_collateral_contract,
        Cl.principal(borrower1),
        Cl.uint(18181818181),
        Cl.uint(1),
      ],
      depositor
    );
    expect(liquidate.result).toBeOk(Cl.bool(true));
  });

  it("should liquidate correctly for multiple collaterals with bad debt", async () => {
    mint_token("mock-usdc", 100000000000, depositor);
    deposit(100000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      90000000,
      95000000,
      5000000,
      8,
      deployer
    );
    update_supported_collateral(
      "mock-eth",
      70000000,
      80000000,
      10000000,
      8,
      deployer
    );
    mint_token("mock-btc", 100000000000, borrower1);
    mint_token("mock-eth", 100000000000, borrower1);
    add_collateral("mock-btc", 20000000000, deployer, borrower1);
    add_collateral("mock-eth", 30000000000, deployer, borrower1);

    borrow(39000000000, borrower1);

    // User should have 100 assets after borrow
    const userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(39000000000n);

    // account health should be more than 100
    let accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(110256410n)
    );

    update_supported_collateral(
      "mock-btc",
      40000000,
      50000000,
      50000000,
      8,
      deployer
    );

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(87179487n)
    );

    mint_token("mock-usdc", 39000013190, depositor);
    let liquidate = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.none(),
        btc_collateral_contract,
        Cl.principal(borrower1),
        Cl.uint(39000013190),
        Cl.uint(1),
      ],
      depositor
    );
    expect(liquidate.result).toBeOk(Cl.bool(true));
  });

  it("batch liquidate collateral", async () => {
    mint_token("mock-usdc", 200000000000, depositor);
    deposit(200000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      90000000,
      95000000,
      5000000,
      8,
      deployer
    );
    update_supported_collateral(
      "mock-eth",
      70000000,
      80000000,
      10000000,
      8,
      deployer
    );
    mint_token("mock-btc", 100000000000, borrower1);
    mint_token("mock-eth", 100000000000, borrower1);
    mint_token("mock-btc", 100000000000, borrower2);
    mint_token("mock-eth", 100000000000, borrower2);
    add_collateral("mock-btc", 20000000000, deployer, borrower1);
    add_collateral("mock-eth", 30000000000, deployer, borrower1);
    add_collateral("mock-btc", 20000000000, deployer, borrower2);
    add_collateral("mock-eth", 30000000000, deployer, borrower2);

    borrow(39000000000, borrower1);
    borrow(39000000000, borrower2);

    // User should have 100 assets after borrow
    let userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(39000000000n);

    userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower2)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(39000000000n);

    // account health should be more than 100
    let accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(110256394n)
    );

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower2), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(110256410n)
    );

    update_supported_collateral(
      "mock-btc",
      40000000,
      50000000,
      50000000,
      8,
      deployer
    );

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(87179474n)
    );

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower2), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(87179487n)
    );

    mint_token("mock-usdc", 39000013190, depositor);

    const liquidateData1 = Cl.some(
      Cl.tuple({
        user: Cl.principal(borrower1),
        "liquidator-repay-amount": Cl.uint(39000013190),
        "min-collateral-expected": Cl.uint(1),
      })
    );

    const liquidateData2 = Cl.some(
      Cl.tuple({
        user: Cl.principal(borrower2),
        "liquidator-repay-amount": Cl.uint(39000013190),
        "min-collateral-expected": Cl.uint(1),
      })
    );

    let batchData = [
      liquidateData1,
      liquidateData2,
      ...new Array(18).fill(Cl.none()),
    ];
    let liquidate = simnet.callPublicFn(
      "liquidator-v1",
      "batch-liquidate",
      [Cl.none(), btc_collateral_contract, Cl.list(batchData)],
      depositor
    );
    expect(liquidate.result).toBeOk(Cl.bool(true));
  });

  it("should liquidate correctly a collateral with price 0", async () => {
    mint_token("mock-usdc", 100000000000, depositor);
    deposit(100000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      90000000,
      95000000,
      5000000,
      8,
      deployer
    );
    mint_token("mock-btc", 100000000000, borrower1);
    add_collateral("mock-btc", 20000000000, deployer, borrower1);

    borrow(18000000000, borrower1);

    await set_price("mock-btc", 0n, deployer);

    let liquidate = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.none(),
        btc_collateral_contract,
        Cl.principal(borrower1),
        Cl.uint(0),
        Cl.uint(20000000000),
      ],
      depositor
    );
    expect(liquidate.result).toBeOk(Cl.bool(true));
  });

  it("test liquidation buffer", async () => {
    set_asset_cap(deployer, 50000000000000n);
    mint_token("mock-usdc", 30000000000000, depositor);
    deposit(30000000000000, depositor);

    update_supported_collateral(
      "mock-eth",
      50000000,
      51000000,
      1000000,
      8,
      deployer
    );
    mint_token("mock-eth", 1000000000, borrower1);
    add_collateral("mock-eth", 1000000000, deployer, borrower1);

    await set_price("mock-eth", 5000n, deployer);

    borrow(2400000000000, borrower1);

    // User should have 100 assets after borrow
    const userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(2400000000000n);

    // account health should be more than 100
    let accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(106250000n)
    );

    await set_price_without_scaling("mock-eth", 324710577640n, deployer);
    await set_price_without_scaling("mock-usdc", 100001113n, deployer);
    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(69000229n)
    );

    mint_token("mock-usdc", 30000000000000, depositor);
    let liquidate = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.none(),
        contractPrincipalCV(deployer, "mock-eth"),
        Cl.principal(borrower1),
        Cl.uint(2500000000000),
        Cl.uint(1),
      ],
      depositor
    );
    expect(liquidate.result).toBeOk(Cl.bool(true));

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(100001972n)
    );
  });

  it("should liquidate partially for single collaterals - market asset decimals > collateral decimals", async () => {
    mint_token("mock-usdc", 100000000000, depositor);
    deposit(100000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      70000000,
      80000000,
      10000000,
      6,
      deployer
    );
    mint_token("mock-btc", 54994875, borrower1);
    add_collateral("mock-btc", 54994875, deployer, borrower1);
    await set_price_without_scaling("mock-btc", 62827924n, deployer);
    borrow(2418649660, borrower1);

    const userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(2418649660n);

    // account health should be more than 100
    let accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(114285714n)
    );

    // price drops
    await set_price_without_scaling("mock-btc", 54727924n, deployer);

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(99551591n)
    );

    mint_token("mock-usdc", 18181818181, depositor);
    let liquidate = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.none(),
        btc_collateral_contract,
        Cl.principal(borrower1),
        Cl.uint(18181818181),
        Cl.uint(1),
      ],
      depositor
    );
    expect(liquidate.result).toBeOk(Cl.bool(true));

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(100000002n)
    );
  });

  it("should liquidate full for single collaterals - market asset decimals > collateral decimals", async () => {
    mint_token("mock-usdc", 100000000000, depositor);
    deposit(100000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      70000000,
      80000000,
      10000000,
      6,
      deployer
    );
    mint_token("mock-btc", 54994875, borrower1);
    add_collateral("mock-btc", 54994875, deployer, borrower1);
    await set_price_without_scaling("mock-btc", 62827924n, deployer);
    borrow(2418649660, borrower1);

    const userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(2418649660n);

    // account health should be more than 100
    let accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(114285714n)
    );

    // price drops
    await set_price_without_scaling("mock-btc", 44827924n, deployer);

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(81543219n)
    );

    mint_token("mock-usdc", 18181818181, depositor);
    let liquidate = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.none(),
        btc_collateral_contract,
        Cl.principal(borrower1),
        Cl.uint(18181818181),
        Cl.uint(1),
      ],
      depositor
    );
    expect(liquidate.result).toBeOk(Cl.bool(true));

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(100000000n)
    );
  });

  it("should liquidate partially for single collaterals - market asset decimals < collateral decimals", async () => {
    mint_token("mock-usdc", 100000000000, depositor);
    deposit(100000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      70000000,
      80000000,
      10000000,
      10,
      deployer
    );
    mint_token("mock-btc", 549948753641, borrower1);
    add_collateral("mock-btc", 549948753641, deployer, borrower1);
    await set_price_without_scaling("mock-btc", 62827924n, deployer);
    borrow(2418649660, borrower1);

    const userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(2418649660n);

    // account health should be more than 100
    let accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(114285715n)
    );

    // price drops
    await set_price_without_scaling("mock-btc", 54827924n, deployer);

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(99733496n)
    );

    mint_token("mock-usdc", 18181818181, depositor);
    let liquidate = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.none(),
        btc_collateral_contract,
        Cl.principal(borrower1),
        Cl.uint(18181818181),
        Cl.uint(1),
      ],
      depositor
    );
    expect(liquidate.result).toBeOk(Cl.bool(true));

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(100000000n)
    );
  });

  it("should liquidate full for single collaterals - market asset decimals < collateral decimals", async () => {
    mint_token("mock-usdc", 100000000000, depositor);
    deposit(100000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      70000000,
      80000000,
      10000000,
      10,
      deployer
    );
    mint_token("mock-btc", 549948753641, borrower1);
    add_collateral("mock-btc", 549948753641, deployer, borrower1);
    await set_price_without_scaling("mock-btc", 62827924n, deployer);
    borrow(2418649660, borrower1);

    const userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(2418649660n);

    // account health should be more than 100
    let accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(114285715n)
    );

    // price drops
    await set_price_without_scaling("mock-btc", 44827924n, deployer);

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(81543222n)
    );

    mint_token("mock-usdc", 18181818181, depositor);
    let liquidate = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.none(),
        btc_collateral_contract,
        Cl.principal(borrower1),
        Cl.uint(18181818181),
        Cl.uint(1),
      ],
      depositor
    );
    expect(liquidate.result).toBeOk(Cl.bool(true));

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(100000000n)
    );
  });

  it("should liquidate correctly for single collaterals with bad debt using flash loan", async () => {
    mint_token("mock-usdc", 100000000000, depositor);
    deposit(100000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      90000000,
      95000000,
      5000000,
      8,
      deployer
    );
    mint_token("mock-btc", 100000000000, borrower1);
    add_collateral("mock-btc", 20000000000, deployer, borrower1);

    borrow(18000000000, borrower1);

    // User should have 180 assets after borrow
    expectUserUSDCBalance(Cl.principal(borrower1), 18000000000n, deployer);

    // account health should be more than 100
    let accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(105555555n)
    );

    update_supported_collateral(
      "mock-btc",
      40000000,
      50000000,
      20000000,
      8,
      deployer
    );

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(55555555n)
    );

    // pre checks
    expectUserUSDCBalance(Cl.principal(depositor), 0n, deployer);
    expectUserUSDCBalance(Cl.principal(borrower1), 18000000000n, deployer);
    expectUserUSDCBalance(
      Cl.contractPrincipal(deployer, "state-v1"),
      82000000000n,
      deployer
    );
    expectUserUSDCBalance(
      Cl.contractPrincipal(deployer, "mock-liquidator-with-flash-loan"),
      0n,
      deployer
    );
    expectUserBTCBalance(
      Cl.contractPrincipal(deployer, "state-v1"),
      20000000000n,
      deployer
    );
    expectUserBTCBalance(flashLoanCallbackContract, 0n, deployer);

    const result = simnet.callPublicFn(
      "flash-loan-v1",
      "set-allowed-contract",
      [flashLoanCallbackContract],
      deployer
    );

    expect(result.result).toBeOk(Cl.bool(true));

    const repayAmount = 16666666667;
    const flashLoanFee = 1666667;
    // mock liquidator should have fee + amount requested for flashloan
    mint_token_to_contract(
      "mock-usdc",
      flashLoanFee + repayAmount,
      flashLoanCallbackContract,
      deployer
    );

    let liquidate = simnet.callPublicFn(
      "mock-liquidator-with-flash-loan",
      "liquidate-collateral",
      [
        Cl.none(),
        Cl.principal(borrower1),
        Cl.uint(repayAmount),
        Cl.uint(1),
        flashLoanCallbackContract,
      ],
      depositor
    );
    expect(liquidate.result).toBeOk(Cl.bool(true));
    //post checks
    expectUserUSDCBalance(Cl.principal(depositor), 0n, deployer);
    expectUserUSDCBalance(Cl.principal(borrower1), 18000000000n, deployer);
    expectUserUSDCBalance(
      Cl.contractPrincipal(deployer, "mock-liquidator-with-flash-loan"),
      0n,
      deployer
    );
    // state contract should have previous balance + fee + liquidated repay amount
    expectUserUSDCBalance(
      Cl.contractPrincipal(deployer, "state-v1"),
      BigInt(82000000000 + flashLoanFee + repayAmount),
      deployer
    );

    // state contract should have no collateral
    expectUserBTCBalance(
      Cl.contractPrincipal(deployer, "state-v1"),
      0n,
      deployer
    );
    // mock liquidator should have all the btc collateral
    expectUserBTCBalance(flashLoanCallbackContract, 20000000000n, deployer);
  });
});
