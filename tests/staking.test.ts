import { beforeEach, describe, expect, it } from "vitest";
import { Cl, ClarityValue } from "@stacks/transactions";
import {
  initialize_ir,
  set_allowed_contracts,
  set_asset_cap,
  deposit,
  mint_token,
  transfer_token,
  initialize_staking_reward,
  deposit_and_borrow,
  repay,
  update_supported_collateral,
  add_collateral,
  borrow,
} from "./utils";
import {
  init_pyth,
  set_initial_price,
  set_price,
  set_pyth_time_delta,
} from "./pyth";

const accounts = simnet.getAccounts();
const depositor1 = accounts.get("wallet_1")!;
const depositor2 = accounts.get("wallet_2")!;
const borrower1 = accounts.get("wallet_3")!;
const deployer = accounts.get("deployer")!;

const getUserLpBalance = (user: ClarityValue) => {
  const result = simnet.callReadOnlyFn(
    "state-v1",
    "get-balance",
    [user],
    deployer
  );

  return result.result.value.value;
};

const expectUserLpBalance = (user: ClarityValue, amount: bigint) => {
  expect(getUserLpBalance(user)).toBe(amount);
};

const getUserStakedLpBalance = (user: ClarityValue) => {
  const result = simnet.callReadOnlyFn(
    "staking-v1",
    "get-balance",
    [user],
    deployer
  );

  return result.result.value.value;
};

const expectUserStakedLpBalance = (user: ClarityValue, amount: bigint) => {
  expect(getUserStakedLpBalance(user)).toBe(amount);
};

const stakeLpTokens = (user: any, amount: bigint) => {
  const result = simnet.callPublicFn(
    "staking-v1",
    "stake",
    [Cl.uint(amount)],
    user
  );

  expect(result.result).toBeOk(Cl.bool(true));
};

const initiateUnstake = (user: any, amount: bigint, index: number) => {
  const result = simnet.callPublicFn(
    "staking-v1",
    "initiate-unstake",
    [Cl.uint(amount)],
    user
  );

  expect(result.result).toBeOk(Cl.uint(index));
};

const finalizeUnstake = (user: any, index: number) => {
  const result = simnet.callPublicFn(
    "staking-v1",
    "finalize-unstake",
    [Cl.uint(index)],
    user
  );

  expect(result.result).toBeOk(Cl.bool(true));
};

const getUserWithdrawal = (user: any, index: number) => {
  const result = simnet.callReadOnlyFn(
    "staking-v1",
    "get-withdrawal",
    [Cl.principal(user), Cl.uint(index)],
    deployer
  );

  return result.result.value;
};

export const increaseLpTokensOfStakingContract = (amount: number) => {
  mint_token("mock-usdc", amount, deployer);
  deposit(amount, deployer);
  expectUserLpBalance(Cl.principal(deployer), BigInt(amount));
  const stakingLpBalance = getUserLpBalance(
    Cl.contractPrincipal(deployer, "staking-v1")
  );
  // transfer lp tokens from deployer to staking contract
  transfer_token(
    "state-v1",
    amount,
    deployer,
    Cl.contractPrincipal(deployer, "staking-v1")
  );
  expectUserLpBalance(Cl.principal(deployer), 0n);
  expectUserLpBalance(
    Cl.contractPrincipal(deployer, "staking-v1"),
    stakingLpBalance + BigInt(amount)
  );
};

