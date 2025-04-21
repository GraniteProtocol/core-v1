import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";
import {
  initialize_ir,
  set_allowed_contracts,
  update_supported_collateral,
  mint_token,
  add_collateral,
  borrow,
  deposit_and_borrow,
  set_asset_cap,
  initialize_staking_reward,
} from "./utils";
import {
  init_pyth,
  set_initial_price,
  set_price,
  set_pyth_time_delta,
} from "./pyth";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const depositor1 = accounts.get("wallet_1")!;
const borrower1 = accounts.get("wallet_2")!;

describe("Borrower User flow tests", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(100000, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10000000000000n); // 100k USDC
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 10n, deployer);
    await set_initial_price("mock-eth", 1n, deployer);
  });

  it("Borrower borrows and repay", async () => {
    deposit_and_borrow(2000, depositor1, 100, 300, borrower1, deployer);

    // accrue interest
    simnet.mineEmptyBlocks(5);

    borrow(396, borrower1);

    // accrue interest
    simnet.mineEmptyBlocks(5);

    update_supported_collateral(
      "mock-eth",
      70000000,
      80000000,
      10000000,
      8,
      deployer
    );
    mint_token("mock-eth", 1000, borrower1);
    add_collateral("mock-eth", 1000, deployer, borrower1);

    borrow(689, borrower1);

    // accrue interest
    simnet.mineEmptyBlocks(5);

    // repay
    mint_token("mock-usdc", 693, borrower1);
    let repay = simnet.callPublicFn(
      "borrower-v1",
      "repay",
      [Cl.uint(693), Cl.none()],
      borrower1
    );
    expect(repay.result).toBeOk(Cl.bool(true));

    // remove max collateral
    let response = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [Cl.none(), Cl.contractPrincipal(deployer, "mock-btc"), Cl.uint(40)],
      borrower1
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [Cl.none(), Cl.contractPrincipal(deployer, "mock-eth"), Cl.uint(490)],
      borrower1
    );
    expect(response.result).toBeOk(Cl.bool(true));

    // accrue interest
    simnet.mineEmptyBlocks(5);

    mint_token("mock-eth", 490, borrower1);
    add_collateral("mock-eth", 490, deployer, borrower1);

    // borrow max
    borrow(369, borrower1);

    // accrue interest
    simnet.mineEmptyBlocks(5);

    mint_token("mock-usdc", 1150, borrower1);
    repay = simnet.callPublicFn(
      "borrower-v1",
      "repay",
      [Cl.uint(1139), Cl.none()],
      borrower1
    );
    expect(repay.result).toBeOk(Cl.bool(true));

    response = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [Cl.none(), Cl.contractPrincipal(deployer, "mock-btc"), Cl.uint(60)],
      borrower1
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [Cl.none(), Cl.contractPrincipal(deployer, "mock-eth"), Cl.uint(1000)],
      borrower1
    );
    expect(response.result).toBeOk(Cl.bool(true));

    const position = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(position.result.value.data["debt-shares"].value).toBe(0n);
  });

  it("Borrower borrows and partial liquidation", async () => {
    deposit_and_borrow(2000, depositor1, 100, 700, borrower1, deployer);

    // accrue interest
    simnet.mineEmptyBlocks(5);

    update_supported_collateral(
      "mock-eth",
      70000000,
      80000000,
      10000000,
      8,
      deployer
    );
    mint_token("mock-eth", 1000, borrower1);
    add_collateral("mock-eth", 1000, deployer, borrower1);

    borrow(686, borrower1);

    // accrue interest
    simnet.mineEmptyBlocks(5);

    let accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(115356885n)
    );

    // btc pricecrash
    await set_price("mock-btc", 7n, deployer);

    simnet.mineEmptyBlocks(1);

    // account health
    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(98053352n)
    );

    mint_token("mock-usdc", 1386, depositor1);
    let liquidate = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.none(),
        Cl.contractPrincipal(deployer, "mock-eth"),
        Cl.principal(borrower1),
        Cl.uint(1386),
        Cl.uint(1),
      ],
      depositor1
    );
    expect(liquidate.result).toBeOk(Cl.bool(true));

    // account health
    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(100000000n)
    );

    const liquidatorBalance = simnet.callReadOnlyFn(
      "mock-eth",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    expect(liquidatorBalance.result.value.value).toBe(256n);

    mint_token("mock-usdc", 1171, borrower1);
    let repay = simnet.callPublicFn(
      "borrower-v1",
      "repay",
      [Cl.uint(1171), Cl.none()],
      borrower1
    );
    expect(repay.result).toBeOk(Cl.bool(true));

    let response = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [Cl.none(), Cl.contractPrincipal(deployer, "mock-btc"), Cl.uint(100)],
      borrower1
    );
    expect(response.result).toBeOk(Cl.bool(true));

    response = simnet.callPublicFn(
      "borrower-v1",
      "remove-collateral",
      [Cl.none(), Cl.contractPrincipal(deployer, "mock-eth"), Cl.uint(744)],
      borrower1
    );
    expect(response.result).toBeOk(Cl.bool(true));

    const position = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(position.result.value.data["debt-shares"].value).toBe(0n);
    expect(position.result.value.data["collaterals"].list.length).toBe(0);
  });

  it("Borrower borrows and full liquidation", async () => {
    await set_price("mock-btc", 100n, deployer);
    await set_price("mock-eth", 100n, deployer);
    deposit_and_borrow(2000, depositor1, 10, 700, borrower1, deployer);

    // accrue interest
    simnet.mineEmptyBlocks(5);

    update_supported_collateral(
      "mock-eth",
      70000000,
      80000000,
      10000000,
      8,
      deployer
    );
    mint_token("mock-eth", 10, borrower1);
    add_collateral("mock-eth", 10, deployer, borrower1);

    borrow(686, borrower1);

    let totalAssetsRes = simnet.callReadOnlyFn(
      "state-v1",
      "get-lp-params",
      [],
      deployer
    );
    let totalAssets = totalAssetsRes.result.data["total-assets"].value;
    expect(totalAssets).toEqual(2001n);

    let accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(115356885n)
    );

    let collateralVal = simnet.callReadOnlyFn(
      "borrower-v1",
      "get-user-collaterals-value",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(collateralVal.result.value.value).toBe(2000n);

    let stateBalance = simnet.callReadOnlyFn(
      "mock-eth",
      "get-balance",
      [Cl.contractPrincipal(deployer, "state-v1")],
      depositor1
    );
    expect(stateBalance.result.value.value).toBe(10n);

    stateBalance = simnet.callReadOnlyFn(
      "mock-btc",
      "get-balance",
      [Cl.contractPrincipal(deployer, "state-v1")],
      depositor1
    );
    expect(stateBalance.result.value.value).toBe(10n);

    let userDebtShares = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userDebtShares.result.value.data["debt-shares"].value).toEqual(
      1386n
    );

    // reduce collateral settings
    await set_price("mock-btc", 10n, deployer);
    await set_price("mock-eth", 65n, deployer);

    totalAssetsRes = simnet.callReadOnlyFn(
      "state-v1",
      "get-lp-params",
      [],
      deployer
    );
    totalAssets = totalAssetsRes.result.data["total-assets"].value;
    expect(totalAssets).toEqual(2001n);

    collateralVal = simnet.callReadOnlyFn(
      "borrower-v1",
      "get-user-collaterals-value",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(collateralVal.result.value.value).toBe(750n);

    // account health
    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(43258832n)
    );

    mint_token("mock-usdc", 5000, depositor1);
    let depositorBalance = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    expect(depositorBalance.result.value.value).toBe(5000n);

    let liquidate = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.none(),
        Cl.contractPrincipal(deployer, "mock-eth"),
        Cl.principal(borrower1),
        Cl.uint(1000),
        Cl.uint(1),
      ],
      depositor1
    );

    totalAssetsRes = simnet.callReadOnlyFn(
      "state-v1",
      "get-lp-params",
      [],
      deployer
    );
    totalAssets = totalAssetsRes.result.data["total-assets"].value;
    expect(totalAssets).toEqual(2002n);

    depositorBalance = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    expect(depositorBalance.result.value.value).toBe(4409n);

    depositorBalance = simnet.callReadOnlyFn(
      "mock-eth",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    expect(depositorBalance.result.value.value).toBe(10n);

    userDebtShares = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userDebtShares.result.value.data["debt-shares"].value).toEqual(796n);

    liquidate = simnet.callPublicFn(
      "liquidator-v1",
      "liquidate-collateral",
      [
        Cl.none(),
        Cl.contractPrincipal(deployer, "mock-btc"),
        Cl.principal(borrower1),
        Cl.uint(1000),
        Cl.uint(1),
      ],
      depositor1
    );
    expect(liquidate.result).toBeOk(Cl.bool(true));
    let socializedDebt =
      liquidate.events[liquidate.events.length - 2].data.value.data["amount"]
        .value;

    depositorBalance = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    expect(depositorBalance.result.value.value).toBe(4318n);

    depositorBalance = simnet.callReadOnlyFn(
      "mock-btc",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    expect(depositorBalance.result.value.value).toBe(10n);

    accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(100000000n)
    );

    let liquidatorBalance = simnet.callReadOnlyFn(
      "mock-eth",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    expect(liquidatorBalance.result.value.value).toBe(10n);

    liquidatorBalance = simnet.callReadOnlyFn(
      "mock-btc",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    expect(liquidatorBalance.result.value.value).toBe(10n);

    stateBalance = simnet.callReadOnlyFn(
      "mock-eth",
      "get-balance",
      [Cl.contractPrincipal(deployer, "state-v1")],
      depositor1
    );
    expect(stateBalance.result.value.value).toBe(0n);

    liquidatorBalance = simnet.callReadOnlyFn(
      "mock-btc",
      "get-balance",
      [Cl.contractPrincipal(deployer, "state-v1")],
      depositor1
    );
    expect(liquidatorBalance.result.value.value).toBe(0n);

    userDebtShares = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userDebtShares.result.value.data["debt-shares"].value).toEqual(0n);

    totalAssetsRes = simnet.callReadOnlyFn(
      "state-v1",
      "get-lp-params",
      [],
      deployer
    );
    totalAssets = totalAssetsRes.result.data["total-assets"].value;
    // this is after socializing the remaining debt from the user
    // total assets with interest is 2002
    expect(totalAssets).toEqual(2002n - socializedDebt);
  });
});
