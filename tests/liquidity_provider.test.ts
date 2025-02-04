import { beforeEach, describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import {
  initialize_ir,
  set_allowed_contracts,
  set_asset_cap,
  deposit,
  initialize_staking_reward,
} from "./utils";
import { init_pyth, set_pyth_time_delta } from "./pyth";

const accounts = simnet.getAccounts();
const depositor1 = accounts.get("wallet_1")!;
const depositor2 = accounts.get("wallet_2")!;
const depositor3 = accounts.get("wallet_3")!;
const gifter = accounts.get("wallet_4")!;
const deployer = accounts.get("deployer")!;

describe("liquidity-provider tests", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(100000, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10000000000000n); // 100k USDC
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
  });

  it("should fail when depositing 0 assets", async () => {
    // Attempt to deposit 0 assets
    const deposit = simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(0), Cl.principal(depositor1)],
      depositor1
    );
    expect(deposit.result).toBeErr(Cl.uint(101));

    // Attempt to withdraw 0 assets
    const withdraw = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(0), Cl.principal(depositor1)],
      depositor1
    );
    expect(withdraw.result).toBeErr(Cl.uint(1));
  });

  it("should fail when depositing more than asset cap", async () => {
    simnet.callPublicFn(
      "mock-usdc",
      "mint",
      [Cl.uint(10000000000001), Cl.principal(depositor1)],
      depositor1
    );

    // Attempt to deposit max assets should succeed
    deposit(10000000000000, depositor1);

    // Attempt to another more than cap
    const depositRes = simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(1), Cl.principal(depositor1)],
      depositor1
    );
    expect(depositRes.result).toBeErr(Cl.uint(116)); // ERR-ASSET-CAP
  });

  it("should handle deposits and withdrawals correctly with zero interest accrued", async () => {
    // Mint asset tokens for depositor1
    simnet.callPublicFn(
      "mock-usdc",
      "mint",
      [Cl.uint(1000), Cl.principal(depositor1)],
      depositor1
    );

    /* Deposit flow */
    const depositResult = simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(100), Cl.principal(depositor1)],
      depositor1
    );
    expect(depositResult.result).toBeOk(Cl.bool(true));

    // Assertions for balances after deposit
    const userBalancePostDeposit = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    // User should have 98 assets after deposit
    expect(userBalancePostDeposit.result.value.value).toBe(900n);
    const userLpBalancePostDeposit = simnet.callReadOnlyFn(
      "state-v1",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    // User should have 100 LP tokens after deposit
    expect(userLpBalancePostDeposit.result.value.value).toBe(100n);

    /* Withdrawal flow */
    const withdrawalResult = simnet.callPublicFn(
      "liquidity-provider-v1",
      "withdraw",
      [Cl.uint(100), Cl.principal(depositor1)],
      depositor1
    );
    expect(withdrawalResult.result).toBeOk(Cl.bool(true));

    // Assertions for balances after withdrawal
    const userBalancePostWithdrawal = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    // User should have 99 assets after withdrawal
    expect(userBalancePostWithdrawal.result.value.value).toBe(1000n);
    const userLpBalancePostWithdrawal = simnet.callReadOnlyFn(
      "state-v1",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    // User should have 1 LP token after withdrawal
    expect(userLpBalancePostWithdrawal.result.value.value).toBe(0n);
  });

  it("should correctly handle deposits and withdrawals with multiple users", async () => {
    // Mint asset tokens for all depositors
    simnet.callPublicFn(
      "mock-usdc",
      "mint",
      [Cl.uint(50), Cl.principal(depositor1)],
      depositor1
    );
    simnet.callPublicFn(
      "mock-usdc",
      "mint",
      [Cl.uint(100), Cl.principal(depositor2)],
      depositor2
    );
    simnet.callPublicFn(
      "mock-usdc",
      "mint",
      [Cl.uint(150), Cl.principal(depositor3)],
      depositor3
    );

    // Perform multiple deposits
    simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(50), Cl.principal(depositor1)],
      depositor1
    );
    simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(100), Cl.principal(depositor2)],
      depositor2
    );
    simnet.callPublicFn(
      "liquidity-provider-v1",
      "deposit",
      [Cl.uint(150), Cl.principal(depositor3)],
      depositor3
    );

    // Gift assets
    const interestAmount = Cl.uint(100);
    simnet.callPublicFn(
      "mock-usdc",
      "mint",
      [interestAmount, Cl.principal(gifter)],
      gifter
    );
    const giftResult = simnet.callPublicFn(
      "test-gifter",
      "gift",
      [interestAmount],
      gifter
    );
    expect(giftResult.result).toBeOk(Cl.bool(true));

    // Check token balances after deposits
    let assetBalanceAfterDeposit = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    expect(assetBalanceAfterDeposit.result.value.value).toBe(0n);
    assetBalanceAfterDeposit = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor2)],
      depositor2
    );
    expect(assetBalanceAfterDeposit.result.value.value).toBe(0n);
    assetBalanceAfterDeposit = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor3)],
      depositor3
    );
    expect(assetBalanceAfterDeposit.result.value.value).toBe(0n);

    // Check LP token balances after deposit
    let lpBalanceAfterDeposit = simnet.callReadOnlyFn(
      "state-v1",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    expect(lpBalanceAfterDeposit.result.value.value).toBe(50n);
    lpBalanceAfterDeposit = simnet.callReadOnlyFn(
      "state-v1",
      "get-balance",
      [Cl.principal(depositor2)],
      depositor2
    );
    expect(lpBalanceAfterDeposit.result.value.value).toBe(100n);
    lpBalanceAfterDeposit = simnet.callReadOnlyFn(
      "state-v1",
      "get-balance",
      [Cl.principal(depositor3)],
      depositor3
    );
    expect(lpBalanceAfterDeposit.result.value.value).toBe(150n);

    let redeemResult = simnet.callPublicFn(
      "liquidity-provider-v1",
      "redeem",
      [Cl.uint(50), Cl.principal(depositor1)],
      depositor1
    );
    expect(redeemResult.result).toBeOk(Cl.bool(true));
    redeemResult = simnet.callPublicFn(
      "liquidity-provider-v1",
      "redeem",
      [Cl.uint(100), Cl.principal(depositor2)],
      depositor2
    );
    expect(redeemResult.result).toBeOk(Cl.bool(true));
    redeemResult = simnet.callPublicFn(
      "liquidity-provider-v1",
      "redeem",
      [Cl.uint(150), Cl.principal(depositor3)],
      depositor3
    );
    expect(redeemResult.result).toBeOk(Cl.bool(true));

    // Check redeeming shares brings profits to LPs
    let assetBalanceAfterWithdrawal = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor1)],
      depositor1
    );
    expect(assetBalanceAfterWithdrawal.result.value.value).toBe(66n);
    assetBalanceAfterWithdrawal = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor2)],
      depositor2
    );
    expect(assetBalanceAfterWithdrawal.result.value.value).toBe(133n);
    assetBalanceAfterWithdrawal = simnet.callReadOnlyFn(
      "mock-usdc",
      "get-balance",
      [Cl.principal(depositor3)],
      depositor3
    );
    expect(assetBalanceAfterWithdrawal.result.value.value).toBe(201n);
  });
});