describe("staking tests", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(100000, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10000000000000n); // 100k USDC
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 10n, deployer);
  });

  it("should stake lp tokens", async () => {
    // Mint asset tokens for depositor1
    mint_token("mock-usdc", 1000, depositor1);

    // deposit usdc
    deposit(1000, depositor1);
    expectUserLpBalance(Cl.principal(depositor1), 1000n);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 0n);

    // stake lp tokens
    stakeLpTokens(depositor1, 1000n);
    expectUserLpBalance(Cl.principal(depositor1), 0n);
    expectUserStakedLpBalance(Cl.principal(depositor1), 1000n);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 1000n);
  });

  it("cannot stake when module is disabled", async () => {
    // Mint asset tokens for depositor1
    mint_token("mock-usdc", 1000, depositor1);

    // deposit usdc
    deposit(1000, depositor1);
    expectUserLpBalance(Cl.principal(depositor1), 1000n);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 0n);

    // disable staking
    let result = simnet.callPublicFn(
      "state-v1",
      "set-staking-flag",
      [Cl.bool(false)],
      deployer
    );
    expect(result.result).toBeOk(Cl.bool(true));

    // stake lp tokens
    result = simnet.callPublicFn(
      "staking-v1",
      "stake",
      [Cl.uint(1000n)],
      depositor1
    );
    expect(result.result).toBeErr(Cl.uint(60009));
  });

  it("should multi stake lp tokens", async () => {
    // Mint asset tokens for depositor1
    mint_token("mock-usdc", 1000, depositor1);

    // deposit usdc
    deposit(1000, depositor1);
    expectUserLpBalance(Cl.principal(depositor1), 1000n);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 0n);

    // stake lp tokens
    stakeLpTokens(depositor1, 500n);
    expectUserLpBalance(Cl.principal(depositor1), 500n);
    expectUserStakedLpBalance(Cl.principal(depositor1), 500n);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 500n);

    // stake lp tokens
    stakeLpTokens(depositor1, 500n);
    expectUserLpBalance(Cl.principal(depositor1), 0n);
    expectUserStakedLpBalance(Cl.principal(depositor1), 1000n);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 1000n);
  });

  it("should unstake lp-tokens", async () => {
    // Mint asset tokens for depositor1
    mint_token("mock-usdc", 1000, depositor1);

    // deposit usdc and stake
    deposit(1000, depositor1);
    stakeLpTokens(depositor1, 1000n);

    // initiate unstake
    let currentBlockHeight = simnet.stacksBlockHeight;
    const finalizationPeriod = currentBlockHeight + 100 + 1;
    initiateUnstake(depositor1, 1000n, 0);

    // withdrawal should exist
    const withdrawal = getUserWithdrawal(depositor1, 0);
    expect(withdrawal.data["withdrawal-shares"]).toEqual(Cl.uint(1000));
    expect(withdrawal.data["finalization-at"]).toEqual(
      Cl.uint(finalizationPeriod)
    );

    // user should have zero staked lp tokens
    expectUserStakedLpBalance(Cl.principal(depositor1), 0n);
    // user should also have zero lp token during finalization
    expectUserLpBalance(Cl.principal(depositor1), 0n);

    // cannot finalize unstake before finaization is passed
    const result = simnet.callPublicFn(
      "staking-v1",
      "finalize-unstake",
      [Cl.uint(0)],
      depositor1
    );

    expect(result.result).toBeErr(Cl.uint(60004)); // not finalized yet

    // mint empty blocks
    simnet.mineEmptyBlocks(124 - simnet.blockHeight);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 1000n);

    // finalization should be successful
    finalizeUnstake(depositor1, 0);

    expectUserLpBalance(Cl.principal(depositor1), 1000n);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 0n);
  });

  it("should not unstake lp-tokens when disabled", async () => {
    // Mint asset tokens for depositor1
    mint_token("mock-usdc", 1000, depositor1);

    // deposit usdc and stake
    deposit(1000, depositor1);
    stakeLpTokens(depositor1, 1000n);

    // disable staking
    let result = simnet.callPublicFn(
      "state-v1",
      "set-staking-flag",
      [Cl.bool(false)],
      deployer
    );
    expect(result.result).toBeOk(Cl.bool(true));

    // initiate unstake should fail
    result = simnet.callPublicFn(
      "staking-v1",
      "initiate-unstake",
      [Cl.uint(1000)],
      depositor1
    );

    expect(result.result).toBeErr(Cl.uint(60009));
  });

  it("should not finalize lp-tokens when disabled", async () => {
    // Mint asset tokens for depositor1
    mint_token("mock-usdc", 1000, depositor1);

    // deposit usdc and stake
    deposit(1000, depositor1);
    stakeLpTokens(depositor1, 1000n);

    // initiate unstake
    let currentBlockHeight = simnet.stacksBlockHeight;
    const finalizationPeriod = currentBlockHeight + 100 + 1;
    initiateUnstake(depositor1, 1000n, 0);

    // withdrawal should exist
    const withdrawal = getUserWithdrawal(depositor1, 0);
    expect(withdrawal.data["withdrawal-shares"]).toEqual(Cl.uint(1000));
    expect(withdrawal.data["finalization-at"]).toEqual(
      Cl.uint(finalizationPeriod)
    );

    // user should have zero staked lp tokens
    expectUserStakedLpBalance(Cl.principal(depositor1), 0n);
    // user should also have zero lp token during finalization
    expectUserLpBalance(Cl.principal(depositor1), 0n);

    // mint empty blocks
    simnet.mineEmptyBlocks(115 - simnet.blockHeight);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 1000n);

    let result = simnet.callPublicFn(
      "state-v1",
      "set-staking-flag",
      [Cl.bool(false)],
      deployer
    );
    expect(result.result).toBeOk(Cl.bool(true));

    // finalization should be successful
    result = simnet.callPublicFn(
      "staking-v1",
      "finalize-unstake",
      [Cl.uint(0)],
      depositor1
    );

    expect(result.result).toBeErr(Cl.uint(60009));
  });

  it("should unstake in multiple withdrawals", async () => {
    // Mint asset tokens for depositor1
    mint_token("mock-usdc", 1000, depositor1);

    // deposit usdc and stake
    deposit(1000, depositor1);
    stakeLpTokens(depositor1, 1000n);

    // initiate unstake 1 at index 0
    let currentBlockHeight = simnet.stacksBlockHeight;
    let finalizationPeriod = currentBlockHeight + 100 + 1;
    initiateUnstake(depositor1, 500n, 0);

    // withdrawal should exist
    let withdrawal = getUserWithdrawal(depositor1, 0);
    expect(withdrawal.data["withdrawal-shares"]).toEqual(Cl.uint(500));
    expect(withdrawal.data["finalization-at"]).toEqual(
      Cl.uint(finalizationPeriod)
    );

    // mint empty blocks to unlock withdrawal 1
    simnet.mineEmptyBlocks(124 - simnet.blockHeight);

    expectUserLpBalance(Cl.principal(depositor1), 0n);
    expectUserStakedLpBalance(Cl.principal(depositor1), 500n);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 1000n);

    // finalization of withdrawal at index 0 should be successful
    finalizeUnstake(depositor1, 0);

    expectUserLpBalance(Cl.principal(depositor1), 500n);
    expectUserStakedLpBalance(Cl.principal(depositor1), 500n);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 500n);

    // initiate unstake 2 at index 1
    currentBlockHeight = simnet.stacksBlockHeight;
    finalizationPeriod = currentBlockHeight + 100 + 1;
    initiateUnstake(depositor1, 500n, 1);

    // withdrawal should exist
    withdrawal = getUserWithdrawal(depositor1, 1);
    expect(withdrawal.data["withdrawal-shares"]).toEqual(Cl.uint(500));
    expect(withdrawal.data["finalization-at"]).toEqual(
      Cl.uint(finalizationPeriod)
    );

    // mint empty blocks to unlock withdrawal at index 2
    simnet.mineEmptyBlocks(226 - simnet.blockHeight);

    finalizeUnstake(depositor1, 1);

    expectUserLpBalance(Cl.principal(depositor1), 1000n);
    expectUserStakedLpBalance(Cl.principal(depositor1), 0n);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 0n);
  });

  it("should staked lp token price increases due to accrued lp tokens", async () => {
    // Mint asset tokens for depositor1
    mint_token("mock-usdc", 1000, depositor1);

    // deposit usdc
    deposit(1000, depositor1);
    expectUserLpBalance(Cl.principal(depositor1), 1000n);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 0n);

    // stake lp tokens
    stakeLpTokens(depositor1, 1000n);
    expectUserLpBalance(Cl.principal(depositor1), 0n);
    expectUserStakedLpBalance(Cl.principal(depositor1), 1000n);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 1000n);

    // mint lp tokens to staking contract to increase the share price
    increaseLpTokensOfStakingContract(1000);

    let currentStakedLp = simnet.callReadOnlyFn(
      "staking-v1",
      "get-active-staked-lp-tokens",
      [],
      deployer
    );
    expect(currentStakedLp.result).toEqual(Cl.uint(1000));
    // reconcile staked token balance
    const res = simnet.callPublicFn(
      "staking-v1",
      "reconcile-lp-token-balance",
      [],
      deployer
    );
    expect(res.result).toBeOk(Cl.bool(true));

    currentStakedLp = simnet.callReadOnlyFn(
      "staking-v1",
      "get-active-staked-lp-tokens",
      [],
      deployer
    );
    expect(currentStakedLp.result).toEqual(Cl.uint(2000));

    // Mint asset tokens for depositor2
    mint_token("mock-usdc", 1000, depositor2);

    // deposit usdc
    deposit(1000, depositor2);

    // stake 1000 lp tokens.
    // in return depositor2 should get only 500 staked lp tokens because the
    // the staked-lp-tokens price is up due to another 1000 lp tokens being rewarded to stake contract
    stakeLpTokens(depositor2, 1000n);
    expectUserLpBalance(Cl.principal(depositor2), 0n);
    expectUserStakedLpBalance(Cl.principal(depositor2), 500n);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 3000n);

    // initiate unstake of depositor 2 at index 0
    let currentBlockHeight = simnet.stacksBlockHeight;
    let finalizationPeriod = currentBlockHeight + 100 + 1;
    initiateUnstake(depositor2, 500n, 0);

    // withdrawal should exist
    let withdrawal = getUserWithdrawal(depositor2, 0);
    expect(withdrawal.data["withdrawal-shares"]).toEqual(Cl.uint(1000));
    expect(withdrawal.data["finalization-at"]).toEqual(
      Cl.uint(finalizationPeriod)
    );

    // mint empty blocks to unlock withdrawal at index 2
    simnet.mineEmptyBlocks(131 - simnet.blockHeight);

    finalizeUnstake(depositor2, 0);

    expectUserLpBalance(Cl.principal(depositor2), 1000n);
    expectUserStakedLpBalance(Cl.principal(depositor2), 0n);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 2000n);

    // initiate unstake of depositor 1 at index 0
    currentBlockHeight = simnet.stacksBlockHeight;
    finalizationPeriod = currentBlockHeight + 100 + 1;
    initiateUnstake(depositor1, 1000n, 0);

    // withdrawal should exist
    withdrawal = getUserWithdrawal(depositor1, 0);
    expect(withdrawal.data["withdrawal-shares"]).toEqual(Cl.uint(2000));
    expect(withdrawal.data["finalization-at"]).toEqual(
      Cl.uint(finalizationPeriod)
    );

    // mint empty blocks to unlock withdrawal at index 2
    simnet.mineEmptyBlocks(233 - simnet.blockHeight);

    finalizeUnstake(depositor1, 0);

    // depositor1 got full 2000 lp tokens for their 1000 staked lp-tokens
    expectUserLpBalance(Cl.principal(depositor1), 2000n);
    expectUserStakedLpBalance(Cl.principal(depositor1), 0n);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 0n);
  });

  it("should staked lp token price increases due to accrued lp tokens", async () => {
    // deposit and borrow
    let one8 = 100000000;
    deposit_and_borrow(
      10000 * one8,
      depositor1,
      1000 * one8,
      7000 * one8,
      borrower1,
      deployer
    );
    expectUserLpBalance(Cl.principal(depositor1), 1000000000000n);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 0n);

    // stake lp tokens
    stakeLpTokens(depositor1, 500000000000n);
    expectUserLpBalance(Cl.principal(depositor1), 500000000000n);
    expectUserStakedLpBalance(Cl.principal(depositor1), 500000000000n);
    expectUserLpBalance(
      Cl.contractPrincipal(deployer, "staking-v1"),
      500000000000n
    );

    // full repay after 100 blocks
    simnet.mineEmptyBlocks(100);

    // staking reward percentage
    let stakingRewardPerncentage = simnet.callReadOnlyFn(
      "staking-reward-v1",
      "calculate-staking-reward-percentage",
      [Cl.uint(500000000000)],
      deployer
    );
    expect(stakingRewardPerncentage.result).toBeOk(Cl.uint(5000000));

    // repay
    mint_token("mock-usdc", 3000 * one8, borrower1);
    repay(10000 * one8, borrower1);

    // user should have zero debt shares
    let userDebtShares = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userDebtShares.result.value.data["debt-shares"].value).toEqual(0n);

    // stake contracts lp balance should have increased
    expectUserLpBalance(
      Cl.contractPrincipal(deployer, "staking-v1"),
      500054709510n
    );

    // initiate unstake of depositor 1 at index 0
    let currentBlockHeight = simnet.stacksBlockHeight;
    let finalizationPeriod = currentBlockHeight + 100 + 1;
    initiateUnstake(depositor1, 500000000000n, 0);

    // withdrawal should exist
    const withdrawal = getUserWithdrawal(depositor1, 0);
    expect(withdrawal.data["withdrawal-shares"]).toEqual(Cl.uint(500054709510));
    expect(withdrawal.data["finalization-at"]).toEqual(
      Cl.uint(finalizationPeriod)
    );

    // mint empty blocks to unlock withdrawal at index 2
    simnet.mineEmptyBlocks(10130 - simnet.blockHeight);

    finalizeUnstake(depositor1, 0);

    // depositor1 got full lp tokens of staking contract
    expectUserLpBalance(Cl.principal(depositor1), 1000054709510n);
    expectUserStakedLpBalance(Cl.principal(depositor1), 0n);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "staking-v1"), 0n);
  });

  it("Full liquidation and reserve gets used", async () => {
    await set_initial_price("mock-eth", 1n, deployer);
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

    let collateralVal = simnet.callReadOnlyFn(
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
    expect(liquidate.result).toBeOk(Cl.bool(true));

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

    mint_token("mock-usdc", 10000, deployer);
    const depositToReserve = simnet.callPublicFn(
      "state-v1",
      "deposit-to-reserve",
      [Cl.uint(10000)],
      deployer
    );
    expect(depositToReserve.result).toBeOk(Cl.bool(true));

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
    let socializedDebt = liquidate.events[5].data.value.data["amount"].value;

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

    let stateBalance = simnet.callReadOnlyFn(
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

    const reseverBalance = simnet.callReadOnlyFn(
      "state-v1",
      "get-reserve-balance",
      [],
      deployer
    );

    // this is after socializing the remaining debt from the user
    // reserve balance is reduced with 1 as rounding for conversion
    expect(reseverBalance.result.value).toEqual(10000n - socializedDebt - 1n);

    totalAssetsRes = simnet.callReadOnlyFn(
      "state-v1",
      "get-lp-params",
      [],
      deployer
    );
    totalAssets = totalAssetsRes.result.data["total-assets"].value;
    // this is after socializing the remaining debt from the user
    // total assets with interest is 2003
    expect(totalAssets).toEqual(2003n);
  });

  it("Full liquidation and staked lps gets slashed", async () => {
    await set_initial_price("mock-eth", 1n, deployer);
    await set_price("mock-btc", 100n, deployer);
    await set_price("mock-eth", 100n, deployer);
    deposit_and_borrow(2000, depositor1, 10, 700, borrower1, deployer);

    stakeLpTokens(depositor1, 1000n);

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
    expect(totalAssets).toEqual(2002n);

    let accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(115273775n)
    );

    let userDebtShares = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userDebtShares.result.value.data["debt-shares"].value).toEqual(
      1385n
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
    expect(totalAssets).toEqual(2002n);

    let collateralVal = simnet.callReadOnlyFn(
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
      Cl.uint(43227665n)
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
    expect(liquidate.result).toBeOk(Cl.bool(true));

    totalAssetsRes = simnet.callReadOnlyFn(
      "state-v1",
      "get-lp-params",
      [],
      deployer
    );
    totalAssets = totalAssetsRes.result.data["total-assets"].value;
    expect(totalAssets).toEqual(2003n);

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

    mint_token("mock-usdc", 100, deployer);
    const depositToReserve = simnet.callPublicFn(
      "state-v1",
      "deposit-to-reserve",
      [Cl.uint(100)],
      deployer
    );
    expect(depositToReserve.result).toBeOk(Cl.bool(true));

    let stakedTokens = getUserLpBalance(
      Cl.contractPrincipal(deployer, "staking-v1")
    );
    expect(stakedTokens).toBe(1000n);

    let totalLpSupply = simnet.callReadOnlyFn(
      "state-v1",
      "get-total-supply",
      [],
      deployer
    );
    expect(totalLpSupply.result).toBeOk(Cl.uint(2000));

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
    let socializedDebt = liquidate.events[6].data.value.data["amount"].value;

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

    let stateBalance = simnet.callReadOnlyFn(
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

    const reseverBalance = simnet.callReadOnlyFn(
      "state-v1",
      "get-reserve-balance",
      [],
      deployer
    );

    // reserve balance should not be touched since staked lp slash is enough
    expect(reseverBalance.result.value).toEqual(100n);

    // staked lp tokens should be reduced due to slashing
    stakedTokens = getUserLpBalance(
      Cl.contractPrincipal(deployer, "staking-v1")
    );
    expect(stakedTokens).toBe(293n);

    totalAssetsRes = simnet.callReadOnlyFn(
      "state-v1",
      "get-lp-params",
      [],
      deployer
    );
    totalAssets = totalAssetsRes.result.data["total-assets"].value;
    // this is after socializing the remaining debt from the user
    // total assets with interest is 2003 and staked lp tokens are slashed
    expect(totalAssets).toEqual(2004n - socializedDebt - 1n);

    totalLpSupply = simnet.callReadOnlyFn(
      "state-v1",
      "get-total-supply",
      [],
      deployer
    );
    expect(totalLpSupply.result).toBeOk(Cl.uint(2001 - Number(socializedDebt)));
  });

  it("Full liquidation and reserve spill over to staked lps with withdrawal queue", async () => {
    await set_initial_price("mock-eth", 1n, deployer);
    await set_price("mock-btc", 100n, deployer);
    await set_price("mock-eth", 100n, deployer);
    deposit_and_borrow(2000, depositor1, 10, 700, borrower1, deployer);

    stakeLpTokens(depositor1, 1000n);

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
    expect(totalAssets).toEqual(2002n);

    let accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(115273775n)
    );

    let userDebtShares = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userDebtShares.result.value.data["debt-shares"].value).toEqual(
      1385n
    );

    // initiate unstake of depositor 1 at index 0
    let currentBlockHeight = simnet.stacksBlockHeight;
    let finalizationPeriod = currentBlockHeight + 100 + 1;
    initiateUnstake(depositor1, 500n, 0);

    // withdrawal should exist
    const withdrawal = getUserWithdrawal(depositor1, 0);
    expect(withdrawal.data["withdrawal-shares"]).toEqual(Cl.uint(500));
    expect(withdrawal.data["finalization-at"]).toEqual(
      Cl.uint(finalizationPeriod)
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
    expect(totalAssets).toEqual(2003n);

    let collateralVal = simnet.callReadOnlyFn(
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
      Cl.uint(43196544n)
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
    expect(liquidate.result).toBeOk(Cl.bool(true));

    totalAssetsRes = simnet.callReadOnlyFn(
      "state-v1",
      "get-lp-params",
      [],
      deployer
    );
    totalAssets = totalAssetsRes.result.data["total-assets"].value;
    expect(totalAssets).toEqual(2004n);

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
    expect(userDebtShares.result.value.data["debt-shares"].value).toEqual(797n);

    mint_token("mock-usdc", 100, deployer);
    const depositToReserve = simnet.callPublicFn(
      "state-v1",
      "deposit-to-reserve",
      [Cl.uint(100)],
      deployer
    );
    expect(depositToReserve.result).toBeOk(Cl.bool(true));

    let stakedTokens = getUserLpBalance(
      Cl.contractPrincipal(deployer, "staking-v1")
    );
    expect(stakedTokens).toBe(1000n);

    let totalLpSupply = simnet.callReadOnlyFn(
      "state-v1",
      "get-total-supply",
      [],
      deployer
    );
    expect(totalLpSupply.result).toBeOk(Cl.uint(2000));

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
    let socializedDebt = liquidate.events[6].data.value.data["amount"].value;
    let burnedStakedLPTokens =
      liquidate.events[6].data.value.data["burned-staking-lp-tokens"].value;
    // since staked lp are equally divided between active and withdrawal
    // Withdrawal should yield half of the remaining
    let expectedWithdrawalTokens = (1000n - burnedStakedLPTokens) / 2n;

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

    let stateBalance = simnet.callReadOnlyFn(
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

    const reseverBalance = simnet.callReadOnlyFn(
      "state-v1",
      "get-reserve-balance",
      [],
      deployer
    );

    // reserve balance is not touched
    expect(reseverBalance.result.value).toEqual(100n);

    totalAssetsRes = simnet.callReadOnlyFn(
      "state-v1",
      "get-lp-params",
      [],
      deployer
    );
    totalAssets = totalAssetsRes.result.data["total-assets"].value;
    // this is after socializing the remaining debt from the user
    // total assets with interest is 2003 and reserve is completely wiped out
    // staked lp tokens are slashed
    expect(totalAssets).toEqual(2005n - socializedDebt - 1n);

    // staked lp tokens must be slashed
    stakedTokens = getUserLpBalance(
      Cl.contractPrincipal(deployer, "staking-v1")
    );
    expect(stakedTokens).toBe(1001n - socializedDebt);

    totalLpSupply = simnet.callReadOnlyFn(
      "state-v1",
      "get-total-supply",
      [],
      deployer
    );
    expect(totalLpSupply.result).toBeOk(Cl.uint(2001 - Number(socializedDebt)));

    // mint empty blocks to unlock withdrawal at index 2
    simnet.mineEmptyBlocks(141 - simnet.blockHeight);

    finalizeUnstake(depositor1, 0);

    // depositor1 got full lp tokens of staking contract
    // depositor should have 1000 lp tokens unstaked and 1000 staked
    // of the 1000 staked, 500 are in withdrawal queue
    // due to slashing, user should recieve around 195 lp-tokens instead of 500
    expectUserLpBalance(
      Cl.principal(depositor1),
      1000n + expectedWithdrawalTokens
    );
    expectUserStakedLpBalance(Cl.principal(depositor1), 500n);
    // staking contract should have the remaining equal amount of lp-tokens
    expectUserLpBalance(
      Cl.contractPrincipal(deployer, "staking-v1"),
      expectedWithdrawalTokens
    );
  });

  it("Full liquidation and reserve and staked lp is wiped and spill over to unstaked lp", async () => {
    await set_initial_price("mock-eth", 1n, deployer);
    await set_price("mock-btc", 100n, deployer);
    await set_price("mock-eth", 100n, deployer);
    deposit_and_borrow(2000, depositor1, 10, 700, borrower1, deployer);

    stakeLpTokens(depositor1, 500n);

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
    expect(totalAssets).toEqual(2002n);

    let accounthealthRes = simnet.callReadOnlyFn(
      "liquidator-v1",
      "account-health",
      [Cl.principal(borrower1), Cl.none(), Cl.none()],
      deployer
    );
    expect(accounthealthRes.result.value.data["position-health"]).toEqual(
      Cl.uint(115273775n)
    );

    let userDebtShares = simnet.callReadOnlyFn(
      "state-v1",
      "get-user-position",
      [Cl.principal(borrower1)],
      borrower1
    );
    expect(userDebtShares.result.value.data["debt-shares"].value).toEqual(
      1385n
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
    expect(totalAssets).toEqual(2002n);

    let collateralVal = simnet.callReadOnlyFn(
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
      Cl.uint(43227665n)
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
    expect(liquidate.result).toBeOk(Cl.bool(true));

    totalAssetsRes = simnet.callReadOnlyFn(
      "state-v1",
      "get-lp-params",
      [],
      deployer
    );
    totalAssets = totalAssetsRes.result.data["total-assets"].value;
    expect(totalAssets).toEqual(2003n);

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

    mint_token("mock-usdc", 100, deployer);
    const depositToReserve = simnet.callPublicFn(
      "state-v1",
      "deposit-to-reserve",
      [Cl.uint(100)],
      deployer
    );
    expect(depositToReserve.result).toBeOk(Cl.bool(true));

    let stakedTokens = getUserLpBalance(
      Cl.contractPrincipal(deployer, "staking-v1")
    );
    expect(stakedTokens).toBe(500n);

    let totalLpSupply = simnet.callReadOnlyFn(
      "state-v1",
      "get-total-supply",
      [],
      deployer
    );
    expect(totalLpSupply.result).toBeOk(Cl.uint(2000));

    let stakingStatus = simnet.callReadOnlyFn(
      "state-v1",
      "is-staking-enabled",
      [],
      deployer
    );
    expect(stakingStatus.result).toStrictEqual(Cl.bool(true));

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
    let socializedDebt = liquidate.events[7].data.value.data["amount"].value;

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

    let stateBalance = simnet.callReadOnlyFn(
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

    const reseverBalance = simnet.callReadOnlyFn(
      "state-v1",
      "get-reserve-balance",
      [],
      deployer
    );

    // this is after socializing the remaining debt from the user
    // reserve balance is reduced
    expect(reseverBalance.result.value).toEqual(0n);

    totalAssetsRes = simnet.callReadOnlyFn(
      "state-v1",
      "get-lp-params",
      [],
      deployer
    );
    totalAssets = totalAssetsRes.result.data["total-assets"].value;
    // this is after socializing the remaining debt from the user
    // total assets with interest is 2003 and reserve is completely wiped out
    // staked lp tokens are slashed
    expect(totalAssets).toEqual(2003n - socializedDebt + 100n);

    // staked lp tokens must be slashed
    stakedTokens = getUserLpBalance(
      Cl.contractPrincipal(deployer, "staking-v1")
    );
    expect(stakedTokens).toBe(0n);

    stakingStatus = simnet.callReadOnlyFn(
      "state-v1",
      "is-staking-enabled",
      [],
      deployer
    );
    expect(stakingStatus.result).toStrictEqual(Cl.bool(false));

    totalLpSupply = simnet.callReadOnlyFn(
      "state-v1",
      "get-total-supply",
      [],
      deployer
    );
    expect(totalLpSupply.result).toBeOk(Cl.uint(2000 - 500));
  });
});
