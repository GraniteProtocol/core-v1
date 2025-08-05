import { assert, beforeEach, describe, expect, it } from "vitest";
import { Cl, contractPrincipalCV, SomeCV, UIntCV } from "@stacks/transactions";
import {
  add_collateral,
  borrow,
  deposit,
  set_allowed_contracts,
  initialize_ir,
  mint_token,
  remove_collateral,
  repay,
  update_supported_collateral,
  set_asset_cap,
  initialize_staking_reward,
} from "./utils";
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
const borrower3 = accounts.get("wallet_3")!;
const depositor = accounts.get("wallet_4")!;
const deployer = accounts.get("deployer")!;
const btc_collateral_contract = contractPrincipalCV(deployer, "mock-btc");

describe("borrower tests", () => {
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

  it("should fail adding unsupported collateral", async () => {
    // Attempt to deposit invalid collateral
    const deposit = simnet.callPublicFn(
      "borrower-v1",
      "add-collateral",
      [btc_collateral_contract, Cl.uint(0), Cl.none()],
      borrower1
    );
    expect(deposit.result).toBeErr(Cl.uint(108));
    // 900 = ERR-COLLATERAL-NOT-SUPPORTED
  });

  it("should revert remove collateral because of max ltv for a single collateral", async () => {
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
    update_supported_collateral(
      "mock-eth",
      50000000,
      70000000,
      10000000,
      8,
      deployer
    );

    mint_token("mock-btc", 100000000000, borrower1);
    mint_token("mock-eth", 100000000000, borrower1);

    add_collateral("mock-btc", 100000000000, deployer, borrower1);
    add_collateral("mock-eth", 50000000000, deployer, borrower1);

    const borrow = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(70000000000), Cl.none()],
      borrower1
    );
    expect(borrow.result).toBeOk(Cl.bool(true));

    const response = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [
        Cl.none(),
        Cl.contractPrincipal(deployer, "mock-btc"),
        Cl.uint(50000000000n),
        Cl.none(),
      ],
      borrower1
    );
    expect(response.result).toBeErr(Cl.uint(20002n));
    // 20002 = ERR-MAX-LTV
  });

  it("should correctly add and remove collateral", async () => {
    update_supported_collateral(
      "mock-btc",
      70000000,
      80000000,
      10000000,
      8,
      deployer
    );

    mint_token("mock-btc", 100000000000, borrower1);

    add_collateral("mock-btc", 100000000000, deployer, borrower1);
    let contractBalance = simnet.callReadOnlyFn(
      "mock-btc",
      "get-balance",
      [Cl.contractPrincipal(deployer, "state-v1")],
      borrower1
    );
    expect(contractBalance.result.value.value).toBe(100000000000n);

    remove_collateral("mock-btc", 90000000000, deployer, borrower1);
    contractBalance = simnet.callReadOnlyFn(
      "mock-btc",
      "get-balance",
      [Cl.contractPrincipal(deployer, "state-v1")],
      borrower1
    );
    expect(contractBalance.result.value.value).toBe(10000000000n);

    // cannot remove more than what posted
    const removeCollateral = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [
        Cl.none(),
        Cl.contractPrincipal(deployer, "mock-btc"),
        Cl.uint(10000000001n),
        Cl.none(),
      ],
      borrower1
    );
    expect(removeCollateral.result).toBeErr(Cl.uint(20006n));
    // 20006 = ERR-INSUFFICIENT-BALANCE

    let position = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(position.result.value.data.collaterals.list[0]).toStrictEqual(
      Cl.contractPrincipal(deployer, "mock-btc")
    );

    remove_collateral("mock-btc", 10000000000, deployer, borrower1);

    position = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(position.result.value.data.collaterals.list.length).toBe(0);
  });

  it("should not allow adding collateral with 0 maxltv", async () => {
    update_supported_collateral("mock-btc", 0, 80000000, 10000000, 8, deployer);

    mint_token("mock-btc", 100000000000, borrower1);

    const addCollateralRes = simnet.callPublicFn(
      "borrower-v1",
      "add-collateral",
      [
        Cl.contractPrincipal(deployer, "mock-btc"),
        Cl.uint(100000000000n),
        Cl.none(),
      ],
      borrower1
    );
    expect(addCollateralRes.result).toBeErr(Cl.uint(20007n));
  });

  it("should correctly add and remove multiple collaterals", async () => {
    update_supported_collateral(
      "mock-btc",
      70000000,
      80000000,
      10000000,
      8,
      deployer
    );
    mint_token("mock-btc", 100000000000, borrower1);
    add_collateral("mock-btc", 100000000000, deployer, borrower1);

    update_supported_collateral(
      "mock-eth",
      50000000,
      67000000,
      15000000,
      8,
      deployer
    );
    mint_token("mock-eth", 100000000000, borrower1);
    add_collateral("mock-eth", 100000000000, deployer, borrower1);

    let position = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(position.result.value.data.collaterals.list[0]).toStrictEqual(
      Cl.contractPrincipal(deployer, "mock-btc")
    );
    expect(position.result.value.data.collaterals.list[1]).toStrictEqual(
      Cl.contractPrincipal(deployer, "mock-eth")
    );
    expect(position.result.value.data.collaterals.list.length).toBe(2);

    const collateralVal = simnet.callReadOnlyFn(
      "borrower-v1",
      "get-user-collaterals-value",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(collateralVal.result.value.value).toBe(200000000000n);

    remove_collateral("mock-eth", 10000000000, deployer, borrower1);
    // mock eth should NOT be removed from the array as there is outstanding balance
    position = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(position.result.value.data.collaterals.list[0]).toStrictEqual(
      Cl.contractPrincipal(deployer, "mock-btc")
    );
    expect(position.result.value.data.collaterals.list[1]).toStrictEqual(
      Cl.contractPrincipal(deployer, "mock-eth")
    );
    expect(position.result.value.data.collaterals.list.length).toBe(2);

    // mock eth should be removed from the array as it was totally withdrawn
    remove_collateral("mock-eth", 90000000000, deployer, borrower1);
    position = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(position.result.value.data.collaterals.list[0]).toStrictEqual(
      Cl.contractPrincipal(deployer, "mock-btc")
    );
    expect(position.result.value.data.collaterals.list.length).toBe(1);
  });

  it("should correctly borrow", async () => {
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
    add_collateral("mock-btc", 10000000000, deployer, borrower1);

    // max ltv error
    let borrow = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(100000000000), Cl.none()],
      borrower1
    );
    expect(borrow.result).toBeErr(Cl.uint(20002));
    // 20002 = ERR-MAX-LTV

    add_collateral("mock-btc", 10000000000, deployer, borrower1);
    borrow = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(10000000000), Cl.none()],
      borrower1
    );
    expect(borrow.result).toBeOk(Cl.bool(true));

    // User should have 100 assets after borrow
    const userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(10000000000n);
  });

  it("should correctly borrow through proxy", async () => {
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

    const response = simnet.callPublicFn(
      "borrower-proxy",
      "add-collateral",
      [Cl.contractPrincipal(deployer, "mock-btc"), Cl.uint(20000000000)],
      borrower1
    );
    expect(response.result).toBeOk(Cl.bool(true));

    let borrow = simnet.callPublicFn(
      "borrower-proxy",
      "borrow",
      [Cl.none(), Cl.uint(10000000000)],
      borrower1
    );
    expect(borrow.result).toBeOk(Cl.bool(true));

    // User should have 100 assets after borrow
    const userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(10000000000n);
  });

  it("should correctly add and remove collateral through proxy", async () => {
    update_supported_collateral(
      "mock-btc",
      70000000,
      80000000,
      10000000,
      8,
      deployer
    );

    mint_token("mock-btc", 100000000000, borrower1);

    let response = simnet.callPublicFn(
      "borrower-proxy",
      "add-collateral",
      [Cl.contractPrincipal(deployer, "mock-btc"), Cl.uint(100000000000)],
      borrower1
    );
    expect(response.result).toBeOk(Cl.bool(true));

    let contractBalance = simnet.callReadOnlyFn(
      "mock-btc",
      "get-balance",
      [Cl.contractPrincipal(deployer, "state-v1")],
      borrower1
    );
    expect(contractBalance.result.value.value).toBe(100000000000n);

    response = simnet.callPublicFn(
      "borrower-proxy",
      "remove-collateral",
      [
        Cl.none(),
        Cl.contractPrincipal(deployer, "mock-btc"),
        Cl.uint(90000000000),
      ],
      borrower1
    );
    expect(response.result).toBeOk(Cl.bool(true));

    contractBalance = simnet.callReadOnlyFn(
      "mock-btc",
      "get-balance",
      [Cl.contractPrincipal(deployer, "state-v1")],
      borrower1
    );
    expect(contractBalance.result.value.value).toBe(10000000000n);

    let position = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(position.result.value.data.collaterals.list[0]).toStrictEqual(
      Cl.contractPrincipal(deployer, "mock-btc")
    );

    response = simnet.callPublicFn(
      "borrower-proxy",
      "remove-collateral",
      [
        Cl.none(),
        Cl.contractPrincipal(deployer, "mock-btc"),
        Cl.uint(10000000000),
      ],
      borrower1
    );
    expect(response.result).toBeOk(Cl.bool(true));

    position = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(position.result.value.data.collaterals.list.length).toBe(0);

    contractBalance = simnet.callReadOnlyFn(
      "mock-btc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(contractBalance.result.value.value).toBe(100000000000n);
  });

  it("should correctly borrow with collateral decimals more than market token decimals", async () => {
    const decimals = 10;
    mint_token("mock-usdc", 100000000000, depositor);
    deposit(100000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      70000000,
      80000000,
      10000000,
      decimals,
      deployer
    );
    mint_token("mock-btc", 10000000000000, borrower1);
    add_collateral("mock-btc", 10000000000000, deployer, borrower1);

    const borrow = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(10000000000), Cl.none()],
      borrower1
    );
    expect(borrow.result).toBeOk(Cl.bool(true));

    const userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(10000000000n);
  });

  it("should correctly borrow with collateral decimals less than market token decimals", async () => {
    const decimals = 6;
    mint_token("mock-usdc", 1000000000, depositor);
    deposit(1000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      70000000,
      80000000,
      10000000,
      decimals,
      deployer
    );
    mint_token("mock-btc", 100000000000, borrower1);
    add_collateral("mock-btc", 1000000000, deployer, borrower1);

    const borrow = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(1000000000), Cl.none()],
      borrower1
    );
    expect(borrow.result).toBeOk(Cl.bool(true));

    const userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(1000000000n);
  });

  it("should revert if borrow greater than free liquidity", async () => {
    mint_token("mock-usdc", 10000000000, depositor);
    deposit(10000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      70000000,
      80000000,
      10000000,
      8,
      deployer
    );
    mint_token("mock-btc", 100000000000, borrower1);
    add_collateral("mock-btc", 100000000000, deployer, borrower1);

    let borrow = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(11000000000), Cl.none()],
      borrower1
    );
    expect(borrow.result).toBeErr(Cl.uint(20001));
    // 20001 = ERR-INSUFFICIENT-FREE-LIQUIDITY
  });

  it("should correctly handle multiple borrows", async () => {
    mint_token("mock-usdc", 1000000000000, depositor);
    deposit(1000000000000, depositor);

    update_supported_collateral(
      "mock-btc",
      70000000,
      80000000,
      10000000,
      8,
      deployer
    );

    mint_token("mock-btc", 100000000000, borrower1);
    add_collateral("mock-btc", 100000000000, deployer, borrower1);
    mint_token("mock-btc", 150000000000, borrower2);
    add_collateral("mock-btc", 150000000000, deployer, borrower2);

    borrow(70000000000, borrower1);
    borrow(100000000000, borrower2);

    const open_interest = simnet.callReadOnlyFn(
      "state-v1",
      "get-open-interest",
      [],
      deployer
    );
    expect(open_interest.result.data["lp-open-interest"].value).toBe(
      170000007825n
    );

    repay(50000000000, borrower1);
    borrow(40000000000, borrower1);

    const value = simnet.callReadOnlyFn(
      "state-v1",
      "get-protocol-reserve-percentage",
      [],
      deployer
    );
    expect(value.result).toEqual(Cl.uint(0));
  });

  it("should correctly borrow and repay partial", async () => {
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
    const borrow = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(10000000000), Cl.none()],
      borrower1
    );
    expect(borrow.result).toBeOk(Cl.bool(true));

    // get user debt shares
    let initialDebtShares = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(initialDebtShares.result.value.data["debt-shares"].value).toEqual(
      10000000000n
    );

    // User should have 100 assets after borrow
    let userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(10000000000n);

    // repay partially
    let repay = simnet.callPublicFn(
      "borrower-v1",
      "repay",
      [Cl.uint(5000000000), Cl.none()],
      borrower1
    );
    expect(borrow.result).toBeOk(Cl.bool(true));

    // User should have 50 assets after borrow
    userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(5000000000n);

    // user should have around half the debt shares including the interest
    let userDebtShares = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userDebtShares.result.value.data["debt-shares"].value).toEqual(
      5000000595n
    );

    // mint extra 10 asset and try to repay full
    mint_token("mock-usdc", 1000000000, borrower1);
    repay = simnet.callPublicFn(
      "borrower-v1",
      "repay",
      [Cl.uint(6000000000), Cl.none()],
      borrower1
    );
    expect(borrow.result).toBeOk(Cl.bool(true));
    let repaidAmount = repay.events[3].data.value.data.assets.value;
    let remainingAmount = BigInt(6000000000) - repaidAmount;

    // user should have zero debt shares
    userDebtShares = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userDebtShares.result.value.data["debt-shares"].value).toEqual(0n);

    // User should have close to 9.7 assets post full repay including interest
    userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(remainingAmount);
  });

  it("should correctly borrow and repay full", async () => {
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
    const borrow = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(10000000000), Cl.none()],
      borrower1
    );
    expect(borrow.result).toBeOk(Cl.bool(true));

    // get user debt shares
    let initialDebtShares = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(initialDebtShares.result.value.data["debt-shares"].value).toEqual(
      10000000000n
    );

    // User should have 100 assets after borrow
    let userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(10000000000n);

    // mint extra assets to pay for interest and try to repay full
    mint_token("mock-usdc", 1000000000, borrower1);
    let repay = simnet.callPublicFn(
      "borrower-v1",
      "repay",
      [Cl.uint(11000000000), Cl.none()],
      borrower1
    );
    expect(borrow.result).toBeOk(Cl.bool(true));

    let repaidAmount = repay.events[3].data.value.data.assets.value;
    let remainingAmount = BigInt(11000000000) - repaidAmount;

    // user should have zero debt shares
    let userDebtShares = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userDebtShares.result.value.data["debt-shares"].value).toEqual(0n);

    // User should have close to 9.7 assets post full repay including interest
    userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toStrictEqual(
      remainingAmount
    );
  });

  it("repay can be done by other user", async () => {
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
    const borrow = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(10000000000), Cl.none()],
      borrower1
    );
    expect(borrow.result).toBeOk(Cl.bool(true));

    // get user debt shares
    let initialDebtShares = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(initialDebtShares.result.value.data["debt-shares"].value).toEqual(
      10000000000n
    );

    // User should have 100 assets after borrow
    let userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(10000000000n);

    // mint extra assets to pay for interest and try to repay full
    // depositor repays for borrower1
    mint_token("mock-usdc", 11000000000, depositor);
    let repay = simnet.callPublicFn(
      "borrower-v1",
      "repay",
      [Cl.uint(11000000000), Cl.some(Cl.principal(borrower1))],
      depositor
    );
    expect(repay.result).toBeOk(Cl.bool(true));

    // user should have zero debt shares
    let userDebtShares = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userDebtShares.result.value.data["debt-shares"].value).toEqual(0n);
  });

  it("Stock price manipulation through free-liquidity should not happen", async () => {
    update_supported_collateral(
      "mock-btc",
      70000000,
      80000000,
      10000000,
      8,
      deployer
    );
    mint_token("mock-btc", 2e8, borrower1);
    mint_token("mock-usdc", 100000001, borrower1);
    mint_token("mock-usdc", 1800000e8, borrower2);

    // 1. attacker deposit 1
    deposit(1, borrower1);

    let userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(100000000n);

    // 2. attacker add collateral
    add_collateral("mock-btc", 2e8, deployer, borrower1);

    // 3. attacker transfer 1e8 usdc to state.clar contract
    const transferUsdc = simnet.callPublicFn(
      "mock-usdc",
      "transfer",
      [
        Cl.uint(1e8),
        Cl.principal(borrower1),
        Cl.contractPrincipal(deployer, "state-v1"),
        Cl.none(),
      ],
      borrower1
    );
    expect(transferUsdc.result).toBeOk(Cl.bool(true));

    userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(0n);

    // 4. attacker borrow 0.9999991e8 from state, should result to insufficient balance to borrow
    const borrow = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(0.99999991e8), Cl.none()],
      borrower1
    );
    expect(borrow.result).toBeErr(Cl.uint(20001));

    // 5. victim deposit many usdc to protocol, and receive the same amount of share token balance
    deposit(9999999999999, borrower2);

    let shareTokenBalance = simnet.callReadOnlyFn(
      "state-v1",
      "get-balance",
      [Cl.principal(borrower2)],
      borrower2
    );
    expect(shareTokenBalance.result.value.value).toEqual(9999999999999n);

    shareTokenBalance = simnet.callReadOnlyFn(
      "state-v1",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower2
    );
    expect(shareTokenBalance.result.value.value).toEqual(1n);

    // 6. attacker redeem but cannot steal from protocol
    const response = simnet.callPublicFn(
      "liquidity-provider-v1",
      "redeem",
      [Cl.uint(1), Cl.principal(borrower1)],
      borrower1
    );
    expect(response.result).toBeOk(Cl.bool(true));

    // atacker would have lost 1e8 to the state contract without the possibility to get it back
    userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(1n);
  });

  function getTimeForBlock(block: `u${number}`): bigint {
    const clTime: SomeCV<UIntCV> = Cl.deserialize(
      simnet.runSnippet(`(get-stacks-block-info? time ${block})`)
    );
    return clTime.value.value;
  }

  it("should fail to borrow due to pyth stale price", async () => {
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
    add_collateral("mock-btc", 10000000000, deployer, borrower1);

    let publishedTime = await set_price("mock-btc", 1n, deployer);
    simnet.mineEmptyBlocks(1000);
    let blockTime = getTimeForBlock("u1000");
    assert(publishedTime < blockTime - 1n);

    // pyth read price should fail
    let readPrice = simnet.callReadOnlyFn(
      "pyth-adapter-v1",
      "read-price",
      [Cl.contractPrincipal(deployer, "mock-btc")],
      deployer
    );
    expect(readPrice.result).toBeErr(Cl.uint(80002));

    // borrow should panic due to stale price
    try {
      simnet.callPublicFn(
        "borrower-v1",
        "borrow",
        [Cl.none(), Cl.uint(100000000000), Cl.none()],
        borrower1
      );
    } catch (err) {}
  });

  it("should correctly borrow when market-decimals > collateral decimals", async () => {
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
    let borrow = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(2418649660), Cl.none()],
      borrower1
    );

    expect(borrow.result).toBeOk(Cl.bool(true));

    let userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(2418649660n);

    // extra interest
    mint_token("mock-usdc", 488, borrower1);
    userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(488n + 2418649660n);
    let repay = simnet.callPublicFn(
      "borrower-v1",
      "repay",
      [Cl.uint(100000000000), Cl.none()],
      borrower1
    );
    expect(repay.result).toBeOk(Cl.bool(true));

    userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(0n);

    // user should have zero debt shares
    let userDebtShares = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userDebtShares.result.value.data["debt-shares"].value).toEqual(0n);

    remove_collateral("mock-btc", 54994875, deployer, borrower1);
  });

  it("should correctly borrow when market-decimals < collateral decimals", async () => {
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
    let borrow = simnet.callPublicFn(
      "borrower-v1",
      "borrow",
      [Cl.none(), Cl.uint(2418649660), Cl.none()],
      borrower1
    );

    expect(borrow.result).toBeOk(Cl.bool(true));

    let userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(2418649660n);

    // extra interest
    mint_token("mock-usdc", 488, borrower1);
    userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(488n + 2418649660n);
    let repay = simnet.callPublicFn(
      "borrower-v1",
      "repay",
      [Cl.uint(100000000000), Cl.none()],
      borrower1
    );
    expect(repay.result).toBeOk(Cl.bool(true));

    userBalancePostBorrow = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userBalancePostBorrow.result.value.value).toBe(0n);

    // user should have zero debt shares
    let userDebtShares = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userDebtShares.result.value.data["debt-shares"].value).toEqual(0n);

    remove_collateral("mock-btc", 549948753641, deployer, borrower1);
  });
});
